import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';

/**
 * Interactive tool permissions with remembered grants.
 *
 * In the default permission mode Zamolxis asks the user before a tool/resource is
 * used (like Claude Code does by default) and REMEMBERS "always" decisions per
 * scope. Scopes, from most to least specific:
 *   agent:<name>          — a sub-agent's standing grant
 *   skill:<slug>          — a forced-skill run's grant
 *   chat:<conversationKey> — this conversation's grant
 *   global                — everywhere
 * Grants persist in <dataDir>/permissions.json.
 */

export type PermissionDecision = 'allow' | 'deny';

export interface PermissionGrant {
  scope: string;
  tool: string;
  decision: PermissionDecision;
  grantedAt: number;
}

/** What the user clicked on a permission prompt. null = no answer (disconnected). */
export type PromptAnswer = 'allow' | 'allow-always' | 'deny' | 'deny-always' | null;

export interface PermissionAsk {
  /** Unique request id (echoed back by the UI). */
  id: string;
  /** The chat the request belongs to (channel-local id, e.g. the web cid). */
  chatId: string;
  conversationKey: string;
  toolName: string;
  /** Short human-readable summary of the tool input (already truncated). */
  detail: string;
  /** The scope an "always" answer will be remembered under. */
  persistScope: string;
}

/** A channel-provided prompter: shows the question to the user and resolves with their answer. */
export type PermissionPrompter = (ask: PermissionAsk) => Promise<PromptAnswer>;

export class PermissionStore {
  private readonly file: string;
  private grants: PermissionGrant[] = [];

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'permissions.json');
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(raw)) this.grants = raw.filter((g) => g && typeof g.scope === 'string' && typeof g.tool === 'string');
    } catch {
      /* first run */
    }
  }

  private persist(): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.grants, null, 2));
    } catch (err) {
      logger.warn({ err: String(err) }, 'failed to persist permissions.json');
    }
  }

  /** First matching grant wins; call with scopes ordered most-specific first. */
  check(scopes: string[], tool: string): PermissionDecision | undefined {
    for (const s of scopes) {
      const g = this.grants.find((x) => x.scope === s && x.tool === tool);
      if (g) return g.decision;
    }
    return undefined;
  }

  set(scope: string, tool: string, decision: PermissionDecision): void {
    const existing = this.grants.find((x) => x.scope === scope && x.tool === tool);
    if (existing) {
      existing.decision = decision;
      existing.grantedAt = Date.now();
    } else {
      this.grants.push({ scope, tool, decision, grantedAt: Date.now() });
    }
    this.persist();
    logger.info({ scope, tool, decision }, 'permission remembered');
  }

  revoke(scope: string, tool: string): boolean {
    const before = this.grants.length;
    this.grants = this.grants.filter((x) => !(x.scope === scope && x.tool === tool));
    if (this.grants.length !== before) {
      this.persist();
      return true;
    }
    return false;
  }

  /** Drop every grant under a scope (e.g. when a chat is forgotten or an agent deleted). */
  clearScope(scope: string): number {
    const before = this.grants.length;
    this.grants = this.grants.filter((x) => x.scope !== scope);
    const n = before - this.grants.length;
    if (n) this.persist();
    return n;
  }

  list(): PermissionGrant[] {
    return this.grants.slice();
  }
}

/** Compact, single-line summary of a tool input for the permission prompt. */
export function summarizeToolInput(input: Record<string, unknown>): string {
  try {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(input ?? {})) {
      if (v === undefined || v === null) continue;
      let s = typeof v === 'string' ? v : JSON.stringify(v);
      if (s.length > 120) s = s.slice(0, 117) + '...';
      parts.push(`${k}: ${s}`);
      if (parts.length >= 4) break;
    }
    const out = parts.join(' · ');
    return out.length > 400 ? out.slice(0, 397) + '...' : out;
  } catch {
    return '';
  }
}
