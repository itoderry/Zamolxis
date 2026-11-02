import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { ZamolxisConfig } from '../../config.js';
import type { MemoryManager } from '../memory.js';
import type { RunHistory } from '../runHistory.js';
import type { BanStore } from '../bans.js';
import type { UsageTracker } from '../usage.js';
import { Throttle } from '../throttle.js';
import { effectiveName } from '../displayName.js';
import { logger } from '../../logger.js';
import { availableBackends, backendEnv, strongFreeProviders, type BackendEnv, type BackendPref, type BackendStatus, type CodeBackend } from './backends.js';
import { runCodeTask, type DelegateRunResult } from './codeRunner.js';
import { runCliTask, resolveClaude } from './cliRunner.js';
import { codeModelAdvice, proposalText } from './localCodeModel.js';

/**
 * The delegation orchestrator: Zamolxis hands jobs to Claude Code as a worker.
 *
 * Per subtask it decides
 *   1. the PATH: a job that needs code -> path 2 (SDK code runner in the project folder);
 *      anything else -> path 3 (the claude CLI, headless, read/research tools only);
 *   2. the BACKEND: Privacy Mode -> local only; code / complex jobs -> Claude; small general jobs
 *      -> a free provider, else a capable local model, else Claude (honouring bans, a pinned
 *      backend and the Settings default);
 *   3. ESCALATION: an automatically chosen free/local run that errors or says it could not
 *      finish is retried once on Claude (never in Privacy Mode).
 * Independent subtasks run in parallel through a dedicated throttle (so delegated runs never take
 * the chat's slots and nested runs cannot deadlock); two code subtasks on one folder run in turn.
 */

export type TaskKind = 'auto' | 'code' | 'general';

export interface DelegateTaskSpec {
  task: string;
  /** Project folder (must be in Settings -> Code allowed folders). */
  folder?: string;
  kind?: TaskKind;
  backend?: BackendPref;
  model?: string;
}

/** Where the delegation was requested from (permissions, progress, Stop). */
export interface DelegateContext {
  conversationKey: string;
  channel: string;
  chatId: string;
  /** Streams status lines into the chat. */
  onProgress?: (chunk: string) => void;
  /** Abort signal of the requesting turn when it is not a registered Claude turn (the local /
   *  free-provider tool loop): its timeout then also stops the delegated runs. */
  signal?: AbortSignal;
}

/** The engine-side hooks the orchestrator needs (implemented by Engine). */
export interface CodeHost {
  decideToolUse(
    toolName: string,
    input: Record<string, unknown>,
    ctx: { conversationKey: string; channel: string; chatId: string; agent?: string; skill?: string; scope?: string },
  ): Promise<PermissionResult>;
  /** Register a delegated run so Stop / the parent turn's abort also stop it. Returns the untrack fn. */
  trackDelegatedRun(key: string, ac: AbortController, parentKey?: string): () => void;
  /** One cheap model call (fast Claude model) for the ambiguous code/general classification. */
  classifyOneShot?(system: string, prompt: string): Promise<string>;
}

export interface OrchestratorDeps {
  config: ZamolxisConfig;
  memory: MemoryManager;
  host: CodeHost;
  runs?: RunHistory;
  bans?: BanStore;
  usage?: UsageTracker;
}

export type RunPath = 'code' | 'cli';

export interface SubtaskResult extends DelegateRunResult {
  index: number;
  task: string;
  path: RunPath;
  folder?: string;
  label: string;
  /** Backend label of a first attempt that could not finish (the result is from the Claude retry). */
  escalatedFrom?: string;
  /** Refused before running (folder not allowed, no backend, ...). */
  refused?: boolean;
  /** A suggestion for the user, e.g. a better local coding model to load. */
  proposal?: string;
}

const MAX_SUBTASKS = 8;

// ── Allowed project folders ──

