import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { query, type Options, type PermissionResult, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../../logger.js';
import type { BackendEnv } from './backends.js';
import { resolveClaudeModel } from '../claudeModels.js';

/**
 * Path 2: a Claude Code session (Agent SDK) running IN a project folder, for jobs that need code.
 * Same engine as the chat's Claude tier, but with cwd = the project, a worker role, the Laws, the
 * engine's permission gate, and any backend (Claude subscription, free provider, local Ollama).
 * When the folder is a git repo, `git status` before and after tells which files changed.
 */

/** Outcome of one delegated run (shared by the code runner and the CLI runner). */
export interface DelegateRunResult {
  ok: boolean;
  /** The worker's final answer (or the error). */
  summary: string;
  /** Files the run created/modified/deleted (repo-relative when the folder is a git repo). */
  filesChanged: string[];
  /** Short `git diff --stat` summary line, when available. */
  diffStat?: string;
  costUsd: number;
  backend: string;
  model?: string;
  durationMs: number;
  /** The run ended without finishing (max turns, or the worker said it could not complete). */
  incomplete?: boolean;
  /** The run was aborted (Stop, the parent turn's abort or timeout): never retried. */
  stopped?: boolean;
  /** Token usage per model as reported by the engine (for usage accounting). */
  modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; costUSD?: number }>;
}

export interface CodeTaskOptions {
  task: string;
  /** Resolved, allowed project folder. */
  folder: string;
  backend: BackendEnv;
  maxTurns: number;
  timeoutMs: number;
  permissionMode: Options['permissionMode'];
  disallowedTools?: string[];
  /** Laws block + worker role, appended to the claude_code preset prompt. */
  append: string;
  /** Permission gate (the engine's decideToolUse with a code:<folder> scope). */
  canUseTool: (toolName: string, input: Record<string, unknown>) => Promise<PermissionResult>;
  /** Aborts the run (Stop, parent abort, timeout). */
  abortController: AbortController;
  /** Short status lines ("editing src/x.ts"). */
  onProgress?: (line: string) => void;
}

// ── git helpers ──

let GIT: string | null | undefined;
/** Resolve a usable git (PATH first, then the usual Windows install locations). */
function gitBin(): string | null {
  if (GIT !== undefined) return GIT;
  const cands = ['git'];
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const la = process.env['LOCALAPPDATA'] || '';
    cands.push(path.join(pf, 'Git', 'cmd', 'git.exe'), path.join(pf, 'Git', 'bin', 'git.exe'));
    if (la) cands.push(path.join(la, 'Programs', 'Git', 'cmd', 'git.exe'));
  }
  GIT = null;
  for (const c of cands) {
    try {
      if (spawnSync(c, ['--version'], { stdio: 'ignore', windowsHide: true }).status === 0) {
        GIT = c;
        break;
      }
    } catch {
      /* try next */
    }
  }
  return GIT;
}

