import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * The whisper-server runtime: ONE folder shared by every Zamolxis data dir
 * (%LOCALAPPDATA%\Zamolxis\whisper-runtime, or ZAMOLXIS_WHISPER_DIR).
 *
 * Claude Voice's install (cpp\dist\ClaudeVoice, CUDA DLLs in its gpu\ subfolder) already holds the
 * same whisper.cpp build as the release zip it was made from, except whisper-server.exe itself. So:
 *  - whisper-server.exe (~0.7 MB) is the only file extracted from the zip;
 *  - every DLL it needs is a HARD LINK to Claude Voice's copy (zero extra disk), after checking that
 *    its size matches the zip's entry, so a different Claude Voice build is detected;
 *  - only when that is not possible (other volume, no permission, different build) the DLLs are
 *    extracted from the zip, after a free-space check: ~1.2 GB with CUDA, or ~10 MB for a CPU-only
 *    runtime that leaves out ggml-cuda/cuBLAS.
 * Nothing is ever written through a link: old files are unlinked (directory entry only) before a
 * rebuild, and Claude Voice's own files are only read.
 *
 * manifest.json records each file's size and mtime; the runtime counts as ready only while all of
 * them still match (a Claude Voice rebuild that rewrites a linked DLL in place invalidates it).
 */

export type RuntimeMode = 'linked' | 'extracted' | 'mixed' | 'cpu-only' | 'none';
export interface RuntimeSources { zip: string; distDir: string; gpuDir: string }
interface ManifestFile { size: number; mtimeMs: number; how: 'link' | 'zip' }
interface Manifest { version: 1; cpuOnly: boolean; zip: string; distDir: string; createdAt: string; files: Record<string, ManifestFile> }

const EXE = process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server';
const MANIFEST = 'manifest.json';
/** whisper + ggml core and the CPU backends ggml loads at run time. */
const CORE_RE = /^(whisper|ggml|ggml-base|ggml-cpu-[\w-]+)\.dll$/i;
/** The CUDA backend and the CUDA runtime it imports (cuBLAS needs cuBLASLt; nvrtc is loaded on demand). */
const CUDA_RE = /^(ggml-cuda|cublas64_\d+|cublasLt64_\d+|cudart64_\d+|nvrtc64_[\d_]+|nvrtc-builtins64_\d+)\.dll$/i;
/** MSVC runtime next to Claude Voice's binaries (not in the zip; Windows usually has it in System32). */
const MSVC_RE = /^(msvcp140(_\d+)?|vcruntime140(_\d+)?|vcomp140)\.dll$/i;
/** Keep at least this much free on the runtime's volume after an extraction. */
const MIN_FREE_AFTER = 2 * 1024 ** 3;

export function runtimeDir(): string {
  const env = process.env.ZAMOLXIS_WHISPER_DIR;
  if (env && env.trim()) return path.resolve(env.trim());
  const base = process.platform === 'win32'
    ? (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'))
    : (process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'));
  return path.join(base, 'Zamolxis', 'whisper-runtime');
}

function readManifest(): Manifest | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(runtimeDir(), MANIFEST), 'utf8')) as Manifest;
    return m && m.version === 1 && m.files && typeof m.files === 'object' ? m : null;
  } catch {
    return null;
  }
}

export interface RuntimeInfo {
  dir: string;
  ready: boolean;
  mode: RuntimeMode;
  cpuOnly: boolean;
  exe: string;
  files: number;
  linked: number;
  /** Bytes only this runtime holds (files whose last link is here). */
  ownBytes: number;
  /** Bytes shared with Claude Voice through hard links (no extra disk). */
  sharedBytes: number;
  freeBytes: number | null;
  /** Linked files whose Claude Voice copy was replaced or deleted (they now take disk space here). */
  orphanedBytes: number;
  problem: string | null;
}

/** Check the runtime against its manifest (cheap: one stat per file). */
export function runtimeInfo(): RuntimeInfo {
  const dir = runtimeDir();
  const info: RuntimeInfo = { dir, ready: false, mode: 'none', cpuOnly: false, exe: '', files: 0, linked: 0, ownBytes: 0, sharedBytes: 0, freeBytes: freeBytes(dir), orphanedBytes: 0, problem: null };
  const m = readManifest();
  if (!m) { info.problem = 'not set up'; return info; }
  info.cpuOnly = !!m.cpuOnly;
  let links = 0;
  for (const [name, f] of Object.entries(m.files)) {
    let st: fs.Stats;
    try { st = fs.statSync(path.join(dir, name)); } catch { info.problem = `${name} is missing`; continue; }
    if (st.size !== f.size || Math.abs(st.mtimeMs - f.mtimeMs) > 2000) { info.problem ??= `${name} changed since setup`; }
    if (st.nlink > 1) info.sharedBytes += st.size; else info.ownBytes += st.size;
    if (f.how === 'link') { links++; if (st.nlink <= 1) info.orphanedBytes += st.size; }
    info.files++;
  }
  info.linked = links;
  const dlls = info.files - 1;
  info.mode = m.cpuOnly ? 'cpu-only' : links >= dlls && dlls > 0 ? 'linked' : links === 0 ? 'extracted' : 'mixed';
  if (!m.files[EXE]) info.problem ??= `${EXE} is not in the manifest`;
  info.ready = !info.problem;
  if (info.ready) info.exe = path.join(dir, EXE);
  return info;
}

