import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { logger } from '../../logger.js';
import {
  claudeVoicePaths, listWhisperModels, voiceStateDir, whisperModelPath, whisperRuntimeOptions, whisperRuntimeSources,
  WHISPER_URL, WHISPER_ZIP, type VoiceSettings,
} from './claudeVoiceConfig.js';
import { describe as describeRuntime, formatBytes, freeBytes, runtimeDir, runtimeInfo, runtimeSetupRunning, setupRuntime, type SetupResult } from './whisperRuntime.js';

/**
 * whisper-server (whisper.cpp b5454, the build Claude Voice uses) as a sidecar for the "Claude Voice
 * (local Whisper)" speech engine. One instance is shared by every window:
 *  - started lazily on the first transcription, bound to 127.0.0.1 on a free port;
 *  - stopped after `idleMinutes` without a request, which frees the model's VRAM;
 *  - when the full model does not fit on the GPU (e.g. Claude Voice already holds the VRAM), a
 *    lighter model runs on the GPU instead (large-v3 on CPU is ~45 s per clip, so dictation fell
 *    behind); the full model is tried again in a quiet moment, then CPU is the last resort. A
 *    server that crashes mid-request on the GPU falls back the same way;
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

/** After the full model failed on the GPU, try it there again after this long (during a pause). */
const GPU_RETRY_MS = 10 * 60_000;

/** Fast, small fallbacks, best first. Only offered when the configured model is not one of them. */
const LIGHT_MODELS = ['base', 'base.en', 'small', 'small.en', 'tiny', 'tiny.en'];
/** An installed model lighter than `model` to run when `model` does not fit (undefined: none). */
export function lighterModel(model: string): string | undefined {
  if (LIGHT_MODELS.includes(model)) return undefined;
  const have = listWhisperModels();
  return LIGHT_MODELS.find((m) => have.includes(m));
}

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
  /** Start signature whose full model last failed on the GPU (e.g. another program, such as Claude
   *  Voice, holds the VRAM), and when. A lighter model then runs on the GPU instead of the full
   *  model on the CPU (~45 s per clip for large-v3, so dictation fell behind); the full model is
   *  tried again after GPU_RETRY_MS, on an idle unload, or when the settings change. */
  private gpuFailedSig = '';
  private gpuFailedAt = 0;
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
    const s = this.settings();
    const idleMs = s.idleMinutes * 60_000;
    if (this.busy === 0 && Date.now() - this.lastUsed > idleMs) {
      logger.info({ idleMinutes: s.idleMinutes }, 'voice: whisper-server idle, stopping to free memory');
      this.note = `unloaded after ${s.idleMinutes} idle minutes`;
      this.stop('idle');
      this.gpuFailedSig = ''; // the next start tries the full model on the GPU again
      return;
    }
    // Running a lighter model (or on CPU) because the GPU was full: during a quiet moment, try the
    // full model on the GPU again (another program may have freed the VRAM).
    const degraded = this.model !== s.model || (this.device === 'cpu' && s.device !== 'cpu' && !runtimeInfo().cpuOnly);
    if (degraded && !this.starting && this.busy === 0 && Date.now() - this.lastUsed > 20_000 && Date.now() - this.gpuFailedAt > GPU_RETRY_MS) {
      logger.info({ running: this.model, wanted: s.model, device: this.device }, 'voice: trying the full whisper model on the GPU again');
      this.gpuFailedSig = '';
      this.stop('restart');
      this.ensure().catch(() => undefined);
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
      const gpuOk = s.device !== 'cpu' && !runtimeInfo().cpuOnly;
      const fullFailedRecently = this.gpuFailedSig === sig && Date.now() - this.gpuFailedAt < GPU_RETRY_MS;
      const light = lighterModel(s.model);
      // Order: full model on the GPU; when that does not fit, a lighter model on the GPU (fast, a
      // little less accurate), then the lighter model on CPU, and the full model on CPU last.
      // A user who set Device -> CPU only keeps the chosen model on CPU (their choice); a CPU-only
      // runtime (no CUDA files) prefers the lighter model, which keeps up on a CPU.
      const plan: Array<{ model: string; cpu: boolean }> = [];
      if (s.device === 'cpu') plan.push({ model: s.model, cpu: true });
      else {
        if (gpuOk && !fullFailedRecently) plan.push({ model: s.model, cpu: false });
        if (gpuOk && light) plan.push({ model: light, cpu: false });
        if (light) plan.push({ model: light, cpu: true });
        plan.push({ model: s.model, cpu: true });
      }
      let lastErr: unknown;
      for (const step of plan) {
        try {
          await this.launch(s, sig, step.cpu, step.model);
          if (step.model !== s.model || step.cpu !== !gpuOk) {
            this.note = `${s.model} ${gpuOk ? 'did not fit on the GPU (another program may be using it)' : 'is set to CPU'}; running ${step.model} on ${step.cpu ? 'CPU' : 'the GPU'} for now${gpuOk ? `, ${s.model} is tried again in a quiet moment` : ''}`;
          } else this.note = '';
          return;
        } catch (err) {
          lastErr = err;
          const why = String((err as Error).message || err);
          if (step.model === s.model && !step.cpu) {
            this.gpuFailedSig = sig;
            this.gpuFailedAt = Date.now();
          }
          logger.warn({ model: step.model, cpu: step.cpu, err: why.slice(0, 300) }, 'voice: whisper-server failed to load, trying the next option');
        }
      }
      throw lastErr;
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

  private async launch(s: VoiceSettings, sig: string, cpu: boolean, modelName = s.model): Promise<void> {
    const exe = runtimeInfo().exe;
    if (!exe) throw new Error('whisper-server runtime is not set up');
    const o = whisperRuntimeOptions(s);
    const p = claudeVoicePaths();
    const port = await freePort();
    const threads = Math.max(2, Math.min(8, os.cpus().length - 2));
    const args = ['-m', whisperModelPath(modelName), '--host', '127.0.0.1', '--port', String(port), '-t', String(threads),
      '-l', 'auto', '-bs', String(o.beamSize), '-nth', String(o.noSpeechThreshold)];
    if (o.prompt) args.push('--prompt', o.prompt);
    // Silero VAD with faster-whisper's vad_filter defaults, as Claude Voice runs it.
    if (fs.existsSync(p.vadModel)) args.push('--vad', '-vm', p.vadModel, '-vt', '0.5', '-vspd', '0', '-vsd', '2000', '-vp', '400');
    if (cpu) args.push('-ng');
    this.state = 'starting';
    this.lastError = '';
    this.stderrTail = [];
    this.model = modelName;
    let sawCuda = false;
    logger.info({ model: modelName, port, cpu }, 'voice: starting whisper-server');
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
        if (this.state === 'running') {
          this.state = 'stopped';
          this.note = `whisper-server exited (${code})`;
          // Not stopped by us: say why, so a restart loop is diagnosable from the log.
          logger.warn({ code, model: this.model, device: this.device, why: this.failReason().slice(0, 400) }, 'voice: whisper-server exited unexpectedly');
        }
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
    logger.info({ model: modelName, port, device: this.device, pid: child.pid }, 'voice: whisper-server ready');
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
        if (this.device !== 'cpu' && s.device !== 'cpu' && this.model === s.model) {
          this.gpuFailedSig = this.startSig(s);
          this.gpuFailedAt = Date.now();
          logger.warn({ err: String(err), why: this.failReason().slice(0, 300) }, 'voice: whisper-server crashed on the GPU, using a lighter model');
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
