import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { logger } from '../logger.js';

/**
 * Event-driven triggers: fire an agent on something happening on the machine, not on a clock.
 * Two kinds cover the demo-worthy cases without any external service:
 *  - `file`   - a file lands in (or changes under) a watched folder
 *  - `disk`   - a drive's free space drops below a threshold
 *  - `memory` - memory in use climbs above a threshold
 * This is the capability a cloud assistant can't have: it reacts to your actual desktop.
 */
export type TriggerType = 'file' | 'disk' | 'memory';

export interface TriggerDef {
  id: string;
  /** Agent slug to run when the trigger fires. */
  agent: string;
  type: TriggerType;
  enabled: boolean;
  /** Friendly name for the UI (defaults to a description of the condition). */
  label?: string;
  /** file: folder to watch. */
  folder?: string;
  /** file: only react to names containing this text or matching a `*.ext` suffix (empty = any). */
  match?: string;
  /** disk: which drive, e.g. "C:". */
  drive?: string;
  /** disk: fire when free space drops below this %. memory: fire when used climbs above this %. */
  thresholdPct?: number;
  /** Extra instruction handed to the agent; `{file}` is replaced with the triggering path. */
  prompt?: string;
  createdAt: number;
  /** Last time this trigger fired (ms epoch). */
  lastFired?: number;
}

/** File-backed list of triggers (triggers.json). The web layer and the watcher both talk to it. */
export class TriggerStore {
  private file: string;
  private items: TriggerDef[] = [];
  /** Fingerprint (mtime+size) of triggers.json as last read/written, so we re-read it when another
   *  TriggerStore instance (the web layer) has changed it. Without this the long-lived watcher never
   *  saw UI edits, and its markFired() wrote a stale list back over them. */
  private stamp = '';

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'triggers.json');
    this.load();
  }

  private fileStamp(): string {
    try {
      const st = fs.statSync(this.file);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return '';
    }
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.items = Array.isArray(raw) ? (raw as TriggerDef[]) : [];
    } catch {
      this.items = [];
    }
    this.stamp = this.fileStamp();
  }

  /** Re-read triggers.json if it changed on disk since we last read or wrote it. */
  private refresh(): void {
    if (this.fileStamp() !== this.stamp) this.load();
  }

  private persist(): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.items, null, 2));
    } catch (err) {
      logger.warn({ err: String(err) }, 'triggers.json write failed');
    }
    this.stamp = this.fileStamp();
  }

  list(): TriggerDef[] {
    this.refresh();
    return this.items.map((t) => ({ ...t }));
  }

  get(id: string): TriggerDef | undefined {
    this.refresh();
    return this.items.find((t) => t.id === id);
  }

  add(input: Omit<TriggerDef, 'id' | 'createdAt' | 'enabled'> & { enabled?: boolean }): TriggerDef {
    this.refresh();
    const t: TriggerDef = { ...input, id: randomUUID(), enabled: input.enabled !== false, createdAt: Date.now() };
    this.items.push(t);
    this.persist();
    return t;
  }

  remove(id: string): boolean {
    this.refresh();
    const before = this.items.length;
    this.items = this.items.filter((t) => t.id !== id);
    if (this.items.length === before) return false;
    this.persist();
    return true;
  }

  setEnabled(id: string, enabled: boolean): TriggerDef | undefined {
    this.refresh();
    const t =this.items.find((x) => x.id === id);
    if (!t) return undefined;
    t.enabled = enabled;
    this.persist();
    return t;
  }

  /** Record a fire without going through the public API (kept quiet so it doesn't churn re-arming). */
  markFired(id: string): void {
    this.refresh();
    const t =this.items.find((x) => x.id === id);
    if (!t) return;
    t.lastFired = Date.now();
    this.persist();
  }
}

/** A human sentence describing what a trigger watches, for labels and notifications. */
export function describeTrigger(t: TriggerDef): string {
  if (t.label && t.label.trim()) return t.label.trim();
  if (t.type === 'file') return `New file in ${t.folder || '?'}${t.match ? ` matching "${t.match}"` : ''}`;
  if (t.type === 'disk') return `${t.drive || 'C:'} free space below ${t.thresholdPct ?? 10}%`;
  if (t.type === 'memory') return `Memory use above ${t.thresholdPct ?? 90}%`;
  return t.type;
}

