import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runtimeExe, type RuntimeSources } from './whisperRuntime.js';

/**
 * Read-only view of the user's Claude Voice app (C:\Claude\Voice Dictation): its config file
 * (%APPDATA%\ClaudeVoice\config.json), its models (%LOCALAPPDATA%\ClaudeVoice\models), its Python
 * venv (for Kokoro) and the whisper.cpp release zip it was built from. Zamolxis reuses the engine,
 * the models and the settings as defaults; it never writes any of these files.
 *
 * Zamolxis's own choices (Settings -> Voice) are stored as overrides in settings.json (`voice`);
 * the effective settings are those overrides on top of the Claude Voice defaults, read each time
 * (cached by file mtime) so a change in Claude Voice shows up without a restart.
 */

export const WHISPER_TAG = 'b5454';
export const WHISPER_ZIP = 'whisper-bin-win-cuda-12.4.0-x64.zip';
export const WHISPER_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_TAG}/${WHISPER_ZIP}`;
export const VAD_FILE = 'ggml-silero-v5.1.2.bin';

/** Claude Voice's defaults for the keys Zamolxis uses (claude_voice/config.py DEFAULTS). */
const CV_DEFAULTS = {
  wake: {
    name: 'Claude',
    phrases: ['hello claude', 'hi claude', 'hey claude', 'salut claude', 'bonjour claude', 'buna claude'],
    name_aliases: ['cloud', 'clod', 'claud', 'klaud', 'clawed', 'glaude', 'claudia', 'clouds'],
    name_alone_at_start: true,
    match_ratio: 0.8,
    response: 'I am here, what is your request?',
  },
  stop: { phrases: ['execute', 'executa', 'execute it', 'executer', 'go ahead claude'], must_end_utterance: true, response: 'Sent.' },
  cancel: { phrases: ['cancel', 'never mind', 'forget it', 'anuleaza', 'annule'], response: 'Cancelled.' },
  dictation_timeout_s: 120,
  speech: {
    model: 'large-v3',
    languages: ['en', 'ro', 'fr'],
    device: 'auto',
    translate_to_english: true,
    beam_size: 5,
    initial_prompt: 'Hello Claude. To Teams, to Slack, to Word, to Outlook, to the assistant. Execute.',
    models_dir: 'auto',
    no_speech_threshold: 0.7,
  },
  // device: a substring of the microphone's name ('' = system default), e.g. "TONOR".
  mic: { device: '', sample_rate: 16000, silence_ms: 900, min_speech_ms: 400, max_utterance_s: 30, pre_roll_ms: 300, speech_ratio: 3.0, min_rms: 0.002 },
  voice: { engine: 'kokoro', kokoro_voice: 'af_heart', kokoro_speed: 1.0 },
};
type CvConfig = typeof CV_DEFAULTS;

/** Zamolxis's voice settings (Settings -> Voice). */
export interface VoiceSettings {
  /** 'browser' = Web Speech API (today's behaviour); 'claudevoice' = local whisper.cpp with Claude Voice's models. */
  engine: 'browser' | 'claudevoice';
  /** whisper model name: 'large-v3' -> ggml-large-v3.bin in the Claude Voice models folder. */
  model: string;
  languages: string[];
  translate: boolean;
  /** 'auto' = GPU when it loads, else one retry on CPU; 'cpu' = never use the GPU. Sidecar only: the shared
   *  speech service decides its own device (gaming mode in Claude Voice moves it to the CPU). */
  device: 'auto' | 'cpu';
  /** 'auto' = the shared speech service (SpeechService.exe) when it answers, else the whisper-server sidecar;
   *  'service' = waits longer for the service before falling back; 'sidecar' = always the sidecar. */
  backend: 'auto' | 'service' | 'sidecar';
  /** Stop whisper-server (and the Kokoro sidecar) after this many idle minutes, freeing VRAM. */
  idleMinutes: number;
  /** Microphone to record from: a substring of its name ('' = the browser's default input).
   *  Defaults to Claude Voice's mic.device so both apps use the same microphone. */
  micDevice: string;
  /** The browser's echo cancellation / noise suppression / auto-gain. Off by default: they are
   *  tuned for calls and garble speech for Whisper (Claude Voice records the raw signal). */
  audioCleanup: boolean;
  wakeEnabled: boolean;
  wakeName: string;
  wakeAliases: string[];
  stopPhrases: string[];
  cancelPhrases: string[];
  tts: 'off' | 'browser' | 'kokoro';
  kokoroVoice: string;
  kokoroSpeed: number;
}
export type VoiceOverrides = Partial<VoiceSettings>;

const ZAM_DEFAULTS = {
  idleMinutes: 5,
  wakeEnabled: false,
  wakeName: 'zam',
  wakeAliases: ['zamolxis', 'sam', 'zum', 'zahm', 'zom', 'zamm', 'tsam', 'xam'],
  tts: 'off' as const,
};

export interface ClaudeVoicePaths {
  config: string;
  repo: string;
  python: string;
  whisperZip: string;
  /** Claude Voice's C++ install: whisper.cpp DLLs here, the CUDA ones in its gpu subfolder. */
  distDir: string;
  modelsDir: string;
  vadModel: string;
  kokoroDir: string;
}

/** Zamolxis's data dir (set at boot): per-instance voice state such as the whisper-server pid file.
 *  The whisper-server runtime itself is shared by all data dirs (see whisperRuntime.ts). */
let zamDataDir = '';
export function setVoiceDataDir(dir: string): void { zamDataDir = dir; }
export function voiceStateDir(): string { return path.join(zamDataDir || path.join(os.homedir(), '.zamolxis'), 'voice'); }

/** Where the shared whisper-server runtime is built from: Claude Voice's release zip and install. */
export function whisperRuntimeSources(): RuntimeSources {
  const p = claudeVoicePaths();
  return { zip: p.whisperZip, distDir: p.distDir, gpuDir: path.join(p.distDir, 'gpu') };
}

/** Whether the Claude Voice engine can run here: whisper-server (extracted, or the zip to extract it
 *  from) and at least one whisper model. Decides the default engine and is shown in Settings. */
export function claudeVoiceEngineAvailability(): { ok: boolean; reason: string } {
  const p = claudeVoicePaths();
  let zip = false;
  try { zip = fs.statSync(p.whisperZip).isFile(); } catch { /* missing */ }
  const exe = runtimeExe();
  const models = listWhisperModels();
  // the shared speech service brings its own engine and models: installed is enough
  if (speechServiceInstalled()) return { ok: true, reason: 'speech service installed' + (exe ? ', whisper-server ready as the fallback' : '') };
  if (!exe && !zip) return { ok: false, reason: `whisper-server not found (no ${WHISPER_ZIP} in ${path.dirname(p.whisperZip)} and no runtime set up)` };
  if (!models.length) return { ok: false, reason: `no whisper model (ggml-*.bin) in ${p.modelsDir}` };
  return { ok: true, reason: `${exe ? 'whisper-server ready' : 'whisper-server zip found'}, models: ${models.join(', ')}` };
}

/** SpeechService.exe registered and present (sync: the endpoint file or the registry's install folder).
 *  The registry answer is kept for a minute: this runs on every voice status call and every settings
 *  snapshot, and a synchronous `reg query` blocks the whole server while it runs. */
let installedCache = { at: 0, value: false };
function speechServiceInstalled(): boolean {
  if (process.platform !== 'win32') return false;
  const dir = process.env.SPEECHSERVICE_HOME || path.join(localAppDataDir(), 'SpeechService');
  if (fs.existsSync(path.join(dir, 'endpoint.json'))) return true;
  if (Date.now() - installedCache.at < 60_000) return installedCache.value;
  installedCache = { at: Date.now(), value: speechServiceRegistered() };
  return installedCache.value;
}
function speechServiceRegistered(): boolean {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\SpeechService', '/v', 'InstallDir'], { windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const m = /InstallDir\s+REG_SZ\s+(.+)/.exec(out);
    return !!m && fs.existsSync(path.join(m[1]!.trim(), 'SpeechService.exe'));
  } catch {
    return false;
  }
}

function appDataDir(): string { return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'); }
function localAppDataDir(): string { return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'); }

/** Where the Claude Voice pieces live. ZAMOLXIS_CLAUDE_VOICE_DIR overrides the source folder. */
export function claudeVoicePaths(cfg?: CvConfig): ClaudeVoicePaths {
  const repo = process.env.ZAMOLXIS_CLAUDE_VOICE_DIR || 'C:\\Claude\\Voice Dictation';
  const md = (cfg ?? loadClaudeVoiceConfig().cfg).speech.models_dir;
  const modelsDir = md && md !== 'auto' ? md : path.join(localAppDataDir(), 'ClaudeVoice', 'models');
  return {
    config: path.join(appDataDir(), 'ClaudeVoice', 'config.json'),
    repo,
    python: path.join(repo, '.venv', 'Scripts', 'python.exe'),
    whisperZip: path.join(repo, 'cpp', 'third_party', 'downloads', WHISPER_ZIP),
    distDir: path.join(repo, 'cpp', 'dist', 'ClaudeVoice'),
    modelsDir,
    vadModel: path.join(modelsDir, VAD_FILE),
    kokoroDir: path.join(modelsDir, 'kokoro'),
  };
}

function isObj(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v); }
function merge<T>(base: T, over: unknown): T {
  if (!isObj(base) || !isObj(over)) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = (base as Record<string, unknown>)[k];
    if (isObj(b)) out[k] = merge(b, v);
    else if (b === undefined || v === null) continue;
    else if (Array.isArray(b)) { if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === 'string'); }
    else if (typeof v === typeof b) out[k] = v;
  }
  return out as T;
}

let cache: { mtime: number; found: boolean; cfg: CvConfig; error?: string } | null = null;

/** Claude Voice's config with its defaults filled in; `found` is false when the file is missing. */
export function loadClaudeVoiceConfig(): { found: boolean; path: string; cfg: CvConfig; error?: string } {
  const file = path.join(appDataDir(), 'ClaudeVoice', 'config.json');
  let mtime = -1;
  try { mtime = fs.statSync(file).mtimeMs; } catch { /* missing */ }
  if (cache && cache.mtime === mtime) return { found: cache.found, path: file, cfg: cache.cfg, error: cache.error };
  let cfg: CvConfig = CV_DEFAULTS;
  let found = false;
  let error: string | undefined;
  if (mtime >= 0) {
    try {
      cfg = merge(CV_DEFAULTS, JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
      found = true;
    } catch (err) {
      error = `cannot read ${file}: ${String(err)}`;
    }
  }
  cache = { mtime, found, cfg, error };
  return { found, path: file, cfg, error };
}

/** One lowercase token, accents folded, punctuation dropped (claude_voice/textutil.norm_word). */
const ACCENTS_FROM = 'ăâîșşțţéèêëàâäôöûüùçÉÈÊËÀÂÄÔÖÛÜÙÇĂÂÎȘŞȚŢ';
const ACCENTS_TO = 'aaisstteeeeaaaoouuucEEEEAAAOOUUUCAAISSTT';
export function normWord(w: string): string {
  let s = '';
  for (const ch of String(w).toLowerCase()) { const i = ACCENTS_FROM.indexOf(ch); s += i >= 0 ? ACCENTS_TO[i] : ch; }
  return s.replace(/[^\p{L}\p{N}_\s]/gu, '');
}

function nameToken(name: string): string {
  const first = String(name || '').trim().split(/\s+/)[0] || '';
  return normWord(first) || 'zam';
}
/** Claude Voice's phrases with its assistant name replaced by Zamolxis's ("go ahead claude" -> "go ahead zam"). */
function renamePhrases(phrases: string[], from: string, to: string): string[] {
  const out: string[] = [];
  for (const p of phrases) {
    const q = from && from !== to ? p.toLowerCase().replace(new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), to) : p;
    if (!out.includes(q)) out.push(q);
  }
  return out;
}

/** The defaults Settings -> Voice starts from: Claude Voice's values, renamed to the wake name. */
export function claudeVoiceDefaults(wakeName = ZAM_DEFAULTS.wakeName): VoiceSettings {
  const { cfg } = loadClaudeVoiceConfig();
  const cvName = nameToken(cfg.wake.name || 'Claude');
  const name = nameToken(wakeName);
  return {
    engine: claudeVoiceEngineAvailability().ok ? 'claudevoice' : 'browser',
    model: cfg.speech.model || 'large-v3',
    languages: (cfg.speech.languages || []).map((l) => String(l).trim().toLowerCase()).filter(Boolean),
    translate: !!cfg.speech.translate_to_english,
    device: cfg.speech.device === 'cpu' ? 'cpu' : 'auto',
    backend: 'auto',
    idleMinutes: ZAM_DEFAULTS.idleMinutes,
    micDevice: String(cfg.mic.device || '').trim(),
    audioCleanup: false,
    wakeEnabled: ZAM_DEFAULTS.wakeEnabled,
    wakeName: name,
    wakeAliases: [...ZAM_DEFAULTS.wakeAliases],
    stopPhrases: renamePhrases(cfg.stop.phrases, cvName, name),
    cancelPhrases: [...cfg.cancel.phrases],
    tts: ZAM_DEFAULTS.tts,
    kokoroVoice: cfg.voice.kokoro_voice || 'af_heart',
    kokoroSpeed: Number(cfg.voice.kokoro_speed) || 1.0,
  };
}

function list(v: unknown, max = 40): string[] | undefined {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\n]/) : null;
  if (!raw) return undefined;
  const out: string[] = [];
  for (const x of raw) {
    const s = String(x).replace(/[<>`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** Validate a (partial) voice settings object from the browser or settings.json; bad fields are dropped. */
