import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ZamolxisConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { codeLocalModel, ollamaRoot, MIN_CODE_CONTEXT } from './backends.js';

/**
 * Local (Ollama) model support shared by the web channel's Local-model panel, Settings -> Code,
 * the delegation orchestrator and the load_code_model tool:
 *  - hardware detection (RAM, NVIDIA VRAM, Apple unified memory),
 *  - background `ollama pull` with progress (one shared registry, so the UI shows pulls the chat
 *    started and the other way round),
 *  - a coding-model catalog with a hardware-aware recommendation,
 *  - a disk check of Ollama's models folder before any pull.
 * Nothing here changes environment variables or moves files: a full disk is only explained.
 */

// ── Hardware ──

export interface Hardware {
  ramGB: number;
  hasGpu: boolean;
  vramGB: number;
  /** How big a model can comfortably run (GB). */
  effCapGB: number;
  kind: string;
}

let hwCache: Hardware | undefined;
/** Best-effort local hardware probe: RAM (always), NVIDIA VRAM via nvidia-smi, Apple-Silicon
 *  unified memory. Cached per process. */
export function detectHardware(): Hardware {
  if (hwCache) return hwCache;
  // GiB, the unit RAM is sold in (64 GB of RAM reports 64, not 68.7).
  const ramGB = Math.max(1, Math.round(os.totalmem() / 1024 ** 3));
  let hasGpu = false, vramGB = 0, kind = 'cpu';
  try {
    const r = spawnSync('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf8', windowsHide: true, timeout: 4000 });
    if (r.status === 0 && r.stdout) {
      const mb = Math.max(...r.stdout.trim().split(/\r?\n/).map((l) => parseInt(l, 10)).filter((n) => !Number.isNaN(n)));
      if (mb > 0) { hasGpu = true; vramGB = Math.round(mb / 1024); kind = 'nvidia'; }
    }
  } catch { /* no nvidia-smi */ }
  if (!hasGpu && process.platform === 'darwin' && os.arch() === 'arm64') { hasGpu = true; vramGB = ramGB; kind = 'apple'; }
  const effCapGB = kind === 'apple' ? Math.floor(ramGB * 0.7) : hasGpu ? vramGB : Math.floor(ramGB / 2);
  hwCache = { ramGB, hasGpu, vramGB, effCapGB, kind };
  return hwCache;
}

// ── Pulls ──

export interface PullState {
  status: string;
  pct: number;
  done: boolean;
  error?: string;
}

/** In-flight / finished Ollama pulls (shown as progress in the Local-model panel and Settings -> Code). */
export const ollamaPulls = new Map<string, PullState>();
const pullRuns = new Map<string, Promise<PullState>>();
const pullListeners = new Map<string, Set<(s: PullState) => void>>();

function setPull(model: string, s: PullState): void {
  ollamaPulls.set(model, s);
  for (const fn of pullListeners.get(model) ?? []) {
    try {
      fn(s);
    } catch {
      /* listener errors never break the pull */
    }
  }
}

/** Background `ollama pull` via the native streaming API (base = Ollama root, no /v1). Resolves
 *  with the final state; a second call for a model already pulling joins the running pull. */
export function startOllamaPull(base: string, model: string, onUpdate?: (s: PullState) => void): Promise<PullState> {
  if (onUpdate) {
    const set = pullListeners.get(model) ?? new Set();
    set.add(onUpdate);
    pullListeners.set(model, set);
  }
  const running = pullRuns.get(model);
  if (running) return running.finally(() => onUpdate && pullListeners.get(model)?.delete(onUpdate));
  setPull(model, { status: 'starting', pct: 0, done: false });
  const run = (async (): Promise<PullState> => {
    try {
      const r = await fetch(base + '/api/pull', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: model, stream: true }) });
      if (!r.ok || !r.body) {
        setPull(model, { status: 'failed', pct: 0, done: true, error: 'HTTP ' + (r ? r.status : '?') });
        return ollamaPulls.get(model)!;
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          try {
            const o = JSON.parse(line) as { status?: string; total?: number; completed?: number; error?: string };
            const pct = o.total && o.completed ? Math.round((o.completed / o.total) * 100) : (ollamaPulls.get(model)?.pct ?? 0);
            if (o.error) setPull(model, { status: 'failed', pct, done: true, error: o.error });
            else setPull(model, { status: o.status || 'pulling', pct, done: false });
          } catch {
            /* skip non-JSON line */
          }
        }
      }
      const fin = ollamaPulls.get(model);
      if (fin && !fin.error) setPull(model, { status: 'success', pct: 100, done: true });
    } catch (err) {
      setPull(model, { status: 'failed', pct: 0, done: true, error: String(err) });
    }
    return ollamaPulls.get(model)!;
  })().finally(() => {
    pullRuns.delete(model);
    pullListeners.delete(model);
  });
  pullRuns.set(model, run);
  return run;
}

