import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { logger } from '../../logger.js';
import { claudeVoicePaths, describeKokoroVoice, type VoiceSettings } from './claudeVoiceConfig.js';

/**
 * Kokoro text-to-speech through Claude Voice's own engine: a long-lived Python process
 * (kokoro_tts.py) run with Claude Voice's venv in isolated mode (-I), speaking JSON lines.
 * Started on the first request, stopped after `idleMinutes` without one. The voice list is read
 * straight from voices-v1.0.bin (a numpy zip) so Settings doesn't have to load the model.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** kokoro_tts.py next to the compiled file (if copied into dist) or in the source tree. */
function scriptPath(): string {
  const cands = [path.join(HERE, 'kokoro_tts.py'), path.resolve(HERE, '..', '..', '..', 'src', 'core', 'voice', 'kokoro_tts.py')];
  return cands.find((p) => fs.existsSync(p)) ?? cands[1]!;
}

const instances = new Set<KokoroSidecar>();
/** Stop every Kokoro sidecar this process started (shutdown path). */
export function stopKokoroSidecars(): void { for (const k of instances) k.stop(); }
process.on('exit', () => { for (const k of instances) k.stop(); });

interface Pending { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

export class KokoroSidecar {
  private child: ChildProcess | null = null;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private lastUsed = 0;
  private lastError = '';
  private stderrTail: string[] = [];
  private voiceCache: { file: string; mtime: number; list: Array<{ id: string; label: string }> } | null = null;
  private readonly idleTimer: NodeJS.Timeout;

  constructor(private readonly settings: () => VoiceSettings) {
    instances.add(this);
    this.idleTimer = setInterval(() => {
      if (this.child && this.pending.size === 0 && Date.now() - this.lastUsed > this.settings().idleMinutes * 60_000) {
        logger.info('voice: Kokoro sidecar idle, stopping');
        this.stop();
      }
    }, 30_000);
    this.idleTimer.unref();
  }

  status() {
    const p = claudeVoicePaths();
    return {
      running: !!this.child,
      pid: this.child?.pid ?? null,
      python: p.python,
      pythonFound: fs.existsSync(p.python),
      repoFound: fs.existsSync(path.join(p.repo, 'claude_voice', 'tts.py')),
      modelFound: fs.existsSync(path.join(p.kokoroDir, 'kokoro-v1.0.onnx')) && fs.existsSync(path.join(p.kokoroDir, 'voices-v1.0.bin')),
      script: scriptPath(),
      lastError: this.lastError || null,
    };
  }