/** The folders path-2 runs may use: the Settings list, or the work dir when the list is empty. */
export function allowedFolders(config: ZamolxisConfig): string[] {
  const list = config.codeFolders && config.codeFolders.length ? config.codeFolders : [config.workDir];
  return [...new Set(list.map((p) => path.resolve(p)))];
}

/** Serialization key for code runs: the git work tree that contains the folder, else the folder. */
function repoKey(folder: string): string {
  try {
    const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: folder, encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const top = r.status === 0 ? (r.stdout || '').trim() : '';
    if (top) return pathKey(top);
  } catch {
    /* no git, or the folder does not exist yet */
  }
  return pathKey(folder);
}

/** Comparable form of a path: resolved, symlinks/junctions followed (for a path that does not exist
 *  yet, those of its nearest existing ancestor, so a missing folder under a junction that points
 *  elsewhere is caught BEFORE it is created), no trailing separator, case-folded on Windows. */
function pathKey(p: string): string {
  let r = path.resolve(p);
  const rest: string[] = [];
  let cur = r;
  for (;;) {
    try {
      cur = fs.realpathSync.native(cur);
      r = rest.length ? path.join(cur, ...rest) : cur;
      break;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) break; // nothing exists: keep the lexical form
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
  const parsed = path.parse(r);
  if (r !== parsed.root) r = r.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/** Is `target` the root itself or strictly inside it? (A sibling sharing a prefix is NOT inside.) */
export function isInside(root: string, target: string): boolean {
  const r = pathKey(root);
  const t = pathKey(target);
  if (t === r) return true;
  const withSep = r.endsWith(path.sep) ? r : r + path.sep;
  return t.startsWith(withSep);
}

/** Resolve a requested folder against the allowed list. Relative paths resolve against the first
 *  allowed folder; a missing folder inside an allowed one is created. */
export function resolveAllowedFolder(config: ZamolxisConfig, folder?: string): { ok: true; folder: string } | { ok: false; reason: string } {
  const allowed = allowedFolders(config);
  const base = allowed[0]!;
  const want = folder && folder.trim() ? (path.isAbsolute(folder.trim()) ? path.resolve(folder.trim()) : path.resolve(base, folder.trim())) : base;
  if (!allowed.some((a) => isInside(a, want))) {
    return { ok: false, reason: `The folder "${want}" is not an allowed project folder. Add it in Settings -> Code (allowed: ${allowed.join('; ')}).` };
  }
  try {
    if (!fs.existsSync(want)) fs.mkdirSync(want, { recursive: true });
    if (!fs.statSync(want).isDirectory()) return { ok: false, reason: `"${want}" is not a folder.` };
  } catch (err) {
    return { ok: false, reason: `Cannot use "${want}": ${String(err)}` };
  }
  // Re-check after resolving junctions/symlinks so a link inside an allowed folder can't escape it.
  if (!allowed.some((a) => isInside(a, want))) return { ok: false, reason: `"${want}" resolves outside the allowed project folders.` };
  return { ok: true, folder: want };
}

/** The target of a file-writing tool call when it resolves outside the project folder, else null.
 *  Relative paths resolve against the folder (the worker's cwd). */
export function writeOutsideFolder(toolName: string, input: Record<string, unknown>, folder: string): string | null {
  if (!/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(toolName)) return null;
  const p = input.file_path ?? input.notebook_path;
  if (typeof p !== 'string' || !p.trim()) return null;
  const abs = path.resolve(folder, p.trim());
  return isInside(folder, abs) ? null : abs;
}

// ── Path heuristics ──

const CODE_RX =
  /\b(fix(es|ing)?|refactor\w*|implement\w*|compile\w*|build (the|a|it|this)|unit ?tests?|run (the )?tests?|write (a |the )?(script|function|class|test|module|code|program)|add (a |an )?(function|method|endpoint|test|feature|flag|option|route|column)|commit|push|merge|rebase|branch|pull request|\bpr\b|debug\w*|stack ?trace|lint\w*|type ?errors?|tsc|npm|pnpm|yarn|pip|cargo|gradle|maven|dotnet|repo(sitory)?|codebase|source code|function|class|bug|regression|patch|migrat\w*|rename (the )?(function|variable|class|file)|edit (the )?file|create (a )?file|scaffold\w*)\b/i;
const FILE_RX = /(^|[\s"'`(])((\.{0,2}[\\/])?[\w.-]+[\\/])*[\w-]+\.(ts|tsx|js|jsx|mjs|cjs|py|cs|java|go|rs|rb|php|cpp|cc|c|h|hpp|kt|swift|sql|sh|ps1|bat|json|ya?ml|toml|csproj|sln|html|css|scss|vue|svelte)\b/i;
const GENERAL_RX =
  /\b(research|summari[sz]e|summary|explain|what is|what are|who (is|was)|compare|comparison|pros and cons|find out|look up|draft|translate|brainstorm|outline|write (an? |the )?(email|post|essay|article|letter|report|blog|tweet|summary|description)|proofread|recommend\w*|analy[sz]e (the )?(market|trends?|news|article|text))\b/i;

/** Heuristic scores; null when ambiguous (both or neither). */
function heuristicKind(spec: DelegateTaskSpec): 'code' | 'general' | null {
  const t = spec.task || '';
  let code = 0;
  let general = 0;
  if (spec.folder && spec.folder.trim()) code += 2;
  if (t.includes('```')) code += 2;
  if (FILE_RX.test(t)) code += 1;
  if (CODE_RX.test(t)) code += 1;
  if (GENERAL_RX.test(t)) general += 1;
  if (code > general) return 'code';
  if (general > code) return 'general';
  return null;
}

/** "Complex" general jobs go to Claude rather than a free/local model. */
function looksComplex(task: string): boolean {
  const t = task || '';
  if (t.length > 700) return true;
  if ((t.match(/^\s*(\d+[.)]|[-*])\s+/gm) ?? []).length >= 4) return true; // a long step list
  return /\b(multi-?file|across (the )?(whole|entire)|entire (repo|codebase|project)|architecture|in-?depth|comprehensive|thorough(ly)?|step[- ]by[- ]step plan)\b/i.test(t);
}

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

export class Orchestrator {
  private throttleInst?: Throttle;
  private throttleSize = 0;
  /** Per-folder tails: code subtasks on the same folder run one after another. */
  private readonly folderTails = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: OrchestratorDeps) {}

  /** The delegated-run throttle (separate from the chat's), rebuilt when the setting changes. */
  private codeThrottle(): Throttle {
    const n = Math.max(1, Math.floor(this.deps.config.codeMaxParallel || 3));
    if (!this.throttleInst || this.throttleSize !== n) {
      this.throttleInst = new Throttle(n);
      this.throttleSize = n;
    }
    return this.throttleInst;
  }

  allowedFolders(): string[] {
    return allowedFolders(this.deps.config);
  }

  /** Decide code vs general: explicit kind, then the heuristic, then one cheap classification. */
  private async decideKind(spec: DelegateTaskSpec): Promise<'code' | 'general'> {
    if (spec.kind === 'code' || spec.kind === 'general') return spec.kind;
    const h = heuristicKind(spec);
    if (h) return h;
    const { config } = this.deps;
    if (!config.privacyMode && this.deps.host.classifyOneShot) {
      try {
        const raw = await this.deps.host.classifyOneShot(
          'You classify a job that will be delegated to a worker. Output ONLY a JSON object {"kind":"code"} when doing the job requires reading, changing, building or running code or files in a software project, otherwise {"kind":"general"}.',
          `Job:\n${spec.task.slice(0, 3000)}\n\nJSON:`,
        );
        const m = /"kind"\s*:\s*"(code|general)"/.exec(raw || '');
        if (m) return m[1] as 'code' | 'general';
      } catch (err) {
        logger.warn({ err: String(err) }, 'delegate: classification failed');
      }
    }
    return 'general';
  }

  /** First strong free provider (with quota) not banned from these capabilities. */
  private freeProviderFor(caps: string[]): string | undefined {
    const bans = this.deps.bans;
    return strongFreeProviders().find((p) => !bans || !caps.some((c) => bans.isBanned(p.id, c)))?.id;
  }

  /** Is a backend banned for this capability? (bans are per model token: 'local' or a provider id;
   *  the smartest model, Claude, can never be banned). */
  private banned(status: BackendStatus, caps: string[]): boolean {
    const bans = this.deps.bans;
    if (!bans || status.id === 'claude') return false;
    if (status.id === 'free') return !this.freeProviderFor(caps);
    return caps.some((c) => bans.isBanned('local', c));
  }

  /** Pick the backend for one subtask. `auto` = chosen here (so escalation may retry on Claude). */
  private pickBackend(spec: DelegateTaskSpec, kind: 'code' | 'general', statuses: BackendStatus[], caps: string[]): { backend: CodeBackend; auto: boolean; providerId?: string } | { error: string } {
    const r = this.pickBackendId(spec, kind, statuses, caps);
    return 'error' in r || r.backend !== 'free' ? r : { ...r, providerId: this.freeProviderFor(caps) };
  }

  private pickBackendId(spec: DelegateTaskSpec, kind: 'code' | 'general', statuses: BackendStatus[], caps: string[]): { backend: CodeBackend; auto: boolean } | { error: string } {
    const { config } = this.deps;
    const st = (id: CodeBackend): BackendStatus => statuses.find((s) => s.id === id) ?? { id, usable: false, reason: 'unknown' };
    const usable = (id: CodeBackend): boolean => st(id).usable && !this.banned(st(id), caps);
    const why = (id: CodeBackend): string => (this.banned(st(id), caps) ? `banned from ${caps[0]}` : st(id).reason || 'not available');
    const pinned = spec.backend && spec.backend !== 'auto' ? spec.backend : undefined;

    if (config.privacyMode) {
      if (pinned && pinned !== 'local') return { error: `Privacy Mode is on, so delegated runs stay on the local model (the ${pinned} backend was requested).` };
      return usable('local') ? { backend: 'local', auto: false } : { error: `Privacy Mode is on and the local backend is not usable: ${why('local')}.` };
    }
    if (pinned) return usable(pinned) ? { backend: pinned, auto: false } : { error: `The ${pinned} backend is not usable: ${why(pinned)}.` };
    const pref = config.codeDefaultBackend;
    if (pref && pref !== 'auto' && usable(pref)) return { backend: pref, auto: true };

    const localCapable = usable('local') && !st('local').lowContext;
    const complex = kind === 'code' || looksComplex(spec.task);
    const order: CodeBackend[] = complex ? ['claude', 'free', 'local'] : ['free', 'local', 'claude'];
    for (const id of order) {
      if (id === 'local' ? localCapable : usable(id)) return { backend: id, auto: true };
    }
    if (usable('local')) return { backend: 'local', auto: true }; // last resort, despite a small context
    return { error: `No model backend is usable right now: ${(['claude', 'free', 'local'] as CodeBackend[]).map((id) => `${id} (${why(id)})`).join(', ')}.` };
  }

  /** Worker role appended to the claude_code preset prompt (plus the Laws). */
  private workerPrompt(p: RunPath, folder?: string): string {
    const { config } = this.deps;
    const laws = config.lawsEnabled ? this.deps.memory.lawsBlock() : '';
    const who = effectiveName(config.agentName);
    const role =
      p === 'code'
        ? `YOU ARE A CODING WORKER that ${who} delegated a job to. Work only inside the project folder ${folder}. Do the job completely, verify it where you reasonably can (build/tests), and do not commit, push or delete branches unless the job says so. Finish with a short report: what you changed (files), how you verified it, and anything left undone. If you could not finish, say so plainly and say what is missing.`
        : `YOU ARE A RESEARCH AND ANALYSIS WORKER that ${who} delegated a job to. You cannot edit files or run commands; use reading and web research only. Answer the job fully and concisely, cite sources for facts you looked up, and if you could not finish, say so plainly and say what is missing.`;
    return [laws, role].filter(Boolean).join('\n\n');
  }

  /** Run one attempt of a subtask on a backend (inside the throttle). */
  private async execute(spec: DelegateTaskSpec, p: RunPath, folder: string | undefined, benv: BackendEnv, ctx: DelegateContext, prefix: string): Promise<DelegateRunResult> {
    const { config, host } = this.deps;
    const ac = new AbortController();
    const key = `code:${randomUUID()}`;
    const untrack = host.trackDelegatedRun(key, ac, ctx.conversationKey);
    const onParentAbort = (): void => ac.abort();
    if (ctx.signal?.aborted) ac.abort();
    else ctx.signal?.addEventListener('abort', onParentAbort, { once: true });
    const agent = ctx.conversationKey.startsWith('agent:') ? ctx.conversationKey.slice('agent:'.length) : undefined;
    const onProgress = ctx.onProgress ? (line: string): void => ctx.onProgress!(`(${prefix} on ${benv.label}: ${line})\n`) : undefined;
    onProgress?.(p === 'code' ? `starting in ${folder}` : 'starting');
    let r: DelegateRunResult;
    try {
      r =
        p === 'code'
          ? await runCodeTask({
              task: spec.task,
              folder: folder!,
              backend: benv,
              maxTurns: config.codeMaxTurns,
              timeoutMs: config.turnTimeoutMs,
              permissionMode: config.permissionMode,
              disallowedTools: config.disallowedTools,
              append: this.workerPrompt('code', folder),
              canUseTool: (toolName, input) => {
                // The file tools stay inside the project folder whatever the permission posture
                // (acceptEdits/bypass would otherwise let a worker write anywhere on the disk).
                const outside = writeOutsideFolder(toolName, input, folder!);
                if (outside) return Promise.resolve({ behavior: 'deny', message: `${toolName} on ${outside} is outside the project folder ${folder}; work only inside it.` });
                return host.decideToolUse(toolName, input, { conversationKey: ctx.conversationKey, channel: ctx.channel, chatId: ctx.chatId, agent, scope: `code:${folder}` });
              },
              abortController: ac,
              onProgress,
            })
          : await runCliTask({
              task: spec.task,
              folder,
              scratchRoot: path.join(config.dataDir, 'code-scratch'),
              backend: benv,
              maxTurns: config.codeMaxTurns,
              timeoutMs: config.turnTimeoutMs,
              append: this.workerPrompt('cli'),
              abortController: ac,
              onProgress,
              disallowedTools: config.disallowedTools,
            });
    } finally {
      untrack();
      ctx.signal?.removeEventListener('abort', onParentAbort);
    }
    if (ac.signal.aborted) r = { ...r, stopped: true };
    if (benv.backend === 'claude') this.deps.usage?.recordEngine(r.modelUsage, r.costUsd);
    else if (r.modelUsage) {
      const mu: Record<string, { inputTokens?: number; outputTokens?: number; costUSD?: number }> = {};
      for (const [m, u] of Object.entries(r.modelUsage)) mu[`code:${benv.backend}:${m}`] = { inputTokens: u.inputTokens, outputTokens: u.outputTokens, costUSD: 0 };
      this.deps.usage?.recordEngine(mu, 0);
    }
    this.deps.runs?.append({
      agent: agent ?? (p === 'code' ? 'claude-code' : 'claude-cli'),
      durationMs: r.durationMs,
      ok: r.ok && !r.incomplete,
      costUsd: r.costUsd,
      via: benv.label,
      origin: p,
      reply: `${spec.task.slice(0, 80)} -> ${r.summary}`,
    });
    return r;
  }

  /** Decide, run (with folder serialization + throttle) and possibly escalate one subtask. */
  private async runOne(spec: DelegateTaskSpec, index: number, total: number, ctx: DelegateContext, statuses: BackendStatus[], force?: RunPath): Promise<SubtaskResult> {
    const { config } = this.deps;
    const kind = force ? (force === 'code' ? 'code' : 'general') : await this.decideKind(spec);
    const p: RunPath = kind === 'code' ? 'code' : 'cli';
    const base = { index, task: spec.task, path: p, filesChanged: [] as string[], costUsd: 0, durationMs: 0 };
    const refuse = (summary: string, label = '-'): SubtaskResult => ({ ...base, ok: false, refused: true, summary, backend: '-', label });

    let folder: string | undefined;
    if (p === 'code' || (spec.folder && spec.folder.trim())) {
      const f = resolveAllowedFolder(config, spec.folder);
      if (!f.ok) return refuse(f.reason);
      folder = f.folder;
    }
    if (p === 'cli' && !resolveClaude()) return refuse('The claude CLI is not installed or not found, so this non-code job cannot run. Install Claude Code and log in (`claude auth login`).');

    const caps = ['delegate_task', p === 'code' ? 'claude_code' : 'claude_cli'];
    const pick = this.pickBackend(spec, kind, statuses, caps);
    if ('error' in pick) return refuse(pick.error);
    const benv = backendEnv(config, pick.backend, { model: spec.model, providerId: pick.providerId });
    if ('error' in benv) return refuse(`The ${pick.backend} backend cannot run: ${benv.error}.`);

    const prefix = total > 1 ? `subtask ${index + 1}/${total}` : p === 'code' ? 'claude_code' : 'claude_cli';
    const attempt = (env: BackendEnv): Promise<DelegateRunResult> => {
      const go = (): Promise<DelegateRunResult> => this.codeThrottle().run(() => this.execute(spec, p, folder, env, ctx, prefix));
      if (p !== 'code' || !folder) return go();
      // Code subtasks in the same repo (or, outside git, the same folder) run one after another,
      // queued before taking a throttle slot, so their edits and changed-file lists can't mix.
      const k = repoKey(folder);
      const prev = this.folderTails.get(k) ?? Promise.resolve();
      const run = prev.catch(() => {}).then(go);
      const tail = run.then(() => {}, () => {});
      this.folderTails.set(k, tail);
      void tail.then(() => {
        if (this.folderTails.get(k) === tail) this.folderTails.delete(k);
      });
      return run;
    };

    let r = await attempt(benv);
    let label = benv.label;
    let escalatedFrom: string | undefined;
    const claudeOk = statuses.find((s) => s.id === 'claude')?.usable;
    // A stopped run (Stop / parent abort) is not "could not finish": retrying it would start a new
    // run the user just cancelled.
    if (pick.auto && benv.backend !== 'claude' && (!r.ok || r.incomplete) && !r.stopped && !config.privacyMode && claudeOk) {
      const cenv = backendEnv(config, 'claude', { model: spec.model });
      if (!('error' in cenv)) {
        ctx.onProgress?.(`(${prefix}: ${benv.label} could not finish, retrying on ${cenv.label})\n`);
        logger.info({ index, from: benv.label }, 'delegate: escalating subtask to Claude');
        escalatedFrom = benv.label;
        const first = r;
        r = await attempt(cenv);
        r = { ...r, costUsd: r.costUsd + first.costUsd, durationMs: r.durationMs + first.durationMs, filesChanged: [...new Set([...first.filesChanged, ...r.filesChanged])].sort() };
        label = cenv.label;
      }
    }
    ctx.onProgress?.(`(${prefix}: ${r.ok && !r.incomplete ? 'done' : 'finished with problems'} on ${label}, ${fmtDur(r.durationMs)})\n`);
    // A code job chosen to run on the local backend (or forced there, e.g. Privacy Mode) with a weak
    // coder: suggest a better model the user can load. Never blocks the run.
    let proposal: string | undefined;
    if (p === 'code' && benv.backend === 'local') {
      try {
        const loc = statuses.find((s) => s.id === 'local');
        const advice = codeModelAdvice(config, loc?.installed);
        if (advice.current === benv.model) proposal = proposalText(advice) || undefined;
      } catch (err) {
        logger.warn({ err: String(err) }, 'delegate: code model advice failed');
      }
    }
    return { ...r, index, task: spec.task, path: p, folder, label, escalatedFrom, ...(proposal ? { proposal } : {}) };
  }

  /** Delegate one or more subtasks (run in parallel) and return the per-subtask results. */
  async delegate(tasks: DelegateTaskSpec[], ctx: DelegateContext, force?: RunPath): Promise<SubtaskResult[]> {
    const list = (tasks ?? []).filter((t) => t && typeof t.task === 'string' && t.task.trim()).slice(0, MAX_SUBTASKS);
    if (!list.length) return [];
    const statuses = await availableBackends(this.deps.config);
    if (list.length > 1) ctx.onProgress?.(`(delegating ${list.length} subtasks in parallel, up to ${this.deps.config.codeMaxParallel} at a time)\n`);
    return Promise.all(
      list.map((spec, i) =>
        this.runOne(spec, i, list.length, ctx, statuses, force).catch((err): SubtaskResult => {
          logger.warn({ err: String(err) }, 'delegate: subtask crashed');
          return { index: i, task: spec.task, path: force ?? 'cli', ok: false, summary: `Internal error: ${String(err)}`, filesChanged: [], costUsd: 0, backend: '-', durationMs: 0, label: '-' };
        }),
      ),
    );
  }

  /** delegate() plus one aggregated reply: per subtask the path, backend, model, outcome, files, cost. */
  async delegateText(tasks: DelegateTaskSpec[], ctx: DelegateContext, force?: RunPath): Promise<string> {
    if (tasks && tasks.length > MAX_SUBTASKS) ctx.onProgress?.(`(only the first ${MAX_SUBTASKS} subtasks are run)\n`);
    const results = await this.delegate(tasks, ctx, force);
    if (!results.length) return 'Nothing to delegate: give at least one non-empty task.';
    return formatResults(results);
  }
}

/** One readable block per subtask. */
export function formatResults(results: SubtaskResult[]): string {
  const one = (r: SubtaskResult): string => {
    const tool = r.path === 'code' ? 'claude_code' : 'claude_cli';
    const outcome = r.refused ? 'refused' : r.ok && !r.incomplete ? 'done' : r.ok ? 'incomplete' : 'failed';
    const head = [
      tool,
      r.refused ? undefined : r.label,
      r.escalatedFrom ? `retried after ${r.escalatedFrom} could not finish` : undefined,
      outcome,
      r.refused ? undefined : fmtDur(r.durationMs),
      r.costUsd > 0 ? `$${r.costUsd.toFixed(4)}` : undefined,
    ]
      .filter(Boolean)
      .join(' | ');
    const lines = [`[${head}]`];
    if (r.folder) lines.push(`Folder: ${r.folder}`);
    if (r.filesChanged.length) lines.push(`Files changed (${r.filesChanged.length}): ${r.filesChanged.slice(0, 40).join(', ')}${r.filesChanged.length > 40 ? ', ...' : ''}`);
    else if (r.path === 'code' && !r.refused) lines.push('Files changed: none');
    if (r.diffStat) lines.push(`Diff: ${r.diffStat}`);
    const s = (r.summary || '').trim();
    lines.push('', s.length > 6000 ? s.slice(0, 6000) + '\n...(truncated)' : s);
    if (r.proposal) lines.push('', r.proposal);
    return lines.join('\n');
  };
  if (results.length === 1) return one(results[0]!);
  const okN = results.filter((r) => r.ok && !r.incomplete && !r.refused).length;
  return `Delegated ${results.length} subtasks (${okN} done):\n\n` + results.map((r) => `### Subtask ${r.index + 1}: ${r.task.split('\n')[0]!.slice(0, 100)}\n${one(r)}`).join('\n\n');
}