// ── Coding-model catalog + recommendation ──

export interface CodeModelInfo {
  id: string;
  /** Download size (GB, Q4 build as listed on ollama.com). */
  sizeGb: number;
  /** Coding strength (higher = better); used to decide whether an installed model is good enough. */
  rank: number;
  /** Native context window (tokens). */
  context: number;
  desc: string;
}

/** Tool-capable coding models in the Ollama library that the recommendation can pick. */
export const CODE_MODEL_CATALOG: CodeModelInfo[] = [
  { id: 'qwen3-coder:30b', sizeGb: 19, rank: 4, context: 262_144, desc: 'Qwen3-Coder 30B, a mixture-of-experts model with about 3B active parameters: strong agentic coding and tool use, and it runs at a usable speed on CPU + RAM.' },
  { id: 'qwen2.5-coder:14b', sizeGb: 9, rank: 2, context: 32_768, desc: 'Qwen2.5-Coder 14B: solid code edits and tool calls on mid-range hardware.' },
  { id: 'qwen2.5-coder:7b', sizeGb: 4.7, rank: 1, context: 32_768, desc: 'Qwen2.5-Coder 7B: the smallest model that still codes reasonably with tools.' },
];

/** Coding rank of any model name: -1 = not a coding model, 0 = a coder too small/weak for agentic
 *  work, 1+ = usable (higher is better). */
export function coderRank(name?: string): number {
  const x = (name || '').toLowerCase().trim();
  if (!x) return -1;
  if (/qwen3-coder-next|qwen3-coder:480b/.test(x)) return 5;
  if (/qwen3-coder/.test(x)) return 4;
  if (/devstral|qwen2\.5-coder:32b/.test(x)) return 3;
  if (/qwen2\.5-coder:14b|deepseek-coder-v2|codestral/.test(x)) return 2;
  if (/qwen2\.5-coder(:7b|:latest)?$/.test(x)) return 1;
  if (/coder|codellama|starcoder|codegemma|codeqwen/.test(x)) return 0;
  return -1;
}

export interface Recommendation extends CodeModelInfo {
  /** Why it fits this machine. */
  why: string;
  /** The hardware can run it. */
  fits: boolean;
}

/** Pick the coding model for this hardware: qwen3-coder:30b with RAM >= 32 GB (or VRAM >= 20 GB),
 *  else qwen2.5-coder:14b with VRAM >= 10 GB or RAM >= 24 GB, else qwen2.5-coder:7b. */
export function recommendCodeModel(hw: Pick<Hardware, 'ramGB' | 'vramGB'>): Recommendation {
  const by = (id: string): CodeModelInfo => CODE_MODEL_CATALOG.find((c) => c.id === id)!;
  if (hw.ramGB >= 32 || hw.vramGB >= 20) {
    const why = hw.vramGB >= 20
      ? `${hw.vramGB} GB of VRAM holds the whole model on the GPU`
      : `${hw.ramGB} GB of RAM holds the model; with only about 3B parameters active per token it runs at a usable speed on CPU + RAM${hw.vramGB ? ` (the ${hw.vramGB} GB GPU takes part of it)` : ''}`;
    return { ...by('qwen3-coder:30b'), why, fits: true };
  }
  if (hw.vramGB >= 10 || hw.ramGB >= 24) {
    const why = hw.vramGB >= 10 ? `${hw.vramGB} GB of VRAM runs the 14B model mostly on the GPU` : `${hw.ramGB} GB of RAM runs the 14B model (slower on CPU, but workable)`;
    return { ...by('qwen2.5-coder:14b'), why, fits: true };
  }
  return { ...by('qwen2.5-coder:7b'), why: `the 7B model is the best coder that fits ${hw.ramGB} GB of RAM${hw.vramGB ? ` and a ${hw.vramGB} GB GPU` : ''}`, fits: hw.ramGB >= 8 || hw.vramGB >= 6 };
}

