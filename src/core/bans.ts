import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';

/** A single ban: model (a tier/provider token like 'local' | 'groq' | 'openai') is forbidden
 *  from using a named capability (a skill name OR a tool name like 'ha_service'/'web_search'). */
export interface Ban {
  model: string;
  skill: string;
}

/** Tokens that always refer to the smartest model — which can NEVER be banned (it's the
 *  rescue tier, so something must always be able to run any capability). */
const SMARTEST_TOKENS = new Set(['claude', 'smartest', 'opus', 'sonnet', 'haiku']);

/** Is this model token the (unbannable) smartest model? */
export function isSmartestModel(model: string): boolean {
  return SMARTEST_TOKENS.has((model || '').trim().toLowerCase());
}

const norm = (s: string): string => (s || '').trim().toLowerCase();

/**
 * Persisted per-(model, skill) ban list. When a model is banned from a capability it must
 * refuse to use it ("I can't, I am banned!") even if it's the only model available; routing
 * prefers a non-banned model for that capability. Auto-populated when the user escalates right
 * after the local model used a capability, and editable from the Memory panel / chat commands.
 */
export class BanStore {
  private readonly file: string;
  private bans: Ban[] = [];

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'bans.json');
    this.load();
  }

  private load(): void {
    try {
      const arr = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Ban[];
      this.bans = Array.isArray(arr) ? arr.filter((b) => b && b.model && b.skill).map((b) => ({ model: norm(b.model), skill: norm(b.skill) })) : [];
    } catch {
      this.bans = [];
    }
  }

  private persist(): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.bans, null, 2));
    } catch (err) {
      logger.warn({ err: String(err) }, 'bans persist failed');
    }
  }

  /** All bans (normalized lower-case tokens), most-recent last. */
  list(): Ban[] {
    return this.bans.map((b) => ({ ...b }));
  }

  /** Is (model, skill) banned? Both compared case-insensitively. */
  isBanned(model: string, skill: string): boolean {
    const m = norm(model);
    const s = norm(skill);
    if (!m || !s) return false;
    return this.bans.some((b) => b.model === m && b.skill === s);
  }

  /** Capabilities this model is banned from (lower-case). */
  bannedSkillsFor(model: string): string[] {
    const m = norm(model);
    return this.bans.filter((b) => b.model === m).map((b) => b.skill);
  }

  /** Add a ban. Returns {ok, reason}. The smartest model can never be banned. */
  add(model: string, skill: string): { ok: boolean; reason?: string } {
    const m = norm(model);
    const s = norm(skill);
    if (!m || !s) return { ok: false, reason: 'need both a model and a skill' };
    if (isSmartestModel(m)) return { ok: false, reason: 'the smartest model cannot be banned' };
    if (this.isBanned(m, s)) return { ok: true }; // idempotent
    this.bans.push({ model: m, skill: s });
    this.persist();
    logger.info({ model: m, skill: s }, 'ban added');
    return { ok: true };
  }

  /** Remove a ban. Returns true if one was removed. */
  remove(model: string, skill: string): boolean {
    const m = norm(model);
    const s = norm(skill);
    const before = this.bans.length;
    this.bans = this.bans.filter((b) => !(b.model === m && b.skill === s));
    const removed = this.bans.length !== before;
    if (removed) {
      this.persist();
      logger.info({ model: m, skill: s }, 'ban removed');
    }
    return removed;
  }
}
