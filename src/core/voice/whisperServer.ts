import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { logger } from '../../logger.js';
import {
  claudeVoicePaths, voiceStateDir, whisperModelPath, whisperRuntimeOptions, whisperRuntimeSources,
  WHISPER_URL, WHISPER_ZIP, type VoiceSettings,
} from './claudeVoiceConfig.js';
import { describe as describeRuntime, formatBytes, freeBytes, runtimeDir, runtimeInfo, runtimeSetupRunning, setupRuntime, type SetupResult } from './whisperRuntime.js';

/**
 * whisper-server (whisper.cpp b5454, the build Claude Voice uses) as a sidecar for the "Claude Voice
 * (local Whisper)" speech engine. One instance is shared by every window:
 *  - started lazily on the first transcription, bound to 127.0.0.1 on a free port;
 *  - stopped after `idleMinutes` without a request, which frees the model's VRAM;
 *  - when the GPU load fails (e.g. Claude Voice already holds the VRAM) it says so and retries once
 *    on CPU (-ng); a server that crashes mid-request on the GPU is restarted on CPU the same way;
 *  - restarted on the next request when the model or the start flags changed.
 * The binaries live in one runtime folder shared by every data dir (whisperRuntime.ts): the server
 * exe from Claude Voice's release zip, its DLLs hard-linked to Claude Voice's install (no extra disk),
 * or extracted from the zip on request when they cannot be linked (Settings -> Voice).
 */

type State = 'stopped' | 'starting' | 'running' | 'error';
export interface PrepareOptions { download?: boolean; cpuOnly?: boolean; allowExtract?: boolean; force?: boolean }
export interface TranscribeResult { text: string; lang: string; ms: number; device: string }

const LANG_CODES: Record<string, string> = {
  english: 'en', romanian: 'ro', french: 'fr', german: 'de', spanish: 'es', italian: 'it', portuguese: 'pt',
  dutch: 'nl', polish: 'pl', ukrainian: 'uk', russian: 'ru', japanese: 'ja', chinese: 'zh', hindi: 'hi',
};