// ── Disk ──

/** Where Ollama keeps its models: OLLAMA_MODELS (this process, then on Windows the user and the
 *  machine environment, which is what the Ollama app reads), else ~/.ollama/models. */
export function ollamaModelsDir(): { dir: string; source: string } {
  const envDir = (process.env.OLLAMA_MODELS || '').trim();
  if (envDir) return { dir: envDir, source: 'OLLAMA_MODELS' };
  if (process.platform === 'win32') {
    for (const [hive, label] of [['HKCU\\Environment', 'user OLLAMA_MODELS'], ['HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'system OLLAMA_MODELS']] as const) {
      try {
        const r = spawnSync('reg', ['query', hive, '/v', 'OLLAMA_MODELS'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
        const m = r.status === 0 ? /OLLAMA_MODELS\s+REG_(?:EXPAND_)?SZ\s+(.+)/i.exec(r.stdout || '') : null;
        if (m && m[1]!.trim()) return { dir: m[1]!.trim().replace(/%([^%]+)%/g, (_x, n: string) => process.env[n] ?? `%${n}%`), source: label };
      } catch {
        /* reg unavailable */
      }
    }
  }
  const home = path.join(os.homedir(), '.ollama', 'models');
  if (process.platform === 'linux' && !fs.existsSync(home) && fs.existsSync('/usr/share/ollama/.ollama/models')) return { dir: '/usr/share/ollama/.ollama/models', source: 'Linux service default' };
  return { dir: home, source: 'default' };
}

/** Free space (GB) on the drive holding `dir` (its nearest existing ancestor), or null if unknown. */
export function freeSpaceGb(dir: string): number | null {
  let cur = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(cur)) break;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  try {
    const s = fs.statfsSync(cur);
    return Math.round(((Number(s.bavail) * Number(s.bsize)) / 1e9) * 10) / 10;
  } catch {
    return null;
  }
}

/** Windows: the other fixed drive with the most free space (for the "move the models folder" hint). */
function roomiestOtherDrive(dir: string): string | null {
  if (process.platform !== 'win32') return null;
  const own = path.parse(path.resolve(dir)).root.slice(0, 1).toUpperCase();
  let best: { letter: string; free: number } | null = null;
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (letter === own) continue;
    const root = `${letter}:\\`;
    try {
      if (!fs.existsSync(root)) continue;
      const s = fs.statfsSync(root);
      const free = (Number(s.bavail) * Number(s.bsize)) / 1e9;
      if (!best || free > best.free) best = { letter, free };
    } catch {
      /* not ready (card reader, network) */
    }
  }
  return best ? `${best.letter}:\\Ollama\\models` : null;
}

export const DISK_MARGIN_GB = 2;

export interface DiskVerdict {
  ok: boolean;
  modelsDir: string;
  freeGb: number | null;
  needGb: number;
  reason?: string;
}

/** Pure disk decision: refuse when free space < model size + 2 GB (unknown free space is allowed). */
export function diskVerdict(model: string, sizeGb: number, modelsDir: string, freeGb: number | null, suggestDir?: string | null): DiskVerdict {
  const needGb = Math.round((sizeGb + DISK_MARGIN_GB) * 10) / 10;
  if (freeGb === null || freeGb >= needGb) return { ok: true, modelsDir, freeGb, needGb };
  const target = suggestDir || (process.platform === 'win32' ? 'D:\\Ollama\\models' : '/path/with/space/ollama/models');
  const how = process.platform === 'win32'
    ? `set the OLLAMA_MODELS user environment variable to a folder on a drive with space (for example ${target}: Settings -> System -> About -> Advanced system settings -> Environment Variables, or setx OLLAMA_MODELS "${target}" in a terminal), move the existing models folder there if you want to keep your models, then quit Ollama from the tray and start it again`
    : `set OLLAMA_MODELS to a folder on a disk with space (for example ${target}) for the Ollama service or your shell, move the existing models folder there if you want to keep your models, then restart Ollama`;
  return {
    ok: false,
    modelsDir,
    freeGb,
    needGb,
    reason: `Not enough disk space for ${model}: it needs about ${sizeGb} GB plus ${DISK_MARGIN_GB} GB headroom, and Ollama's models folder (${modelsDir}) has only ${freeGb} GB free. To make room, ${how}. Then try again.`,
  };
}

/** Disk check against the real models folder. */
export function checkDisk(model: string, sizeGb: number): DiskVerdict {
  const { dir } = ollamaModelsDir();
  const free = freeSpaceGb(dir);
  return diskVerdict(model, sizeGb, dir, free, free !== null && free < sizeGb + DISK_MARGIN_GB ? roomiestOtherDrive(dir) : null);
}

/** Assumed size for a model that is not in the catalog (Ollama has no remote size lookup). */
export const UNKNOWN_MODEL_SIZE_GB = 10;

// ── Advice for Settings -> Code and the orchestrator ──

export interface CodeModelAdvice {
  current: string;
  recommended: string;
  /** An installed coder at least as good as the recommendation (use it instead of downloading). */
  installedCoder?: string;
  /** Why the current code model is not good enough (absent when it is). */
  reasonNotGood?: string;
  /** Propose a change (download the recommendation, or switch to installedCoder). */
  propose: boolean;
  sizeGb: number;
  fits: boolean;
  why: string;
  desc: string;
  context: number;
  minContext: number;
  /** The model's native context is at least what Claude Code needs. */
  contextOk: boolean;
  modelsDir: string;
  freeGb: number | null;
  canPull: boolean;
  blockReason?: string;
  hardware: { ramGB: number; vramGB: number };
}

const hasModel = (installed: string[], id: string): boolean => installed.some((n) => n === id || n === id + ':latest' || (!id.includes(':') && n.startsWith(id + ':')));

/** Recommendation for the code backend's local model. `installed` = Ollama's model list (undefined
 *  = Ollama not reachable). */
export function codeModelAdvice(
  config: ZamolxisConfig,
  installed: string[] | undefined,
  hw: Pick<Hardware, 'ramGB' | 'vramGB'> = detectHardware(),
  disk?: (model: string, sizeGb: number) => DiskVerdict,
): CodeModelAdvice {
  const current = codeLocalModel(config) || '';
  const rec = recommendCodeModel(hw);
  const list = installed ?? [];
  const curRank = coderRank(current);
  const curInstalled = !!current && hasModel(list, current);
  const bestInstalled = list.filter((n) => coderRank(n) >= 1).sort((a, b) => coderRank(b) - coderRank(a))[0];
  const installedCoder = bestInstalled && coderRank(bestInstalled) >= rec.rank ? bestInstalled : hasModel(list, rec.id) ? rec.id : undefined;
  const good = curInstalled && curRank >= rec.rank;
  let reasonNotGood: string | undefined;
  if (!good) {
    if (!current) reasonNotGood = 'no local model is set for code jobs';
    else if (curRank < 0) reasonNotGood = `${current} is a general chat model, not a coding model; Claude Code's file edits and tool calls go much better with a coder`;
    else if (curRank < 1) reasonNotGood = `${current} is a coding model too small for Claude Code's agentic edits`;
    else if (!curInstalled && installed) reasonNotGood = `${current} is not installed in Ollama`;
    else if (curRank < rec.rank) reasonNotGood = `${current} is a weaker coder than this machine can run`;
  }
  const propose = !!reasonNotGood && (curRank < rec.rank || !curInstalled);
  const v = (disk ?? checkDisk)(rec.id, rec.sizeGb);
  let blockReason: string | undefined;
  if (installed === undefined) blockReason = 'Ollama is not running, so nothing can be downloaded right now.';
  else if (installedCoder) blockReason = `${installedCoder} is already installed; use it instead of downloading.`;
  else if (!v.ok) blockReason = v.reason;
  return {
    current,
    recommended: rec.id,
    ...(installedCoder ? { installedCoder } : {}),
    ...(reasonNotGood ? { reasonNotGood } : {}),
    propose,
    sizeGb: rec.sizeGb,
    fits: rec.fits,
    why: rec.why,
    desc: rec.desc,
    context: rec.context,
    minContext: MIN_CODE_CONTEXT,
    contextOk: rec.context >= MIN_CODE_CONTEXT,
    modelsDir: v.modelsDir,
    freeGb: v.freeGb,
    canPull: !blockReason,
    ...(blockReason ? { blockReason } : {}),
    hardware: { ramGB: hw.ramGB, vramGB: hw.vramGB },
  };
}

/** Ollama's installed model names, or undefined when it is not reachable. */
export async function ollamaInstalled(config: ZamolxisConfig): Promise<string[] | undefined> {
  try {
    const r = await fetch(ollamaRoot(config) + '/api/tags', { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return undefined;
    const d = (await r.json()) as { models?: Array<{ name: string }> };
    return (d.models ?? []).map((m) => m.name);
  } catch {
    return undefined;
  }
}

/** One short proposal line for a delegated run's result (empty when nothing to propose). */
export function proposalText(a: CodeModelAdvice): string {
  if (!a.propose) return '';
  if (a.installedCoder) return `Tip: ${a.reasonNotGood}. ${a.installedCoder} is already installed and codes better; set it as the local model in Settings -> Code, or ask me to switch to it.`;
  const size = `about ${a.sizeGb} GB download`;
  const block = a.blockReason ? ` Note: ${a.blockReason}` : '';
  return `Tip: ${a.reasonNotGood}. A better local coding model for this machine is ${a.recommended} (${size}): ${a.why}. You can load it from Settings -> Code ("Download and use"), or ask me to load it.${block}`;
}

// ── Loading a code model (Settings button + load_code_model tool) ──

/** Ollama model names: name[:tag] with up to two namespace prefixes (library/x, hf.co/user/repo). */
export const OLLAMA_NAME_RE = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*){0,2}(:[a-z0-9][a-z0-9._-]*)?$/i;

/** Saves the chosen code model (registered by the settings store, like a Settings -> Code save). */
let codeModelPersister: ((model: string) => void) | null = null;
export function setCodeModelPersister(fn: ((model: string) => void) | null): void {
  codeModelPersister = fn;
}

/** Pull a coding model into Ollama (the recommendation, or a named model), wait for it with
 *  progress, then make it the code backend's local model. Refuses cleanly on a bad name, a full
 *  disk, or Ollama not running. Returns a human-readable result. */
export async function loadCodeModel(config: ZamolxisConfig, opts?: { model?: string; onProgress?: (line: string) => void }): Promise<{ ok: boolean; model: string; message: string }> {
  const named = (opts?.model || '').trim();
  if (named && (named.length > 100 || !OLLAMA_NAME_RE.test(named))) return { ok: false, model: named.slice(0, 100), message: `Refusing an invalid Ollama model name: ${named.slice(0, 100)}` };
  const installed = await ollamaInstalled(config);
  const model = named || recommendCodeModel(detectHardware()).id;
  if (installed === undefined) return { ok: false, model, message: `Ollama is not reachable at ${ollamaRoot(config)}. Start Ollama (or install it from the Local model app) and try again.` };
  const save = (): void => {
    if (codeModelPersister) codeModelPersister(model);
    else config.codeLocalModel = model;
  };
  if (hasModel(installed, model)) {
    save();
    return { ok: true, model, message: `${model} is already installed; it is now the local model for code jobs.` };
  }
  const known = CODE_MODEL_CATALOG.find((c) => c.id === model);
  const sizeGb = known?.sizeGb ?? UNKNOWN_MODEL_SIZE_GB;
  const v = checkDisk(model, sizeGb);
  if (!v.ok) return { ok: false, model, message: v.reason! + (known ? '' : ` (The size of ${model} is unknown here; ${UNKNOWN_MODEL_SIZE_GB} GB was assumed.)`) };
  opts?.onProgress?.(`downloading ${model} (${known ? `about ${sizeGb} GB` : 'size unknown'}) into ${v.modelsDir}`);
  let lastPct = -10;
  let lastStatus = '';
  const fin = await startOllamaPull(ollamaRoot(config), model, (s) => {
    if (s.done) return;
    if (s.pct >= lastPct + 10 || (s.status !== lastStatus && !/^pulling [0-9a-f]{6,}/.test(s.status))) {
      lastPct = Math.floor(s.pct / 10) * 10;
      lastStatus = s.status;
      opts?.onProgress?.(`${model}: ${s.status}${s.pct ? ` ${s.pct}%` : ''}`);
    }
  });
  if (fin.error) {
    logger.warn({ model, error: fin.error }, 'code model pull failed');
    return { ok: false, model, message: `Downloading ${model} failed: ${fin.error}` };
  }
  save();
  logger.info({ model }, 'code model pulled and selected');
  return { ok: true, model, message: `Downloaded ${model} and set it as the local model for code jobs.` };
}