function git(cwd: string, args: string[]): Promise<string | null> {
  const bin = gitBin();
  if (!bin) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(bin, ['-C', cwd, ...args], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

/** `git status --porcelain` as path -> status code, plus each dirty file's mtime (to catch further
 *  edits to a file that was already dirty before the run). Null when not a repo. */
async function gitSnapshot(folder: string): Promise<{ root: string; files: Map<string, string> } | null> {
  const root = (await git(folder, ['rev-parse', '--show-toplevel']))?.trim();
  if (!root) return null;
  // -z: NUL-separated and unquoted, so names with spaces, quotes or non-ASCII characters come back
  // verbatim; a rename/copy entry ("R  new\0old\0") carries the old path as an extra field.
  const out = await git(folder, ['status', '--porcelain', '-z', '--untracked-files=all']);
  if (out === null) return null;
  const files = new Map<string, string>();
  const entries = out.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const line = entries[i]!;
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    const p = line.slice(3);
    if (/[RC]/.test(code)) i++; // skip the rename/copy source path
    let stamp = '';
    try {
      stamp = String(fs.statSync(path.join(root, p)).mtimeMs);
    } catch {
      stamp = 'gone';
    }
    files.set(p, `${code}|${stamp}`);
  }
  return { root, files };
}

/** Short summary of a tool call for progress lines. */
function describeTool(name: string, input: Record<string, unknown>, folder: string): string {
  const rel = (p: unknown): string => {
    const s = typeof p === 'string' ? p : '';
    if (!s) return '';
    const r = path.isAbsolute(s) ? path.relative(folder, s) : s;
    return r && !r.startsWith('..') ? r : s;
  };
  switch (name) {
    case 'Edit':
    case 'MultiEdit':
      return `editing ${rel(input.file_path)}`;
    case 'Write':
      return `writing ${rel(input.file_path)}`;
    case 'Read':
      return `reading ${rel(input.file_path)}`;
    case 'NotebookEdit':
      return `editing ${rel(input.notebook_path)}`;
    case 'Bash':
      return `running ${String(input.command ?? '').split('\n')[0]!.slice(0, 80)}`;
    case 'Grep':
    case 'Glob':
      return `searching ${String(input.pattern ?? '').slice(0, 60)}`;
    case 'WebSearch':
      return `searching the web for ${String(input.query ?? '').slice(0, 60)}`;
    case 'WebFetch':
      return `fetching ${String(input.url ?? '').slice(0, 80)}`;
    default:
      return `using ${name}`;
  }
}

/** Did the worker's final answer say it could not finish? (drives escalation to Claude) */
export function reportsIncomplete(text: string): boolean {
  const t = (text || '').trim();
  if (!t) return true;
  // Models often write the typographic apostrophe (U+2019) in "couldn't" and "can't".
  return /\b(i (could not|couldn['’]?t|was unable to|am unable to|cannot|can['’]?t) (complete|finish|do|make|implement|fix|find|create|write|edit|modify|save|run|access)|unable to (complete|finish)|did not (complete|finish)|not (able|possible) to (complete|finish))\b/i.test(t.slice(0, 1500));
}

/** Run one code task in its project folder. Never throws; failures come back as ok:false. */
export async function runCodeTask(o: CodeTaskOptions): Promise<DelegateRunResult> {
  const started = Date.now();
  const before = await gitSnapshot(o.folder);
  const touched = new Set<string>(); // files the worker wrote, for folders that aren't git repos
  const timeout = setTimeout(() => o.abortController.abort(), o.timeoutMs);
  timeout.unref?.();

  let endInput!: () => void;
  const inputDone = new Promise<void>((resolve) => {
    endInput = resolve;
  });
  // Streaming-input mode keeps the control channel open for canUseTool callbacks (as in the engine).
  async function* inputStream(): AsyncGenerator<SDKUserMessage> {
    yield { type: 'user', message: { role: 'user', content: o.task }, parent_tool_use_id: null, session_id: '' };
    await inputDone;
  }

  const options: Options = {
    model: o.backend.backend === 'claude' ? resolveClaudeModel(o.backend.model) : o.backend.model,
    abortController: o.abortController,
    cwd: o.folder,
    // Only the project's own CLAUDE.md / .claude settings. The user's plugins, hooks, MCP servers,
    // env and pre-approved permissions would bloat every run and could override the backend or
    // Privacy Mode.
    settingSources: ['project'],
    permissionMode: o.permissionMode,
    disallowedTools: o.disallowedTools,
    canUseTool: (toolName: string, input: Record<string, unknown>) => o.canUseTool(toolName, input),
    maxTurns: o.maxTurns,
    persistSession: false,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: o.append },
    env: o.backend.env,
    stderr: (d) => {
      const t = d.trim();
      if (t) logger.warn({ cc: t.slice(0, 500), backend: o.backend.backend }, 'code-runner stderr');
    },
  };

  let summary = '';
  let ok = false;
  let incomplete = false;
  let costUsd = 0;
  let modelUsage: DelegateRunResult['modelUsage'];
  let lastProgress = 0;
  try {
    for await (const msg of query({ prompt: inputStream(), options })) {
      if (msg.type === 'assistant') {
        const content = (msg as { message?: { content?: unknown } }).message?.content;
        if (!Array.isArray(content)) continue;
        for (const b of content) {
          const blk = b as { type?: string; name?: string; input?: Record<string, unknown> };
          if (blk?.type !== 'tool_use' || typeof blk.name !== 'string') continue;
          const input = blk.input ?? {};
          if (/^(Edit|MultiEdit|Write)$/.test(blk.name) && typeof input.file_path === 'string') touched.add(input.file_path);
          if (blk.name === 'NotebookEdit' && typeof input.notebook_path === 'string') touched.add(input.notebook_path);
          // At most one status line every 2 seconds per run, so a busy worker doesn't flood the chat.
          if (o.onProgress && Date.now() - lastProgress > 2000) {
            lastProgress = Date.now();
            o.onProgress(describeTool(blk.name, input, o.folder));
          }
        }
      } else if (msg.type === 'result') {
        endInput();
        costUsd = o.backend.backend === 'claude' ? msg.total_cost_usd || 0 : 0;
        modelUsage = msg.modelUsage as DelegateRunResult['modelUsage'];
        if (msg.subtype === 'success') {
          summary = msg.result;
          ok = !msg.is_error;
          incomplete = reportsIncomplete(summary);
        } else {
          ok = false;
          incomplete = true;
          summary = `(${msg.subtype})${'errors' in msg && msg.errors?.length ? ': ' + msg.errors.join('; ') : ''}`;
        }
      }
    }
  } catch (err) {
    endInput();
    const aborted = o.abortController.signal.aborted;
    logger.warn({ err: String(err), folder: o.folder, backend: o.backend.backend }, 'code run failed');
    summary = aborted ? 'The run was stopped (timeout or Stop).' : `The run failed: ${String(err).slice(0, 400)}`;
    ok = false;
    incomplete = true;
  } finally {
    clearTimeout(timeout);
    endInput(); // also when the stream ended without a result, so the input generator can finish
  }

  // Changed files: git before/after when it's a repo, plus whatever the worker wrote directly.
  const filesChanged = new Set<string>();
  let diffStat: string | undefined;
  const after = before ? await gitSnapshot(o.folder) : null;
  if (before && after) {
    for (const [p, sig] of after.files) if (before.files.get(p) !== sig) filesChanged.add(p);
    for (const p of before.files.keys()) if (!after.files.has(p)) filesChanged.add(p); // reverted / committed
    const stat = await git(o.folder, ['diff', '--shortstat']);
    diffStat = stat?.trim() || undefined;
  }
  for (const f of touched) {
    const abs = path.isAbsolute(f) ? f : path.join(o.folder, f);
    if (!fs.existsSync(abs)) continue; // the write was denied or failed: nothing changed there
    const base = after?.root ?? o.folder;
    const rel = path.relative(base, abs).split(path.sep).join('/');
    filesChanged.add(rel && !rel.startsWith('..') ? rel : abs);
  }

  return {
    ok,
    summary: summary || '(no answer)',
    filesChanged: [...filesChanged].sort(),
    diffStat,
    costUsd,
    backend: o.backend.backend,
    model: o.backend.model,
    durationMs: Date.now() - started,
    incomplete,
    modelUsage,
  };
}
