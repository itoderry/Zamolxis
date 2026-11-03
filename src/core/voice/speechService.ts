import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../../logger.js';

/**
 * Client of the shared speech service (SpeechService.exe, built with Claude Voice; spec in
 * C:\Claude\Voice Dictation\docs\SPEECH_SERVICE.md). One whisper model on 127.0.0.1 serves Claude Voice,
 * the meeting listener and Zamolxis, so the apps no longer each load large-v3 into the GPU's memory.
 *  - discovery: %LOCALAPPDATA%\SpeechService\endpoint.json holds the port and a token (SPEECHSERVICE_HOME
 *    overrides the folder, for tests);
 *  - when it does not answer it is started from HKCU\Software\SpeechService\InstallDir;
 *  - requests carry the token and no Origin header (the service refuses browser requests).
 * When it cannot be reached, WhisperServer falls back to its own whisper-server sidecar.
 */

export interface ServiceEndpoint { port: number; token: string }
export interface ServiceStatus {
  state?: string; mode?: string; device?: string; model?: string; degraded?: boolean; degraded_reason?: string;
  version?: string; api?: number; error?: string;
}
export interface ServiceReply { status: number; body: Record<string, unknown> }
export interface ServiceOptions {
  client: string; priority: 'interactive' | 'background'; task: 'translate' | 'transcribe';
  languages: string[]; prompt: string; beam_size: number;
}

export function serviceDir(): string {
  return process.env.SPEECHSERVICE_HOME || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'SpeechService');
}

export function readEndpoint(): ServiceEndpoint | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(serviceDir(), 'endpoint.json'), 'utf8')) as { port?: number; token?: string };
    return j.port && j.token ? { port: Number(j.port), token: String(j.token) } : null;
  } catch {
    return null;
  }
}

export async function call(ep: ServiceEndpoint, method: string, route: string, body?: Buffer, headers: Record<string, string> = {},
                           timeoutMs = 5000): Promise<ServiceReply> {
  try {
    const res = await fetch(`http://127.0.0.1:${ep.port}${route}`, {
      method, body, headers: { Authorization: `Bearer ${ep.token}`, ...headers }, signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let j: Record<string, unknown> = {};
    try { j = text ? JSON.parse(text) : {}; } catch { j = { error: text.slice(0, 200) }; }
    return { status: res.status, body: j };
  } catch (err) {
    return { status: 0, body: { error: String((err as Error).message || err) } };
  }
}

export async function serviceStatus(ep: ServiceEndpoint, timeoutMs = 1500): Promise<ServiceStatus | null> {
  const r = await call(ep, 'GET', '/v1/status', undefined, {}, timeoutMs);
  return r.status === 200 ? (r.body as ServiceStatus) : null;
}

/** SpeechService.exe from the registry (InstallDir), or '' when it is not installed. Cached for a minute. */
let exeCache = { at: 0, exe: '' };
export function serviceExe(): Promise<string> {
  if (process.env.SPEECHSERVICE_EXE !== undefined) return Promise.resolve(process.env.SPEECHSERVICE_EXE);   // tests
  if (process.platform !== 'win32') return Promise.resolve('');
  if (Date.now() - exeCache.at < 60_000) return Promise.resolve(exeCache.exe);
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKCU\\Software\\SpeechService', '/v', 'InstallDir'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      let exe = '';
      const m = !err && /InstallDir\s+REG_SZ\s+(.+)/.exec(String(stdout));
      if (m) {
        const p = path.join(m[1]!.trim(), 'SpeechService.exe');
        if (fs.existsSync(p)) exe = p;
      }
      exeCache = { at: Date.now(), exe };
      resolve(exe);
    });
  });
}

