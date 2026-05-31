import path from 'node:path';
import { createRequire } from 'node:module';
import { logger } from '../logger.js';

const require = createRequire(import.meta.url);

export interface SearchHit {
  conversation: string;
  role: string;
  text: string;
  ts: number;
}

/**
 * Unbounded session archive: every inbound message and reply, indexed in a
 * SQLite database (<dataDir>/state.db) with FTS5 full-text search. Backed by
 * Node's built-in `node:sqlite` (no native dependency). If FTS5 isn't compiled
 * into the bundled SQLite, it falls back to a plain table + LIKE search. If
 * `node:sqlite` is unavailable (older Node), session search is disabled.
 */
export class SessionIndex {
  private db: any = null;
  private fts = false;

  constructor(dataDir: string) {
    try {
      const { DatabaseSync } = require('node:sqlite');
      this.db = new DatabaseSync(path.join(dataDir, 'state.db'));
      try {
        this.db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS messages USING fts5(conversation, role, text, ts UNINDEXED)');
        this.fts = true;
      } catch {
        this.db.exec('CREATE TABLE IF NOT EXISTS messages (conversation TEXT, role TEXT, text TEXT, ts INTEGER)');
        this.fts = false;
      }
      logger.info({ fts: this.fts }, 'session index ready (state.db)');
    } catch (err) {
      this.db = null;
      logger.warn({ err: String(err) }, 'node:sqlite unavailable — session search disabled');
    }
  }

  available(): boolean {
    return this.db !== null;
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      /* ignore */
    }
    this.db = null;
  }

  record(conversation: string, role: string, text: string, ts: number): void {
    if (!this.db || !text) return;
    try {
      this.db
        .prepare('INSERT INTO messages (conversation, role, text, ts) VALUES (?, ?, ?, ?)')
        .run(conversation, role, text, ts);
    } catch (err) {
      logger.debug({ err: String(err) }, 'session index record failed');
    }
  }

  search(query: string, limit = 10): SearchHit[] {
    if (!this.db || !query.trim()) return [];
    const lim = Math.min(Math.max(1, limit), 25);
    // Tokenize into words and quote each so arbitrary user text can't break FTS
    // syntax; joining with spaces is an implicit AND (all terms must appear).
    const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (this.fts && terms.length) {
      try {
        const match = terms.map((t) => `"${t}"`).join(' ');
        return this.db
          .prepare(
            "SELECT conversation, role, snippet(messages, 2, '[', ']', '…', 14) AS text, ts FROM messages WHERE messages MATCH ? ORDER BY rank LIMIT ?",
          )
          .all(match, lim) as SearchHit[];
      } catch (err) {
        logger.debug({ err: String(err) }, 'fts search failed; falling back to LIKE');
      }
    }
    try {
      return this.db
        .prepare('SELECT conversation, role, substr(text, 1, 200) AS text, ts FROM messages WHERE text LIKE ? ORDER BY ts DESC LIMIT ?')
        .all(`%${query}%`, lim) as SearchHit[];
    } catch (err) {
      logger.debug({ err: String(err) }, 'like search failed');
      return [];
    }
  }
}
