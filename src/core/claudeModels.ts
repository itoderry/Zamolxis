import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { logger } from '../logger.js';

/**
 * Dynamic Claude model catalog. The dropdown list used to be hardcoded, so newly
 * released models (e.g. claude-fable-5) never appeared until a code change. Now we
 * ask the Anthropic API (`GET /v1/models`) with the SAME subscription OAuth token the
 * engine uses, cache the ids on disk (so an offline restart keeps the last good list),
 * and fall back to a static snapshot when no token/network is available.
 */

const ALIASES = ['', 'opus', 'sonnet', 'haiku']; // '' = CLI default; aliases always resolve to the current generation
const FALLBACK = ['claude-fable-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'];
/** Models always offered in the dropdown even if the live /v1/models list omits them.
 *  Claude 3.5 Sonnet runs through the SAME subscription OAuth path as the other Claude
 *  models, so it's free to the user (covered by the subscription, not metered API). */
const PINNED = ['claude-3-5-sonnet-latest'];

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  return list.filter((x) => (seen.has(x) ? false : (seen.add(x), true)));
}
const REFRESH_MS = 12 * 60 * 60 * 1000; // re-check twice a day

let ids: string[] = [...FALLBACK];
let cacheFile = '';
let fetchedAt = 0;

/** Subscription OAuth token candidates. The credentials file FIRST (kept fresh by Claude
 *  Code's own refresh), then the env setup-token (long-lived but can be stale/revoked). */
function oauthTokens(): string[] {
  const out: string[] = [];
  try {
    const p = path.join(os.homedir(), '.claude', '.credentials.json');
    const c = JSON.parse(fs.readFileSync(p, 'utf8')) as { claudeAiOauth?: { accessToken?: string } };
    if (c.claudeAiOauth?.accessToken) out.push(c.claudeAiOauth.accessToken);
  } catch {
    /* no credentials file */
  }
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) out.push(process.env.CLAUDE_CODE_OAUTH_TOKEN);
  return out;
}

/** Model ids only (newest first, as the API returns them), plus always-pinned extras. */
export function claudeModelIds(): string[] {
  return dedupe([...ids, ...PINNED]);
}

/** Full dropdown list: aliases + live ids + pinned extras. */
export function claudeModels(): string[] {
  return dedupe([...ALIASES, ...ids, ...PINNED]);
}

/** Fetch the live list from the API; keep the previous/fallback list on any failure. */
export async function refreshClaudeModels(): Promise<boolean> {
  let lastStatus = 0;
  for (const token of oauthTokens()) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
        headers: {
          authorization: `Bearer ${token}`,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'oauth-2025-04-20',
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        lastStatus = res.status;
        continue; // e.g. a stale env setup-token — try the next candidate
      }
      const body = (await res.json()) as { data?: Array<{ type?: string; id?: string }> };
      const live = (body.data ?? []).filter((m) => m.type === 'model' && m.id).map((m) => String(m.id));
      if (!live.length) continue;
      ids = live;
      fetchedAt = Date.now();
      if (cacheFile) {
        try {
          fs.writeFileSync(cacheFile, JSON.stringify({ ids, fetchedAt }));
        } catch {
          /* cache write is best-effort */
        }
      }
      logger.info({ count: ids.length, newest: ids[0] }, 'claude model list refreshed from API');
      return true;
    } catch (err) {
      logger.warn({ err: String(err) }, 'claude models refresh attempt failed');
    }
  }
  if (lastStatus) logger.warn({ status: lastStatus }, 'claude models refresh failed (keeping cached list)');
  return false;
}

/** Load the disk cache and start background refreshes. Call once at startup. */
export function initClaudeModels(dataDir: string): void {
  cacheFile = path.join(dataDir, 'claude-models.json');
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as { ids?: string[]; fetchedAt?: number };
    if (Array.isArray(c.ids) && c.ids.length) {
      ids = c.ids;
      fetchedAt = c.fetchedAt ?? 0;
    }
  } catch {
    /* no cache yet */
  }
  if (Date.now() - fetchedAt > REFRESH_MS) void refreshClaudeModels();
  const timer = setInterval(() => void refreshClaudeModels(), REFRESH_MS);
  timer.unref?.();
}