/** Does a filename satisfy the trigger's match rule? Empty rule = anything. */
function nameMatches(name: string, rule?: string): boolean {
  const r = (rule || '').trim();
  if (!r) return true;
  if (r.startsWith('*.')) return name.toLowerCase().endsWith(r.slice(1).toLowerCase());
  return name.toLowerCase().includes(r.toLowerCase());
}

/** Free space on a drive as a percentage (0-100), or null if it can't be read. */
async function freePercent(drive: string): Promise<number | null> {
  // Normalize "C:" / "C" to a root path the OS accepts ("C:\" on Windows).
  let root = drive || 'C:';
  if (/^[a-zA-Z]:?$/.test(root)) root = root.replace(/:?$/, ':') + (process.platform === 'win32' ? '\\' : '');
  try {
    const st = await fs.promises.statfs(root);
    if (!st.blocks) return null;
    return (Number(st.bavail) / Number(st.blocks)) * 100;
  } catch {
    return null;
  }
}

export interface TriggerWatcherDeps {
  /** Run the agent for a fired trigger. `origin` is always 'event' here. */
  runAgent: (name: string, task: string) => Promise<{ reply: string; via?: string; isError?: boolean }>;
  /** Deliver the agent's reply to its channels (chat/Slack/web). */
  deliver?: (agent: string, reply: string, via?: string) => Promise<void>;
  /** Is the agent allowed to run right now (not stopped/paused)? */
  isRunnable?: (name: string) => boolean;
  /** Raise a desktop + native notification. */
  notify: (title: string, body: string, kind?: string) => void;
}

/**
 * Watches the machine and fires agents when a trigger's condition is met. File triggers use a
 * persistent {@link fs.watch}; disk/memory triggers are evaluated on a poll. The set of armed
 * triggers is reloaded from triggers.json whenever it changes, so edits from the web UI take
 * effect within one poll without any direct coupling to the web layer.
 */
export class TriggerWatcher {
  private store: TriggerStore;
  private deps: TriggerWatcherDeps;
  private pollMs: number;
  private timer?: ReturnType<typeof setInterval>;
  /** appId -> fs watcher, for file triggers currently armed. */
  private fileWatchers = new Map<string, fs.FSWatcher>();
  /** Debounce timers per file trigger, so a burst of fs events becomes one run. */
  private debounce = new Map<string, ReturnType<typeof setTimeout>>();
  /** Triggers with a run in flight - don't stack a second run on the same trigger. */
  private inFlight = new Set<string>();
  /** Edge state for threshold triggers: were we already breached last poll? */
  private breached = new Map<string, boolean>();
  /** Signature of the last-armed config, to skip re-arming when nothing structural changed. */
  private armedSig = '';

  constructor(store: TriggerStore, deps: TriggerWatcherDeps, opts?: { pollMs?: number }) {
    this.store = store;
    this.deps = deps;
    this.pollMs = opts?.pollMs ?? 4000;
  }