const instances = new Set<WhisperServer>();
/** Stop every whisper-server this process started (shutdown path). */
export function stopWhisperServers(): void { for (const w of instances) w.stop('shutdown'); }
process.on('exit', () => { for (const w of instances) w.stop('exit'); });

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export class WhisperServer {
  private child: ChildProcess | null = null;
  private port = 0;
  private state: State = 'stopped';
  private device: 'gpu' | 'cpu' | '' = '';
  private model = '';
  private sig = '';
  private lastUsed = 0;
  private lastError = '';
  private note = '';
  private stderrTail: string[] = [];
  private starting: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  /** Start signature whose GPU load failed: stay on CPU for it until the settings change. */
  private gpuFailedSig = '';
  private preparing: Promise<SetupResult> | null = null;
  private prepareMsg = '';
  private prepareNeedsSpace = false;
  private cpuOnlyBytes = 0;
  /** Transcriptions in progress (the idle stop waits for them). */
  private busy = 0;
  private readonly idleTimer: NodeJS.Timeout;

  constructor(private readonly settings: () => VoiceSettings) {
    instances.add(this);
    this.idleTimer = setInterval(() => this.checkIdle(), 30_000);
    this.idleTimer.unref();
  }

  status() {
    const s = this.settings();
    const p = claudeVoicePaths();
    let zipFound = false;
    try { zipFound = fs.statSync(p.whisperZip).isFile(); } catch { /* missing */ }
    const rt = runtimeInfo();
    let modelFound = false;
    try { modelFound = fs.existsSync(whisperModelPath(s.model)); } catch { /* invalid name */ }
    return {
      state: this.state,
      model: this.model || s.model,
      device: this.device,
      port: this.port || null,
      pid: this.child?.pid ?? null,
      idleMinutes: s.idleMinutes,
      lastUsed: this.lastUsed || null,
      lastError: this.lastError || null,
      note: this.note || null,
      binReady: rt.ready,
      runtime: {
        dir: rt.dir, ready: rt.ready, mode: rt.mode, cpuOnly: rt.cpuOnly, files: rt.files,
        ownBytes: rt.ownBytes, sharedBytes: rt.sharedBytes, orphanedBytes: rt.orphanedBytes, freeBytes: rt.freeBytes,
        problem: rt.problem, summary: describeRuntime(rt),
      },
      zipFound,
      zipPath: p.whisperZip,
      claudeVoiceDist: p.distDir,
      downloadUrl: WHISPER_URL,
      preparing: !!this.preparing || runtimeSetupRunning(),
      prepareMessage: this.prepareMsg || null,
      prepareNeedsSpace: this.prepareNeedsSpace,
      cpuOnlyBytes: this.cpuOnlyBytes || null,
      modelFound,
      vadFound: fs.existsSync(p.vadModel),
    };
  }

  /** Set up the shared runtime: link Claude Voice's whisper.cpp files (no extra disk), or with
   *  allowExtract take them from the release zip; download fetches that release first. */
  prepare(opts: PrepareOptions = {}): Promise<SetupResult> {
    const rt = runtimeInfo();
    if (!opts.force && rt.ready && !(opts.cpuOnly === false && rt.cpuOnly)) return Promise.resolve({ ok: true, message: describeRuntime(rt), mode: rt.mode });
    if (this.preparing) return this.preparing;
    if (this.child && (opts.force || rt.ready)) return Promise.resolve({ ok: false, message: 'whisper-server is running from the runtime; set up again once it has stopped (idle unload or restart)' });
    this.preparing = this.doPrepare(opts).then((r) => {
      this.prepareMsg = r.message;
      this.prepareNeedsSpace = !!r.needsSpace;
      this.cpuOnlyBytes = r.cpuOnlyBytes ?? 0;
      if (r.ok) logger.info({ dir: runtimeDir(), mode: r.mode }, `voice: whisper runtime ready: ${r.message}`);
      return r;
    }, (err): SetupResult => {
      this.prepareMsg = String((err as Error).message || err);
      return { ok: false, message: this.prepareMsg };
    }).finally(() => { this.preparing = null; });
    return this.preparing;
  }

  private async doPrepare(opts: PrepareOptions): Promise<SetupResult> {
    const src = whisperRuntimeSources();
    let zip = '';
    try { if (fs.statSync(src.zip).isFile()) zip = src.zip; } catch { /* missing */ }
    const dlZip = path.join(runtimeDir(), 'downloads', WHISPER_ZIP);
    let allowExtract = !!opts.allowExtract;
    if (!zip && fs.existsSync(dlZip)) zip = dlZip;
    if (!zip) {
      if (!opts.download) return { ok: false, message: `${WHISPER_ZIP} not found in ${path.dirname(src.zip)}; use Download to fetch the official release (about 685 MB)` };
      // The download (~685 MB) plus the extraction (~1.2 GB with CUDA) must leave room on the drive.
      const free = freeBytes(runtimeDir());
      const need = (700 + (opts.cpuOnly ? 20 : 1300)) * 1024 ** 2 + 2 * 1024 ** 3;
      if (free !== null && free < need) return { ok: false, needsSpace: true, message: `not enough disk space to download whisper.cpp: ${formatBytes(free)} free, about ${formatBytes(need)} needed` };
      const part = dlZip + '.part';
      try {
        this.prepareMsg = `downloading ${WHISPER_URL}`;
        fs.mkdirSync(path.dirname(dlZip), { recursive: true });
        const res = await fetch(WHISPER_URL, { redirect: 'follow' });
        if (!res.ok || !res.body) return { ok: false, message: `download failed: HTTP ${res.status}` };
        await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(part));
        fs.renameSync(part, dlZip);
        zip = dlZip;
      } catch (err) {
        try { fs.rmSync(part, { force: true }); } catch { /* best effort */ }
        return { ok: false, message: `download failed: ${String(err)}` };
      }
      allowExtract = true;
    }
    this.prepareMsg = `setting up ${runtimeDir()}`;
    return setupRuntime({ ...src, zip }, { cpuOnly: opts.cpuOnly, allowExtract, force: opts.force });
  }

  private startSig(s: VoiceSettings): string {
    const o = whisperRuntimeOptions(s);
    return JSON.stringify([s.model, s.device, o.beamSize, o.prompt, o.noSpeechThreshold]);
  }

  private checkIdle(): void {
    if (this.state !== 'running' || !this.child) return;
    const idleMs = this.settings().idleMinutes * 60_000;
    if (this.busy === 0 && Date.now() - this.lastUsed > idleMs) {
      logger.info({ idleMinutes: this.settings().idleMinutes }, 'voice: whisper-server idle, stopping to free memory');
      this.note = `unloaded after ${this.settings().idleMinutes} idle minutes`;
      this.stop('idle');
    }
  }

  stop(reason = 'stop'): void {
    const c = this.child;
    this.child = null;
    if (c && c.exitCode === null) { try { c.kill(); } catch { /* gone */ } }
    if (c) { try { fs.rmSync(this.pidFile(), { force: true }); } catch { /* best effort */ } }
    if (this.state !== 'error') this.state = 'stopped';
    if (reason !== 'restart') logger.debug({ reason }, 'voice: whisper-server stopped');
    this.port = 0;
    this.device = '';
  }

  /** {pid, port} of the running server, so one left behind by a crashed Zamolxis (it would keep
   *  holding the model's VRAM) is stopped before the next start. */
  private pidFile(): string { return path.join(voiceStateDir(), 'whisper-server.pid'); }
  private async killStale(): Promise<void> {
    let rec: { pid?: number; port?: number };
    try { rec = JSON.parse(fs.readFileSync(this.pidFile(), 'utf8')); } catch { return; }
    try { fs.rmSync(this.pidFile(), { force: true }); } catch { /* best effort */ }
    if (!rec.pid || !rec.port || rec.pid === this.child?.pid) return;
    try { process.kill(rec.pid, 0); } catch { return; } // not running
    try {
      // Only when that pid still serves whisper on its port (a recycled pid would not).
      const r = await fetch(`http://127.0.0.1:${rec.port}/`, { signal: AbortSignal.timeout(1500) });
      const body = await r.text();
      if (!/whisper\.cpp/i.test(r.headers.get('server') || '') && !/Whisper\.cpp Server/i.test(body)) return;
      process.kill(rec.pid);
      logger.warn({ pid: rec.pid }, 'voice: stopped a whisper-server left over from an earlier run');
    } catch { /* not ours */ }
  }

  /** Start (or restart after a settings change) and wait until it answers HTTP. */
  private async ensure(): Promise<void> {
    const s = this.settings();
    const sig = this.startSig(s);
    if (this.child && this.state === 'running' && this.sig === sig) return;
    if (this.starting) { await this.starting; if (this.sig === sig && this.state === 'running') return; }
    if (this.child) this.stop('restart');
    this.starting = (async () => {
      if (!runtimeInfo().ready) {
        // On first use only hard links are made (no disk space); extracting from the zip is an
        // explicit choice in Settings -> Voice. A CPU-only runtime stays CPU-only.
        const r = await this.prepare({ cpuOnly: runtimeInfo().cpuOnly || undefined });
        if (!r.ok) throw new Error(r.message);
      }
      await this.killStale();
      const model = whisperModelPath(s.model);
      if (!fs.existsSync(model)) throw new Error(`whisper model not found: ${model}`);
      const wantGpu = s.device !== 'cpu' && this.gpuFailedSig !== sig && !runtimeInfo().cpuOnly;
      try {
        await this.launch(s, sig, !wantGpu);
      } catch (err) {
        if (!wantGpu) throw err;
        const why = String((err as Error).message || err);
        logger.warn({ err: why }, 'voice: whisper-server failed to load on the GPU, retrying on CPU');
        this.gpuFailedSig = sig;
        this.note = `GPU load failed (${why.slice(0, 200)}); running on CPU`;
        await this.launch(s, sig, true);
      }
    })();
    try {
      await this.starting;
    } catch (err) {
      this.state = 'error';
      this.lastError = String((err as Error).message || err);
      throw err;
    } finally {
      this.starting = null;
    }
  }

  private async launch(s: VoiceSettings, sig: string, cpu: boolean): Promise<void> {
    const exe = runtimeInfo().exe;
    if (!exe) throw new Error('whisper-server runtime is not set up');
    const o = whisperRuntimeOptions(s);
    const p = claudeVoicePaths();
    const port = await freePort();
    const threads = Math.max(2, Math.min(8, os.cpus().length - 2));
    const args = ['-m', whisperModelPath(s.model), '--host', '127.0.0.1', '--port', String(port), '-t', String(threads),
      '-l', 'auto', '-bs', String(o.beamSize), '-nth', String(o.noSpeechThreshold)];
    if (o.prompt) args.push('--prompt', o.prompt);
    // Silero VAD with faster-whisper's vad_filter defaults, as Claude Voice runs it.
    if (fs.existsSync(p.vadModel)) args.push('--vad', '-vm', p.vadModel, '-vt', '0.5', '-vspd', '0', '-vsd', '2000', '-vp', '400');
    if (cpu) args.push('-ng');
    this.state = 'starting';
    this.lastError = '';
    this.stderrTail = [];
    this.model = s.model;
    let sawCuda = false;
    logger.info({ model: s.model, port, cpu }, 'voice: starting whisper-server');
    const child = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    const onLine = (d: Buffer) => {
      for (const line of String(d).split(/\r?\n/)) {
        if (!line.trim()) continue;
        if (/using CUDA\d* backend|CUDA0/i.test(line)) sawCuda = true;
        this.stderrTail.push(line);
        if (this.stderrTail.length > 40) this.stderrTail.shift();
      }
    };
    child.stdout?.on('data', onLine);
    child.stderr?.on('data', onLine);
    let exited = false;
    child.on('exit', (code) => {
      exited = true;
      if (this.child === child) {
        this.child = null;
        if (this.state === 'running') { this.state = 'stopped'; this.note = `whisper-server exited (${code})`; }
        this.port = 0;
      }
    });
    child.on('error', (e) => { exited = true; this.stderrTail.push(String(e)); });

    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      if (exited) throw new Error(this.failReason());
      try {
        const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
        await r.arrayBuffer().catch(() => undefined);
        break;
      } catch { /* not listening yet */ }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (exited) throw new Error(this.failReason());
    if (Date.now() >= deadline) {
      try { child.kill(); } catch { /* gone */ }
      if (this.child === child) this.child = null;
      throw new Error('whisper-server did not start within 4 minutes');
    }
    this.port = port;
    this.sig = sig;
    this.device = cpu || !sawCuda ? 'cpu' : 'gpu';
    this.state = 'running';
    this.lastUsed = Date.now();
    try { fs.mkdirSync(path.dirname(this.pidFile()), { recursive: true }); fs.writeFileSync(this.pidFile(), JSON.stringify({ pid: child.pid, port })); } catch { /* best effort */ }
    if (!cpu) this.note = '';
    logger.info({ model: s.model, port, device: this.device, pid: child.pid }, 'voice: whisper-server ready');
  }

  private failReason(): string {
    const interesting = this.stderrTail.filter((l) => /error|fail|out of memory|cuda|cannot|invalid/i.test(l)).slice(-4);
    return (interesting.length ? interesting : this.stderrTail.slice(-3)).join(' | ').slice(0, 600) || 'whisper-server exited';
  }

  /** Transcribe one 16 kHz mono WAV utterance. Requests run one at a time. */
  transcribe(wav: Buffer): Promise<TranscribeResult> {
    this.busy++;
    const run = this.queue.then(() => this.transcribeNow(wav, true)).finally(() => { this.busy--; this.lastUsed = Date.now(); });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async transcribeNow(wav: Buffer, mayRetry: boolean): Promise<TranscribeResult> {
    const t0 = Date.now();
    await this.ensure();
    this.lastUsed = Date.now();
    const s = this.settings();
    const o = whisperRuntimeOptions(s);
    const langs = s.languages;
    try {
      let r = await this.infer(wav, langs.length === 1 ? langs[0]! : 'auto', s.translate);
      if (langs.length > 1 && r.code && !langs.includes(r.code)) {
        // Claude Voice limits detection to the configured languages; whisper-server reports only the
        // top language, so a detection outside the list is decoded again in the best allowed one.
        const probs = r.probs;
        const best = langs.slice().sort((a, b) => (probs[b] ?? 0) - (probs[a] ?? 0))[0]!;
        r = await this.infer(wav, best, s.translate);
        if (!r.code) r.code = best;
      }
      const text = r.segments
        .filter((sg) => !(typeof sg.no_speech_prob === 'number' && sg.no_speech_prob > o.noSpeechThreshold))
        .map((sg) => String(sg.text || '').trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      this.lastUsed = Date.now();
      return { text, lang: r.code, ms: Date.now() - t0, device: this.device };
    } catch (err) {
      // The server died during the request (e.g. CUDA out of memory while decoding): retry once,
      // on CPU when it was on the GPU. The failed fetch can arrive just before the exit event.
      const c = this.child;
      if (c && c.exitCode === null) await new Promise<void>((r) => { const t = setTimeout(r, 1500); c.once('exit', () => { clearTimeout(t); r(); }); });
      if (mayRetry && !this.child) {
        if (this.device !== 'cpu' && s.device !== 'cpu') {
          this.gpuFailedSig = this.startSig(s);
          this.note = `whisper-server crashed on the GPU (${this.failReason().slice(0, 200)}); running on CPU`;
          logger.warn({ err: String(err) }, 'voice: whisper-server crashed on the GPU, retrying on CPU');
        }
        return this.transcribeNow(wav, false);
      }
      throw err;
    }
  }

  private async infer(wav: Buffer, language: string, translate: boolean) {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'utterance.wav');
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0.0');
    form.append('language', language);
    form.append('translate', translate ? 'true' : 'false');
    form.append('beam_size', String(whisperRuntimeOptions(this.settings()).beamSize));
    const res = await fetch(`http://127.0.0.1:${this.port}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(180_000) });
    const body = await res.text();
    if (!res.ok) throw new Error(`whisper-server HTTP ${res.status}: ${body.slice(0, 200)}`);
    let j: { language?: string; segments?: Array<{ text?: string; no_speech_prob?: number }>; text?: string; language_probabilities?: Record<string, number>; error?: string };
    try { j = JSON.parse(body); } catch { throw new Error(`whisper-server returned ${body.slice(0, 120)}`); }
    if (j.error) throw new Error(`whisper-server: ${j.error}`);
    const probs = j.language_probabilities ?? {};
    const top = Object.entries(probs).sort((a, b) => b[1] - a[1])[0]?.[0];
    const named = LANG_CODES[String(j.language || '').toLowerCase()] ?? (String(j.language || '').length === 2 ? String(j.language) : '');
    const segments = Array.isArray(j.segments) && j.segments.length ? j.segments : [{ text: j.text ?? '' }];
    return { code: language !== 'auto' ? language : (top || named), probs, segments };
  }
}