  stop(): void {
    const c = this.child;
    this.child = null;
    if (c && c.exitCode === null) {
      // The venv's python.exe is a launcher that starts the real interpreter: closing stdin ends the
      // script (it exits on EOF, also when Zamolxis itself dies); the kill is the fallback.
      try { c.stdin?.end(); } catch { /* closed */ }
      const t = setTimeout(() => { if (c.exitCode === null) { try { c.kill(); } catch { /* gone */ } } }, 1500);
      t.unref();
    }
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('Kokoro sidecar stopped')); this.pending.delete(id); }
  }

  private start(): ChildProcess {
    if (this.child) return this.child;
    const p = claudeVoicePaths();
    if (!fs.existsSync(p.python)) throw new Error(`Claude Voice Python not found: ${p.python}`);
    const script = scriptPath();
    const args = ['-I', script, '--repo', p.repo];
    if (p.modelsDir) args.push('--models', p.modelsDir);
    // -X utf8: the JSON lines carry non-ASCII text (Romanian, French) and -I ignores PYTHONUTF8.
    const child = spawn(p.python, ['-X', 'utf8', ...args], { cwd: path.dirname(script), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    // A write after the process died raises EPIPE on stdin; without a listener that would crash Zamolxis.
    child.stdin?.on('error', (e) => { this.lastError = `Kokoro sidecar stdin: ${String(e)}`; });
    this.stderrTail = [];
    logger.info({ pid: child.pid }, 'voice: Kokoro sidecar started');
    readline.createInterface({ input: child.stdout!, crlfDelay: Infinity }).on('line', (line) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(line) as Record<string, unknown>; } catch { return; }
      const id = Number(msg.id);
      const pend = this.pending.get(id);
      if (!pend) return;
      this.pending.delete(id);
      clearTimeout(pend.timer);
      if (msg.ok) pend.resolve(msg);
      else pend.reject(new Error(String(msg.error || 'Kokoro failed')));
    });
    child.stderr?.on('data', (d) => {
      for (const l of String(d).split(/\r?\n/)) if (l.trim()) { this.stderrTail.push(l); if (this.stderrTail.length > 20) this.stderrTail.shift(); }
    });
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      // When only the venv launcher died, the real interpreter still reads our pipe: closing it ends that one too.
      try { child.stdin?.destroy(); } catch { /* closed */ }
      if (code) this.lastError = `Kokoro sidecar exited (${code}): ${this.stderrTail.slice(-2).join(' | ').slice(0, 300)}`;
      for (const [id, pd] of this.pending) { clearTimeout(pd.timer); pd.reject(new Error(this.lastError || 'Kokoro sidecar exited')); this.pending.delete(id); }
    });
    child.on('error', (e) => {
      this.lastError = String(e);
      if (this.child === child) this.child = null;
      for (const [id, pd] of this.pending) { clearTimeout(pd.timer); pd.reject(new Error(this.lastError)); this.pending.delete(id); }
    });
    return child;
  }

  private request(op: string, body: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    this.lastUsed = Date.now();
    const child = this.start();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Kokoro ${op} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      // \u-escape non-ASCII so the line is plain ASCII whatever encoding Python reads stdin with.
      const line = JSON.stringify({ id, op, ...body }).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
      try {
        child.stdin!.write(line + '\n');
      } catch (err) {
        clearTimeout(timer); this.pending.delete(id); reject(err as Error);
      }
    });
  }

  /** WAV (24 kHz mono) for a reply; markdown is turned into speech text and capped at maxChars. */
  async synth(text: string, voice?: string, speed?: number, maxChars = 700): Promise<Buffer> {
    const s = this.settings();
    try {
      const r = await this.request('synth', { text, voice: voice || s.kokoroVoice, speed: speed || s.kokoroSpeed, max_chars: maxChars }, 120_000);
      this.lastError = '';
      return Buffer.from(String(r.wav_b64 || ''), 'base64');
    } catch (err) {
      this.lastError = String((err as Error).message || err);
      throw err;
    } finally {
      this.lastUsed = Date.now();
    }
  }

  /** Kokoro voices as [id, description], from the voices file (falls back to asking the sidecar). */
  async voices(): Promise<Array<{ id: string; label: string }>> {
    const file = path.join(claudeVoicePaths().kokoroDir, 'voices-v1.0.bin');
    let mtime = -1;
    try { mtime = fs.statSync(file).mtimeMs; } catch { /* missing */ }
    if (this.voiceCache && this.voiceCache.file === file && this.voiceCache.mtime === mtime) return this.voiceCache.list;
    try {
      const mod: any = await import('adm-zip');
      const Zip = mod.default ?? mod;
      const names: string[] = new Zip(file).getEntries().map((e: { entryName: string }) => e.entryName.replace(/\.npy$/i, ''));
      const ids = names.filter((n) => /^[a-z]{2}_[a-z0-9_]+$/i.test(n)).sort();
      if (ids.length) {
        const list = ids.map((id) => ({ id, label: describeKokoroVoice(id) }));
        this.voiceCache = { file, mtime, list };
        return list;
      }
    } catch { /* not a zip here, ask the engine */ }
    const r = await this.request('voices', {}, 120_000);
    return ((r.voices as Array<[string, string]>) || []).map((v) => ({ id: v[0], label: v[1] }));
  }
}
