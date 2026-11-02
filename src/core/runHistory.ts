import fs from 'node:fs';
import path from 'node:path';

/** Where a run came from, so the dashboard can tell scheduled work from a manual poke or an event.
 *  'code' / 'cli' are delegated Claude Code runs (SDK runner in a project folder / headless CLI). */
export type RunOrigin = 'schedule' | 'manual' | 'event' | 'chat' | 'code' | 'cli' | 'unknown';

/** One finished agent run. Deliberately small - this is a rolling ledger, not an archive. */
export interface RunRecord {
  id: string;
  /** Agent slug. */
  agent: string;
  /** When the run finished (ms epoch). */
  at: number;
  /** Wall-clock duration of the run in milliseconds. */
  durationMs: number;
  /** Did it finish without erroring. */
  ok: boolean;
  /** What the SDK reported this run cost, in USD (0 for local models). */
  costUsd: number;
  /** Which backend answered (e.g. "Claude (opus)", "Local"). */
  via?: string;
  /** What kicked the run off. */
  origin: RunOrigin;
  /** First line or two of the reply, so the dashboard can show what happened without the full text. */
  preview: string;
}

/** Rolled-up numbers for one agent, computed from its recent runs. */
export interface AgentRunStats {
  agent: string;
  runs: number;
  ok: number;
  failed: number;
  totalCostUsd: number;
  avgDurationMs: number;
  lastAt?: number;
  lastOk?: boolean;
}

const MAX_RECORDS = 1000;

/** Trim a reply down to a short, single-line preview for the runs list. */
function toPreview(text: string): string {
  const flat = (text || '').replace(/\s+/g, ' ').trim();
  return flat.length > 240 ? flat.slice(0, 237) + '...' : flat;
}

/**
 * A rolling, file-backed ledger of finished agent runs. Every run that goes through the engine
 * lands here - scheduled, manual, or event-triggered - so the observability dashboard can show
 * history, cost, and reliability per agent. Capped at the last {@link MAX_RECORDS} runs; the
 * oldest fall off the end. Only the engine writes; the web layer reads.
 */
export class RunHistory {
  private file: string;
  private records: RunRecord[] = [];
  private seq = 0;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'runs.json');
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(raw)) this.records = raw as RunRecord[];
    } catch {
      this.records = [];
    }
  }

  private persist(): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.records, null, 2));
    } catch {
      /* a runs-ledger write must never take the engine down */
    }
  }

  /** Record a finished run. `at` defaults to now; `id` is assigned. Returns the stored row. */
  append(rec: Omit<RunRecord, 'id' | 'at' | 'preview'> & { at?: number; preview?: string; reply?: string }): RunRecord {
    const at = rec.at ?? Date.now();
    // A monotonic suffix keeps ids unique even for runs that finish in the same millisecond.
    const id = `${at.toString(36)}-${(this.seq++).toString(36)}`;
    const preview = rec.preview ?? toPreview(rec.reply ?? '');
    const row: RunRecord = {
      id,
      agent: rec.agent,
      at,
      durationMs: Math.max(0, Math.round(rec.durationMs)),
      ok: rec.ok,
      costUsd: rec.costUsd || 0,
      via: rec.via,
      origin: rec.origin,
      preview,
    };
    this.records.push(row);
    if (this.records.length > MAX_RECORDS) this.records = this.records.slice(-MAX_RECORDS);
    this.persist();
    return row;
  }

  /** Recent runs, newest first. Optionally filter to one agent and cap the count. */
  list(opts?: { agent?: string; limit?: number }): RunRecord[] {
    let rows = this.records;
    if (opts?.agent) rows = rows.filter((r) => r.agent === opts.agent);
    rows = rows.slice().sort((a, b) => b.at - a.at);
    if (opts?.limit && opts.limit > 0) rows = rows.slice(0, opts.limit);
    return rows;
  }

  /** Per-agent rollups over everything currently retained, most-recently-active first. */
  stats(): AgentRunStats[] {
    const byAgent = new Map<string, RunRecord[]>();
    for (const r of this.records) {
      const arr = byAgent.get(r.agent) ?? [];
      arr.push(r);
      byAgent.set(r.agent, arr);
    }
    const out: AgentRunStats[] = [];
    for (const [agent, runs] of byAgent) {
      const ok = runs.filter((r) => r.ok).length;
      const totalCostUsd = runs.reduce((s, r) => s + (r.costUsd || 0), 0);
      const avgDurationMs = runs.reduce((s, r) => s + r.durationMs, 0) / runs.length;
      const latest = runs.reduce((a, b) => (b.at > a.at ? b : a));
      out.push({
        agent,
        runs: runs.length,
        ok,
        failed: runs.length - ok,
        totalCostUsd,
        avgDurationMs,
        lastAt: latest.at,
        lastOk: latest.ok,
      });
    }
    out.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
    return out;
  }
}
