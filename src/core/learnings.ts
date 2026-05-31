import path from 'node:path';
import { createRequire } from 'node:module';
import { logger } from '../logger.js';

const require = createRequire(import.meta.url);

/**
 * Knowledge index for the learning process (SQLite FTS5 on the shared state.db — no native dep).
 *
 * Two tables, both full-text:
 *  - `learnings`: reusable METHODS/mappings (mirror of LEARNINGS.md, which stays source of truth;
 *    rebuilt via reindex()). Retrieved by relevance per request.
 *  - `facts`: ABSOLUTE, self-contained facts distilled from answered questions (the "remember the
 *    answer" path). DB-native (no file). Dates are absolute (e.g. "2026-05-29"), so they don't go
 *    stale the way "two nights ago" would, and FTS5 returns only the few relevant to a request —
 *    so the on-device model can answer from stored knowledge instead of re-searching or guessing.
 *
 * If node:sqlite / FTS5 is unavailable, everything degrades to null/no-op and callers fall back.
 */
export class LearningsStore {
  private db: { exec(s: string): void; prepare(s: string): { run(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] } } | null = null;
  private fts = false;

  constructor(dataDir: string) {
    try {
      const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (p: string) => NonNullable<LearningsStore['db']> };
      this.db = new DatabaseSync(path.join(dataDir, 'state.db'));
      try {
        this.db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS learnings USING fts5(entry)');
        this.db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS facts USING fts5(entry)');
        this.fts = true;
      } catch {
        this.db.exec('CREATE TABLE IF NOT EXISTS learnings (entry TEXT)');
        this.db.exec('CREATE TABLE IF NOT EXISTS facts (entry TEXT)');
        this.fts = false;
      }
    } catch (err) {
      this.db = null;
      logger.warn({ err: String(err) }, 'node:sqlite unavailable — learnings/facts relevance disabled (full list used)');
    }
  }

  get available(): boolean {
    return Boolean(this.db);
  }

  /** Rebuild the learnings index from the authoritative file list (cheap — learnings are few). */
  reindex(entries: string[]): void {
    if (!this.db) return;
    try {
      this.db.exec('DELETE FROM learnings');
      const ins = this.db.prepare('INSERT INTO learnings (entry) VALUES (?)');
      for (const e of entries) {
        const t = (e ?? '').trim();
        if (t) ins.run(t);
      }
    } catch (err) {
      logger.warn({ err: String(err) }, 'learnings reindex failed');
    }
  }

  /** Store an absolute fact (deduped). Returns true if newly added. */
  addFact(entry: string): boolean {
    if (!this.db) return false;
    const t = (entry ?? '').trim();
    if (!t || /^none\b/i.test(t)) return false;
    try {
      const dup = this.db.prepare('SELECT 1 FROM facts WHERE entry = ? LIMIT 1').all(t);
      if (dup.length) return false;
      this.db.prepare('INSERT INTO facts (entry) VALUES (?)').run(t);
      return true;
    } catch (err) {
      logger.warn({ err: String(err) }, 'addFact failed');
      return false;
    }
  }

  /** Learnings (methods) relevant to `query`. null when FTS unavailable (caller uses full list). */
  search(query: string, limit = 6): string[] | null {
    return this.ftsSearch('learnings', query, limit);
  }

  /** Absolute facts relevant to `query` (empty array if none / FTS off). */
  searchFacts(query: string, limit = 6): string[] {
    return this.ftsSearch('facts', query, limit) ?? [];
  }

  private ftsSearch(table: 'learnings' | 'facts', query: string, limit: number): string[] | null {
    if (!this.db) return null;
    if (!this.fts) {
      try {
        return (this.db.prepare(`SELECT entry FROM ${table} LIMIT ?`).all(limit) as Array<{ entry: string }>).map((r) => r.entry);
      } catch {
        return null;
      }
    }
    const terms = (query ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .slice(0, 10);
    if (!terms.length) return [];
    // Prefix match (term*) so "score" matches "scores", "light"→"lights" (FTS5 has no stemming).
    const match = terms.map((t) => `${t}*`).join(' OR ');
    try {
      const rows = this.db.prepare(`SELECT entry FROM ${table} WHERE ${table} MATCH ? ORDER BY rank LIMIT ?`).all(match, limit) as Array<{ entry: string }>;
      return rows.map((r) => r.entry);
    } catch (err) {
      logger.warn({ err: String(err), table }, 'FTS search failed');
      return null;
    }
  }
}
