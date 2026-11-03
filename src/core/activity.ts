/**
 * Live work feedback for one turn: structured activity events (what the engine is doing right
 * now: the model it asked, each tool call, delegated subtasks, retries) and the finish report
 * built from them. Channels that can show them (the web UI) get the events as they happen;
 * every turn gets the report, so agent runs and the runs ledger can show it too.
 */

export type ActivityKind = 'start' | 'model' | 'tool' | 'tool_done' | 'subtask' | 'note' | 'retry' | 'plan' | 'folder';

/** A delegated subtask's state, carried by 'subtask' events. */
export interface SubtaskActivity {
  index: number;
  total: number;
  path: 'code' | 'cli';
  /** Backend label, e.g. "Claude (sonnet)" or "Local (qwen3-coder:30b)". */
  backend: string;
  folder?: string;
  state: 'start' | 'progress' | 'done';
  ok?: boolean;
  filesChanged?: string[];
  costUsd?: number;
  ms?: number;
  /** Backend of a first attempt that could not finish (the result is from the retry). */
  escalatedFrom?: string;
}

export interface Activity {
  kind: ActivityKind;
  /** One short human line ("Read src/index.ts", "Asking Groq (llama-3.3-70b)"). */
  text: string;
  /** Tool name for 'tool' / 'tool_done'. */
  tool?: string;
  /** Short input summary for a tool call. */
  detail?: string;
  /** Pairs a 'tool' with its 'tool_done'. */
  id?: string;
  /** Duration in ms ('tool_done'). */
  ms?: number;
  /** Outcome ('tool_done'): false when the tool reported an error. */
  ok?: boolean;
  /** Model label ('model'). */
  model?: string;
  subtask?: SubtaskActivity;
  /** 'plan': the id of a plan proposed in this turn (the chat shows it with Approve / Reject). */
  planId?: string;
  /** 'folder': a project folder Code was refused for (the chat offers to allow it). */
  folder?: string;
  /** When it happened (ms epoch). */
  at: number;
}

/** An event as emitted (the tracker stamps `at`). */
export type ActivityEvent = Omit<Activity, 'at'> & { at?: number };

export interface TurnReportSubtask {
  index: number;
  path: 'code' | 'cli';
  backend: string;
  folder?: string;
  ok: boolean;
  filesChanged: string[];
  costUsd: number;
  ms: number;
  escalatedFrom?: string;
}

/** What one finished turn did, for the report card under the reply. */
export interface TurnReport {
  status: 'done' | 'failed' | 'stopped';
  /** Wall-clock time of the turn (from the request to the reply). */
  ms: number;
  /** The model that answered, e.g. "Claude (opus)" or "Groq (llama-3.3-70b-versatile)". */
  via?: string;
  /** 'claude' | 'local' | a provider id | another answering path ('calculator', ...). */
  tier?: string;
  /** How the turn was handed up, e.g. "Groq (llama-3.3-70b) -> Claude". */
  escalated?: string;
  /** Input tokens, including prompt-cache reads and writes on the Claude tier. */
  tokensIn: number;
  tokensOut: number;
  /** The turn's own cost plus its delegated subtasks. */
  costUsd: number;
  tools: Array<{ name: string; count: number; ms: number }>;
  /** Steps in order; `at` is the offset from the start of the turn, `ms` a tool's duration. */
  steps: Array<{ text: string; at: number; ms?: number; ok?: boolean }>;
  subtasks?: TurnReportSubtask[];
  filesChanged?: string[];
  /** Plans proposed in this turn, awaiting approval. */
  plans?: Array<{ id: string; title: string }>;
  /** Project folders Code was refused for in this turn (not in Settings -> Code). */
  allowFolders?: string[];
  error?: string;
  /** One line: "Done in 14 s · Claude (opus) · 3 tools (Bash ×2, Read) · 2.1k in / 340 out tokens · $0.02". */
  summary: string;
}

const MAX_STEPS = 80;
/** Tools whose input names a file they write (the Claude tier's file tools). */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** "mcp__zamolxis__delegate_task" -> "delegate_task". */
export function toolLabel(name: string): string {
  const m = /^mcp__[^_]+(?:_[^_]+)*?__(.+)$/.exec(name);
  return m ? m[1]! : name;
}

/** The most telling input of a tool call, shortened (falls back to the generic summary). */
export function toolDetail(name: string, input: Record<string, unknown> | undefined, fallback: (i: Record<string, unknown>) => string): string {
  const i = input ?? {};
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = i[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return undefined;
  };
  const one =
    pick('command', 'file_path', 'notebook_path', 'path', 'pattern', 'url', 'query', 'description', 'task', 'prompt', 'model', 'name') ??
    (Array.isArray(i.tasks) ? `${i.tasks.length} task${i.tasks.length === 1 ? '' : 's'}` : undefined) ??
    fallback(i);
  const flat = String(one || '').replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? flat.slice(0, 117) + '...' : flat;
}