  start(): void {
    this.rearm();
    this.timer = setInterval(() => this.tick().catch(() => {}), this.pollMs);
    const n = this.store.list().filter((t) => t.enabled).length;
    logger.info({ triggers: n, pollMs: this.pollMs }, 'trigger watcher started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const w of this.fileWatchers.values()) { try { w.close(); } catch { /* ignore */ } }
    this.fileWatchers.clear();
  }

  /** One poll: reload+re-arm on config change, then evaluate threshold triggers. */
  private async tick(): Promise<void> {
    const sig = this.configSig();
    if (sig !== this.armedSig) this.rearm();
    await this.evaluateThresholds();
  }

  /** A structural fingerprint of enabled triggers (ignores lastFired so a fire doesn't re-arm). */
  private configSig(): string {
    return this.store
      .list()
      .filter((t) => t.enabled)
      .map((t) => [t.id, t.type, t.folder, t.match, t.drive, t.thresholdPct].join('|'))
      .sort()
      .join('\n');
  }

  /** (Re)build file watchers to match the current enabled file triggers. */
  private rearm(): void {
    for (const w of this.fileWatchers.values()) { try { w.close(); } catch { /* ignore */ } }
    this.fileWatchers.clear();
    for (const t of this.store.list()) {
      if (!t.enabled || t.type !== 'file' || !t.folder) continue;
      try {
        if (!fs.existsSync(t.folder)) { logger.warn({ folder: t.folder }, 'trigger folder missing'); continue; }
        const w = fs.watch(t.folder, { persistent: false }, (_evt, filename) => {
          if (filename) this.onFileEvent(t.id, String(filename));
        });
        this.fileWatchers.set(t.id, w);
      } catch (err) {
        logger.warn({ id: t.id, err: String(err) }, 'could not watch trigger folder');
      }
    }
    this.armedSig = this.configSig();
  }

  /** A file changed under a watched folder. The match rule is applied HERE, before debouncing, so
   *  an unrelated file landing in the same folder can't cancel a pending matching one. Debouncing is
   *  keyed per (trigger, file) so the rename+change burst for one file collapses into a single run
   *  while distinct files each get their own. */
  private onFileEvent(triggerId: string, filename: string): void {
    const t = this.store.get(triggerId);
    if (!t || !t.enabled || !t.folder) return;
    if (!nameMatches(filename, t.match)) return;
    const key = triggerId + '\0' + filename;
    const prev = this.debounce.get(key);
    if (prev) clearTimeout(prev);
    this.debounce.set(
      key,
      setTimeout(() => {
        this.debounce.delete(key);
        const cur = this.store.get(triggerId);
        if (!cur || !cur.enabled || !cur.folder) return;
        const full = path.join(cur.folder, filename);
        // fs.watch also fires on deletes/renames; only react to something that exists now.
        if (!fs.existsSync(full)) return;
        const task = (cur.prompt && cur.prompt.includes('{file}'))
          ? cur.prompt.replace(/\{file\}/g, full)
          : `A file arrived: "${full}". ${cur.prompt || 'Handle it according to your job.'}`;
        void this.fire(cur, task, `${describeTrigger(cur)} - ${filename}`);
      }, 600),
    );
  }

  /** Poll disk/memory triggers and fire on the transition into a breached state (not every poll). */
  private async evaluateThresholds(): Promise<void> {
    for (const t of this.store.list()) {
      if (!t.enabled || (t.type !== 'disk' && t.type !== 'memory')) continue;
      let breach = false;
      let detail = '';
      if (t.type === 'disk') {
        const pct = await freePercent(t.drive || 'C:');
        if (pct == null) continue;
        breach = pct < (t.thresholdPct ?? 10);
        detail = `${(t.drive || 'C:')} at ${pct.toFixed(1)}% free`;
      } else {
        const usedPct = (1 - os.freemem() / os.totalmem()) * 100;
        breach = usedPct > (t.thresholdPct ?? 90);
        detail = `memory at ${usedPct.toFixed(0)}% used`;
      }
      const was = this.breached.get(t.id) ?? false;
      this.breached.set(t.id, breach);
      if (breach && !was) {
        const task = `${describeTrigger(t)} just tripped (${detail}). ${t.prompt || 'Do your job about this now.'}`;
        void this.fire(t, task, `${describeTrigger(t)} (${detail})`);
      }
    }
  }

  /** Run the agent for a fired trigger, deliver its reply, and notify the user. */
  private async fire(t: TriggerDef, task: string, what: string): Promise<void> {
    if (this.inFlight.has(t.id)) return; // one run per trigger at a time
    if (this.deps.isRunnable && !this.deps.isRunnable(t.agent)) {
      logger.info({ agent: t.agent }, 'trigger skipped - agent not runnable');
      return;
    }
    this.inFlight.add(t.id);
    this.store.markFired(t.id);
    this.deps.notify(`Trigger: ${t.agent}`, `${what} - running ${t.agent}`, 'trigger');
    logger.info({ id: t.id, agent: t.agent, type: t.type }, 'trigger fired');
    try {
      const r = await this.deps.runAgent(t.agent, task);
      if (!r.isError && this.deps.deliver) await this.deps.deliver(t.agent, r.reply, r.via);
      if (r.isError) this.deps.notify(`Trigger failed: ${t.agent}`, r.reply.slice(0, 200), 'trigger');
    } catch (err) {
      logger.error({ id: t.id, err: String(err) }, 'trigger run failed');
    } finally {
      this.inFlight.delete(t.id);
    }
  }
}