/** whisper-server in the shared runtime when the runtime is complete, else ''. */
export function runtimeExe(): string { return runtimeInfo().exe; }

/** Free bytes on the volume holding `dir` (its nearest existing ancestor), or null when unknown. */
export function freeBytes(dir: string): number | null {
  let cur = path.resolve(dir);
  for (;;) {
    try { const s = fs.statfsSync(cur); return Number(s.bavail) * Number(s.bsize); } catch { /* go up */ }
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

function tarExe(): string {
  return process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
}
function runTar(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(tarExe(), args, { windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('error', (e) => resolve({ code: -1, out, err: String(e) }));
    child.on('close', (code) => resolve({ code: code ?? -1, out, err }));
  });
}

let entryCache: { zip: string; mtimeMs: number; size: number; entries: Map<string, number> } | null = null;
/** File sizes in the zip's Release/ folder (bsdtar -tvf), cached by the zip's mtime and size. */
export async function zipEntries(zip: string): Promise<Map<string, number>> {
  const st = fs.statSync(zip);
  if (entryCache && entryCache.zip === zip && entryCache.mtimeMs === st.mtimeMs && entryCache.size === st.size) return entryCache.entries;
  const r = await runTar(['-tvf', zip]);
  if (r.code !== 0) throw new Error(`cannot list ${zip}: ${r.err.trim().slice(-300)}`);
  const entries = new Map<string, number>();
  for (const line of r.out.split(/\r?\n/)) {
    // -rw-rw-r--  0 0      0      728576 Oct 06 16:26 Release/whisper-server.exe
    const m = /\s(\d+)\s+\w{3}\s+\d{1,2}\s+(?:\d{1,2}:\d{2}|\d{4})\s+Release\/([^/\\]+)$/.exec(line.trim());
    if (m) entries.set(m[2]!, Number(m[1]));
  }
  entryCache = { zip, mtimeMs: st.mtimeMs, size: st.size, entries };
  return entries;
}

function sizeOf(p: string): number { try { const s = fs.statSync(p); return s.isFile() ? s.size : -1; } catch { return -1; } }
function mb(n: number): string { return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${(n / 1024 ** 2).toFixed(1)} MB`; }
export { mb as formatBytes };

export interface SetupResult { ok: boolean; message: string; mode?: RuntimeMode; needsSpace?: boolean; cpuOnlyBytes?: number }
export interface SetupOptions {
  /** Leave out ggml-cuda and the CUDA runtime (CPU transcription only, ~10 MB when extracted). */
  cpuOnly?: boolean;
  /** Allow extracting DLLs from the zip when they cannot be linked (otherwise only links are made). */
  allowExtract?: boolean;
  /** Rebuild even when the runtime is complete (e.g. to re-link files Claude Voice replaced). */
  force?: boolean;
}

let running: Promise<SetupResult> | null = null;
/** Build the shared runtime (one setup at a time per process). */
export function setupRuntime(src: RuntimeSources, opts: SetupOptions = {}): Promise<SetupResult> {
  if (running) return running;
  running = doSetup(src, opts).finally(() => { running = null; });
  return running;
}
export function runtimeSetupRunning(): boolean { return !!running; }

async function doSetup(src: RuntimeSources, opts: SetupOptions): Promise<SetupResult> {
  const cur = runtimeInfo();
  // A complete runtime is kept: a full one also serves a CPU-only request.
  if (cur.ready && !opts.force && (!cur.cpuOnly || opts.cpuOnly)) return { ok: true, message: describe(cur), mode: cur.mode };
  if (!src.zip || sizeOf(src.zip) < 0) return { ok: false, message: `whisper.cpp release zip not found (${src.zip || 'no path'})` };
  const entries = await zipEntries(src.zip);
  const exeSize = entries.get(EXE);
  if (!exeSize) return { ok: false, message: `${EXE} is not in ${src.zip}` };
  const wanted = [...entries.keys()].filter((n) => CORE_RE.test(n) || (!opts.cpuOnly && CUDA_RE.test(n)));
  if (!wanted.some((n) => /^whisper\.dll$/i.test(n))) return { ok: false, message: `whisper.dll is not in ${src.zip}` };

  // Claude Voice's copy of each DLL, accepted only when its size equals the zip's entry.
  const source = (n: string): string => {
    const dirs = CUDA_RE.test(n) ? [src.gpuDir, src.distDir] : [src.distDir, src.gpuDir];
    for (const d of dirs) { const p = d ? path.join(d, n) : ''; if (p && sizeOf(p) >= 0) return p; }
    return '';
  };
  const mismatched = wanted.filter((n) => { const s = source(n); return !s || sizeOf(s) !== entries.get(n); });
  // One differing file means a different build: take the whole set from the zip so it stays consistent.
  const linkable = mismatched.length ? [] : wanted;

  const dir = runtimeDir();
  fs.mkdirSync(dir, { recursive: true });
  // Start clean. Unlinking removes only this folder's entry, never Claude Voice's file.
  try { fs.rmSync(path.join(dir, MANIFEST), { force: true }); } catch { /* none */ }
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    try { if (!fs.statSync(p).isFile()) continue; } catch { continue; }
    try { fs.unlinkSync(p); } catch (err) {
      return { ok: false, message: `cannot replace ${p} (${(err as NodeJS.ErrnoException).code}); is a whisper-server from this runtime still running?` };
    }
  }

  const files: Record<string, ManifestFile> = {};
  const fromZip: string[] = [];
  for (const n of linkable) {
    try { fs.linkSync(source(n), path.join(dir, n)); files[n] = { size: 0, mtimeMs: 0, how: 'link' }; } catch { fromZip.push(n); }
  }
  for (const n of wanted) if (!linkable.includes(n)) fromZip.push(n);
  // MSVC runtime: link when possible (same files Claude Voice runs with); System32 covers it otherwise.
  if (!fromZip.length) {
    let names: string[] = [];
    try { names = fs.readdirSync(src.distDir).filter((n) => MSVC_RE.test(n)); } catch { /* none */ }
    for (const n of names) { try { fs.linkSync(path.join(src.distDir, n), path.join(dir, n)); files[n] = { size: 0, mtimeMs: 0, how: 'link' }; } catch { /* System32 */ } }
  }

  const extract = [EXE, ...fromZip];
  const need = extract.reduce((s, n) => s + (entries.get(n) ?? 0), 0);
  if (fromZip.length) {
    const why = mismatched.length
      ? `Claude Voice's files differ from the zip (${mismatched.slice(0, 3).join(', ')}${mismatched.length > 3 ? ', ...' : ''})`
      : `hard links to Claude Voice's files are not possible here (${fromZip.slice(0, 2).join(', ')})`;
    const cpuBytes = [...entries.keys()].filter((n) => CORE_RE.test(n) || n === EXE).reduce((s, n) => s + (entries.get(n) ?? 0), 0);
    if (!opts.allowExtract) {
      return { ok: false, needsSpace: false, cpuOnlyBytes: cpuBytes, message: `${why}; setting up needs ${mb(need)} extracted from the zip: use Settings -> Voice -> Set up` };
    }
    const free = freeBytes(dir);
    if (free !== null && free - need < MIN_FREE_AFTER) {
      return {
        ok: false, needsSpace: true, cpuOnlyBytes: cpuBytes,
        message: `${why}; extracting needs ${mb(need)} but only ${mb(free)} is free on that drive (keeping ${mb(MIN_FREE_AFTER)} free)` + (opts.cpuOnly ? '' : `; a CPU-only setup needs ${mb(cpuBytes)}`),
      };
    }
  }
  // --strip-components puts the files straight in the runtime folder, next to the linked DLLs.
  const r = await runTar(['-xf', src.zip, '-C', dir, '--strip-components', '1', ...extract.map((n) => `Release/${n}`)]);
  if (r.code !== 0) return { ok: false, message: `extract failed (${r.code}): ${r.err.trim().slice(-300)}` };
  for (const n of extract) files[n] = { size: 0, mtimeMs: 0, how: 'zip' };

  // Record what is there now and check it against the zip.
  for (const [n, f] of Object.entries(files)) {
    let st: fs.Stats;
    try { st = fs.statSync(path.join(dir, n)); } catch { return { ok: false, message: `${n} missing after setup` }; }
    const expect = entries.get(n);
    if (expect !== undefined && st.size !== expect) return { ok: false, message: `${n} is ${st.size} bytes, the zip says ${expect}` };
    f.size = st.size; f.mtimeMs = st.mtimeMs;
  }
  const manifest: Manifest = { version: 1, cpuOnly: !!opts.cpuOnly, zip: src.zip, distDir: src.distDir, createdAt: new Date().toISOString(), files };
  fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2));
  const info = runtimeInfo();
  if (!info.ready) return { ok: false, message: `runtime incomplete: ${info.problem}` };
  return { ok: true, message: describe(info), mode: info.mode };
}

/** "linked to Claude Voice (24 files, 0.7 MB own disk)" and the like, for status lines. */
export function describe(i: RuntimeInfo): string {
  if (!i.ready) return `not set up${i.problem && i.problem !== 'not set up' ? ` (${i.problem})` : ''}`;
  const what = i.mode === 'linked' ? 'linked to Claude Voice'
    : i.mode === 'extracted' ? 'extracted from the zip'
    : i.mode === 'mixed' ? 'partly linked to Claude Voice'
    : i.linked ? 'CPU-only, linked to Claude Voice' : 'CPU-only, extracted';
  const orphan = i.orphanedBytes ? `; ${mb(i.orphanedBytes)} no longer shared because Claude Voice replaced its files, set up again to re-link` : '';
  return `${what} (${i.files} files, ${mb(i.ownBytes)} own disk${i.sharedBytes ? `, ${mb(i.sharedBytes)} shared` : ''})${orphan}`;
}
