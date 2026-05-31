import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';

/**
 * Maps a stable conversation key (e.g. "telegram:12345") to the Claude Agent SDK
 * session id, so each conversation resumes its own history across daemon restarts.
 * Persisted as JSON; small enough that a flat file is fine.
 */
export interface SessionRecord {
  sessionId: string;
  updatedAt: number;
  /** Absolute path to this conversation's agent workspace (holds CLAUDE.md, memory). */
  workspace: string;
}

export class SessionStore {
  private readonly map = new Map<string, SessionRecord>();
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'sessions.json');
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, SessionRecord>;
      for (const [k, v] of Object.entries(raw)) this.map.set(k, v);
      logger.debug({ count: this.map.size }, 'loaded sessions');
    } catch {
      /* first run — no file yet */
    }
  }

  private persist(): void {
    const obj: Record<string, SessionRecord> = {};
    for (const [k, v] of this.map.entries()) obj[k] = v;
    fs.writeFileSync(this.file, JSON.stringify(obj, null, 2));
  }

  get(key: string): SessionRecord | undefined {
    return this.map.get(key);
  }

  set(key: string, record: SessionRecord): void {
    this.map.set(key, record);
    this.persist();
  }

  /** Forget a conversation's session id (e.g. on /reset), keeping the workspace. */
  clearSession(key: string): void {
    const rec = this.map.get(key);
    if (rec) {
      this.map.delete(key);
      this.persist();
    }
  }

  /**
   * Fully delete a conversation: drop the session mapping AND remove its
   * workspace (CLAUDE.md, memory.md, anything the agent wrote). Irreversible.
   * Returns true if something was deleted.
   */
  purge(key: string): boolean {
    const rec = this.map.get(key);
    if (!rec) return false;
    this.map.delete(key);
    this.persist();
    if (rec.workspace) {
      try {
        fs.rmSync(rec.workspace, { recursive: true, force: true });
      } catch (err) {
        logger.warn({ key, err: String(err) }, 'failed to remove workspace dir');
      }
    }
    return true;
  }
}