/** The endpoint and status once the service answers "ready"; with start, it is launched when it does not answer. */
export async function connectService(start: boolean, waitMs: number): Promise<{ ep: ServiceEndpoint; status: ServiceStatus } | null> {
  let ep = readEndpoint();
  let answered = false;
  if (ep) {
    const st = await serviceStatus(ep);
    if (st) {
      answered = true;                // running; it may still be loading the model
      if (st.state === 'ready') return { ep, status: st };
    }
  }
  if (!answered) {
    if (!start) return null;
    const exe = await serviceExe();
    if (!exe) return null;
    logger.info({ exe }, 'voice: starting the speech service');
    try {
      spawn(exe, ['--background'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch (err) {
      logger.warn({ err: String(err) }, 'voice: could not start the speech service');
      return null;
    }
  }
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 250));
    ep = readEndpoint();             // a fresh start writes a new port and token
    if (!ep) continue;
    const st = await serviceStatus(ep);
    if (st?.state === 'ready') return { ep, status: st };
  }
  logger.warn({ waitMs }, 'voice: the speech service did not become ready in time');
  return null;
}

export function multipart(boundary: string, wav: Buffer, options: ServiceOptions): Buffer {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="utterance.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
    wav,
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="options"\r\nContent-Type: application/json\r\n\r\n`),
    Buffer.from(JSON.stringify(options)),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

export interface ServiceResult { text: string; lang: string; device: 'gpu' | 'cpu'; model: string }

/**
 * The service as seen from one WhisperServer: keeps the endpoint, reconnects after a restart, and after a failed
 * attempt does not try again for a minute, so the sidecar fallback answers at once meanwhile.
 */
export class SpeechServiceClient {
  private ep: ServiceEndpoint | null = null;
  private last: ServiceStatus | null = null;
  private lastError = '';
  private retryAt = 0;
  private inUse = false;

  status() {
    return {
      inUse: this.inUse,
      port: this.ep?.port ?? null,
      state: this.last?.state ?? null,
      mode: this.last?.mode ?? null,
      model: this.last?.model ?? null,
      device: this.last?.device === 'cuda' ? 'gpu' : (this.last?.device ?? null),
      degraded: !!this.last?.degraded,
      degradedReason: this.last?.degraded_reason || null,
      lastError: this.lastError || null,
    };
  }

  /** Refreshes the status shown in Settings without starting the service. */
  async refresh(): Promise<void> {
    const ep = this.ep ?? readEndpoint();
    const st = ep ? await serviceStatus(ep) : null;
    if (st) { this.ep = ep; this.last = st; } else if (!this.inUse) this.last = null;
  }

  /** null when the service cannot be used now (not installed, not starting, failing): use the sidecar. */
  async transcribe(wav: Buffer, options: ServiceOptions, waitMs: number): Promise<ServiceResult | null> {
    if (Date.now() < this.retryAt) return null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.ep) {
        const c = await connectService(true, waitMs);
        if (!c) break;
        this.ep = c.ep;
        this.last = c.status;
        if (c.status.degraded) logger.warn({ reason: c.status.degraded_reason }, 'voice: the speech service runs on the CPU although a CUDA GPU is present');
      }
      const boundary = `----zamolxis${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
      const r = await call(this.ep, 'POST', '/v1/transcribe', multipart(boundary, wav, options),
        { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, 180_000);
      if (r.status === 200) {
        const b = r.body as { text?: string; language?: string; device?: string; model?: string };
        if (!this.inUse) logger.info({ port: this.ep.port, model: b.model, device: b.device }, 'voice: transcribing through the speech service');
        this.inUse = true;
        this.lastError = '';
        this.last = { ...(this.last ?? {}), device: b.device, model: b.model, state: 'ready' };
        return { text: String(b.text ?? '').trim(), lang: String(b.language ?? ''), device: b.device === 'cuda' ? 'gpu' : 'cpu', model: String(b.model ?? '') };
      }
      // the audio itself was refused: the sidecar would refuse it too
      if (r.status === 400 || r.status === 413) throw new Error(`speech service: ${String(r.body.error ?? r.status)}`);
      this.lastError = `${r.status || 'no answer'}: ${String(r.body.error ?? '').slice(0, 200)}`;
      logger.warn({ error: this.lastError }, 'voice: speech service request failed');
      this.ep = null;                  // restarted or crashed: a new port and token; connect (and start) again
    }
    this.inUse = false;
    this.retryAt = Date.now() + 60_000;
    return null;
  }
}