export function fmtMs(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return `${s.toFixed(1)} s`;
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return `${m} m ${r < 10 ? '0' : ''}${r} s`;
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function fmtCost(usd: number): string {
  return usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

/** The one-line summary of a report. */
export function summarize(r: Omit<TurnReport, 'summary'>): string {
  const head = r.status === 'stopped' ? `Stopped after ${fmtMs(r.ms)}` : r.status === 'failed' ? `Failed after ${fmtMs(r.ms)}` : `Done in ${fmtMs(r.ms)}`;
  const parts = [head];
  if (r.via) parts.push(r.via);
  const calls = r.tools.reduce((s, t) => s + t.count, 0);
  if (calls) {
    const names = r.tools.slice(0, 4).map((t) => (t.count > 1 ? `${t.name} ×${t.count}` : t.name));
    parts.push(`${calls} tool${calls === 1 ? '' : 's'} (${names.join(', ')}${r.tools.length > 4 ? ', ...' : ''})`);
  }
  if (r.subtasks?.length) parts.push(`${r.subtasks.length} subtask${r.subtasks.length === 1 ? '' : 's'}`);
  if (r.tokensIn || r.tokensOut) parts.push(`${fmtTokens(r.tokensIn)} in / ${fmtTokens(r.tokensOut)} out tokens`);
  if (r.costUsd > 0) parts.push(fmtCost(r.costUsd));
  if (r.status !== 'done' && r.error) parts.push(r.error.length > 120 ? r.error.slice(0, 117) + '...' : r.error);
  return parts.join(' · ');
}

/**
 * Collects one turn's activity and builds its report. `emit` stamps and records an event and
 * forwards it to the channel's sink (when the channel shows activity). Stop: `stop()` marks the
 * turn stopped and aborts every controller bound to it (the tiers bind theirs while they run).
 */
export class TurnTracker {
  readonly startedAt: number;
  stopped = false;
  private readonly events: Activity[] = [];
  private readonly openTools = new Map<string, { name: string; at: number; step: number }>();
  private readonly toolStats = new Map<string, { count: number; ms: number }>();
  private readonly steps: TurnReport['steps'] = [];
  private readonly subtasks: TurnReportSubtask[] = [];
  private readonly files = new Set<string>();
  private readonly plans: Array<{ id: string; title: string }> = [];
  private readonly folders = new Set<string>();
  private readonly aborters = new Set<AbortController>();
  private tokensIn = 0;
  private tokensOut = 0;
  private costUsd = 0;
  private escalated?: string;
  private seq = 0;
  /** The latest model asked (for the escalation line). */
  lastModel?: string;

  constructor(
    private readonly sink?: (ev: Activity) => void,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  emit(e: ActivityEvent): void {
    const ev: Activity = { ...e, at: e.at ?? this.now() };
    this.events.push(ev);
    this.record(ev);
    try {
      this.sink?.(ev);
    } catch {
      /* a broken sink (closed socket) must never break the turn */
    }
  }

  /** A tool call started; returns its id for `toolEnd`. */
  toolStart(name: string, detail?: string, id?: string, input?: Record<string, unknown>): string {
    const tid = id || `t${++this.seq}`;
    const label = toolLabel(name);
    if (WRITE_TOOLS.has(label) && input) {
      const f = input.file_path ?? input.notebook_path;
      if (typeof f === 'string' && f.trim()) this.files.add(f.trim());
    }
    this.emit({ kind: 'tool', tool: label, detail, id: tid, text: detail ? `${label} ${detail}` : label });
    return tid;
  }

  /** A tool call finished (unknown ids are ignored). */
  toolEnd(id: string, ok = true): void {
    const open = this.openTools.get(id);
    if (!open) return;
    this.emit({ kind: 'tool_done', tool: open.name, id, ok, ms: this.now() - open.at, text: `${open.name} ${ok ? 'done' : 'failed'}` });
  }

  addUsage(tokensIn: number, tokensOut: number, costUsd = 0): void {
    this.tokensIn += tokensIn || 0;
    this.tokensOut += tokensOut || 0;
    this.costUsd += costUsd || 0;
  }

  setEscalated(text: string): void {
    this.escalated = text;
  }

  /** Abort this controller when the turn is stopped. Returns the unbind fn. */
  bind(ac: AbortController): () => void {
    if (this.stopped) ac.abort();
    this.aborters.add(ac);
    return () => {
      this.aborters.delete(ac);
    };
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.emit({ kind: 'note', text: 'Stopping' });
    for (const ac of this.aborters) {
      try {
        ac.abort();
      } catch {
        /* best-effort */
      }
    }
  }

  private addStep(text: string, at: number): number {
    if (this.steps.length >= MAX_STEPS) return -1;
    this.steps.push({ text, at: Math.max(0, at - this.startedAt) });
    return this.steps.length - 1;
  }

  private record(ev: Activity): void {
    switch (ev.kind) {
      case 'start':
        return;
      case 'tool': {
        const step = this.addStep(ev.text, ev.at);
        if (ev.id) this.openTools.set(ev.id, { name: ev.tool || ev.text, at: ev.at, step });
        const st = this.toolStats.get(ev.tool || ev.text) ?? { count: 0, ms: 0 };
        st.count++;
        this.toolStats.set(ev.tool || ev.text, st);
        return;
      }
      case 'tool_done': {
        const open = ev.id ? this.openTools.get(ev.id) : undefined;
        if (!open) return;
        this.openTools.delete(ev.id!);
        const ms = ev.ms ?? ev.at - open.at;
        const st = this.toolStats.get(open.name);
        if (st) st.ms += ms;
        const s = open.step >= 0 ? this.steps[open.step] : undefined;
        if (s) {
          s.ms = ms;
          if (ev.ok === false) s.ok = false;
        }
        return;
      }
      case 'subtask': {
        const t = ev.subtask;
        if (!t || t.state === 'progress') return;
        if (t.state === 'start') {
          this.addStep(ev.text, ev.at);
          return;
        }
        const idx = this.addStep(ev.text, ev.at);
        if (idx >= 0) {
          this.steps[idx]!.ms = t.ms;
          if (t.ok === false) this.steps[idx]!.ok = false;
        }
        const files = t.filesChanged ?? [];
        for (const f of files) this.files.add(f);
        this.subtasks.push({ index: t.index, path: t.path, backend: t.backend, folder: t.folder, ok: t.ok !== false, filesChanged: files, costUsd: t.costUsd ?? 0, ms: t.ms ?? 0, ...(t.escalatedFrom ? { escalatedFrom: t.escalatedFrom } : {}) });
        return;
      }
      case 'plan':
        if (ev.planId && !this.plans.some((p) => p.id === ev.planId)) this.plans.push({ id: ev.planId, title: ev.text });
        this.addStep(`Proposed the plan "${ev.text}"`, ev.at);
        return;
      case 'folder':
        if (ev.folder) this.folders.add(ev.folder);
        this.addStep(ev.text, ev.at);
        return;
      case 'model':
        if (ev.model) this.lastModel = ev.model;
        this.addStep(ev.text, ev.at);
        return;
      default:
        this.addStep(ev.text, ev.at);
    }
  }

  /** Build the report for the turn's result. */
  finish(r: { via?: string; modelToken?: string; isError?: boolean; errorKind?: string; reply?: string }): TurnReport {
    const ms = this.now() - this.startedAt;
    const stopped = this.stopped || r.errorKind === 'stopped';
    const status: TurnReport['status'] = stopped ? 'stopped' : r.isError ? 'failed' : 'done';
    const subCost = this.subtasks.reduce((s, t) => s + (t.costUsd || 0), 0);
    const tier = r.modelToken ?? (r.via && /^Claude\b/.test(r.via) ? 'claude' : r.via ? r.via.toLowerCase().split(/[\s(]/)[0] : undefined);
    const error = stopped ? 'Stopped by the user' : r.isError ? (r.reply || r.errorKind || 'error').replace(/\s+/g, ' ').trim().slice(0, 300) : undefined;
    const base: Omit<TurnReport, 'summary'> = {
      status,
      ms,
      via: r.via,
      tier,
      ...(this.escalated ? { escalated: this.escalated } : {}),
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      costUsd: this.costUsd + subCost,
      tools: [...this.toolStats.entries()].map(([name, s]) => ({ name, count: s.count, ms: s.ms })).sort((a, b) => b.count - a.count || b.ms - a.ms),
      steps: this.steps.map((s) => ({ ...s })),
      ...(this.subtasks.length ? { subtasks: [...this.subtasks].sort((a, b) => a.index - b.index) } : {}),
      ...(this.files.size ? { filesChanged: [...this.files].sort() } : {}),
      ...(this.plans.length ? { plans: this.plans.map((p) => ({ ...p })) } : {}),
      ...(this.folders.size ? { allowFolders: [...this.folders] } : {}),
      ...(error ? { error } : {}),
    };
    return { ...base, summary: summarize(base) };
  }
}