export function sanitizeVoiceOverrides(raw: unknown): VoiceOverrides {
  if (!isObj(raw)) return {};
  const o: VoiceOverrides = {};
  if (raw.engine === 'browser' || raw.engine === 'claudevoice') o.engine = raw.engine;
  if (typeof raw.model === 'string' && /^[\w.-]{1,60}$/.test(raw.model.trim())) o.model = raw.model.trim();
  const langs = list(raw.languages, 10);
  if (langs) o.languages = langs.map((l) => l.toLowerCase()).filter((l) => /^[a-z]{2,3}$/.test(l));
  if (typeof raw.translate === 'boolean') o.translate = raw.translate;
  if (raw.device === 'auto' || raw.device === 'cpu') o.device = raw.device;
  if (raw.backend === 'auto' || raw.backend === 'service' || raw.backend === 'sidecar') o.backend = raw.backend;
  if (typeof raw.idleMinutes === 'number' && raw.idleMinutes >= 1) o.idleMinutes = Math.min(240, Math.floor(raw.idleMinutes));
  if (typeof raw.micDevice === 'string') o.micDevice = raw.micDevice.replace(/[<>`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (typeof raw.audioCleanup === 'boolean') o.audioCleanup = raw.audioCleanup;
  if (typeof raw.wakeEnabled === 'boolean') o.wakeEnabled = raw.wakeEnabled;
  if (typeof raw.wakeName === 'string' && normWord(raw.wakeName.trim().split(/\s+/)[0] || '')) o.wakeName = nameToken(raw.wakeName);
  const al = list(raw.wakeAliases); if (al) o.wakeAliases = al.map((a) => normWord(a)).filter(Boolean);
  const sp = list(raw.stopPhrases); if (sp && sp.length) o.stopPhrases = sp;
  const cp = list(raw.cancelPhrases); if (cp && cp.length) o.cancelPhrases = cp;
  if (raw.tts === 'off' || raw.tts === 'browser' || raw.tts === 'kokoro') o.tts = raw.tts;
  if (typeof raw.kokoroVoice === 'string' && /^[a-z]{2}_[a-z0-9_]{1,30}$/i.test(raw.kokoroVoice.trim())) o.kokoroVoice = raw.kokoroVoice.trim();
  if (typeof raw.kokoroSpeed === 'number' && raw.kokoroSpeed >= 0.5 && raw.kokoroSpeed <= 2) o.kokoroSpeed = Math.round(raw.kokoroSpeed * 100) / 100;
  return o;
}

/** Overrides on top of the Claude Voice defaults. */
export function effectiveVoiceSettings(over: VoiceOverrides | undefined): VoiceSettings {
  const o = over ?? {};
  const base = claudeVoiceDefaults(o.wakeName);
  return { ...base, ...o, wakeName: base.wakeName };
}

/** What the browser needs to listen: settings plus Claude Voice's mic/segmentation and phrase rules. */
export function voiceClientConfig(over: VoiceOverrides | undefined) {
  const s = effectiveVoiceSettings(over);
  const { cfg } = loadClaudeVoiceConfig();
  const cvName = nameToken(cfg.wake.name || 'Claude');
  return {
    ...s,
    wakePhrases: renamePhrases(cfg.wake.phrases, cvName, s.wakeName),
    matchRatio: Number(cfg.wake.match_ratio) || 0.8,
    nameAloneAtStart: cfg.wake.name_alone_at_start !== false,
    stopMustEnd: cfg.stop.must_end_utterance !== false,
    timeoutS: Number(cfg.dictation_timeout_s) || 120,
    mic: {
      silenceMs: Number(cfg.mic.silence_ms) || 900,
      minSpeechMs: Number(cfg.mic.min_speech_ms) || 400,
      maxUtteranceS: Number(cfg.mic.max_utterance_s) || 30,
      preRollMs: Number(cfg.mic.pre_roll_ms) || 300,
      speechRatio: Number(cfg.mic.speech_ratio) || 3.0,
      minRms: Number(cfg.mic.min_rms) || 0.002,
    },
    responses: { wake: 'Yes?', stop: cfg.stop.response || '', cancel: cfg.cancel.response || '' },
  };
}

/** Speech settings whisper-server is started with (beam, prompt, no-speech threshold) from Claude Voice. */
export function whisperRuntimeOptions(s: VoiceSettings) {
  const { cfg } = loadClaudeVoiceConfig();
  const cvName = String(cfg.wake.name || 'Claude').trim().split(/\s+/)[0] || 'Claude';
  const display = s.wakeName.charAt(0).toUpperCase() + s.wakeName.slice(1);
  const prompt = String(cfg.speech.initial_prompt || '').replace(new RegExp(`\\b${cvName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), display).trim();
  return {
    beamSize: Math.max(1, Math.min(10, Math.floor(Number(cfg.speech.beam_size) || 5))),
    prompt,
    noSpeechThreshold: Number(cfg.speech.no_speech_threshold) || 0.7,
  };
}

/** whisper models in the Claude Voice models folder ("large-v3", "base", ...), VAD model excluded. */
export function listWhisperModels(): string[] {
  const dir = claudeVoicePaths().modelsDir;
  try {
    return fs.readdirSync(dir)
      .map((f) => /^ggml-(.+)\.bin$/i.exec(f)?.[1])
      .filter((m): m is string => !!m && !/silero|vad/i.test(m))
      .sort();
  } catch {
    return [];
  }
}

/** ggml-<model>.bin in the Claude Voice models folder; a name that would leave that folder is refused. */
export function whisperModelPath(model: string): string {
  const dir = path.resolve(claudeVoicePaths().modelsDir);
  const name = String(model || '');
  const p = path.resolve(dir, `ggml-${name}.bin`);
  if (!/^[\w.-]{1,60}$/.test(name) || path.dirname(p) !== dir) throw new Error(`invalid whisper model name: ${name.slice(0, 60)}`);
  return p;
}

/** Kokoro language letters (claude_voice/tts.KOKORO_LANGS). */
const KOKORO_LANGS: Record<string, string> = {
  a: 'American English', b: 'British English', f: 'French', e: 'Spanish', i: 'Italian', p: 'Portuguese', j: 'Japanese', z: 'Chinese', h: 'Hindi',
};
/** Describe a Kokoro voice id the way Claude Voice does ("af_heart" -> "Heart, female, American English"). */
export function describeKokoroVoice(id: string): string {
  const lang = KOKORO_LANGS[id[0] ?? ''] ?? id[0] ?? '';
  const gender = id[1] === 'f' ? 'female' : id[1] === 'm' ? 'male' : '';
  const name = id.includes('_') ? id.split('_').slice(1).join(' ').replace(/\b\w/g, (c) => c.toUpperCase()) : id;
  return `${name}, ${gender}, ${lang}`;
}
