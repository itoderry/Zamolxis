import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { logger } from '../logger.js';

/**
 * Subscription auth guard.
 *
 * Zamolxis must run on the user's Claude SUBSCRIPTION, which the Claude Code
 * engine uses via OAuth credentials stored by `claude login`. A metered
 * ANTHROPIC_API_KEY in the environment would silently bypass the subscription
 * and bill per token, so unless explicitly allowed we strip it from the
 * environment handed to the engine.
 */

const allowApiKey = ['1', 'true', 'yes'].includes((process.env.ZAMOLXIS_ALLOW_API_KEY ?? '').toLowerCase());

export interface AuthStatus {
  usingSubscription: boolean;
  credentialsFound: boolean;
  note: string;
}

function credentialsPresent(): boolean {
  // Stored by `claude login`; location varies (file or OS keychain).
  const candidates = [
    path.join(os.homedir(), '.claude', '.credentials.json'),
    path.join(os.homedir(), '.claude', 'credentials.json'),
  ];
  return candidates.some((p) => fs.existsSync(p));
}

export function checkAuth(): AuthStatus {
  const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const credsFound = credentialsPresent();

  if (hasApiKey && allowApiKey) {
    logger.warn('ANTHROPIC_API_KEY present and ZAMOLXIS_ALLOW_API_KEY=1 — using metered API, NOT the subscription.');
    return { usingSubscription: false, credentialsFound: credsFound, note: 'api-key (explicitly allowed)' };
  }
  if (hasApiKey) {
    logger.warn('ANTHROPIC_API_KEY detected — it will be hidden from the engine so the subscription is used. Set ZAMOLXIS_ALLOW_API_KEY=1 to override.');
  }
  if (!credsFound) {
    logger.warn('No Claude credentials file found. Run `claude login` (with a Pro/Max subscription) before starting, or the engine cannot authenticate.');
  }
  return {
    usingSubscription: true,
    credentialsFound: credsFound,
    note: credsFound ? 'subscription (OAuth)' : 'subscription expected but no creds found',
  };
}

/**
 * Inspect the stored OAuth token's expiry (best-effort; null if unreadable, e.g.
 * creds in an OS keychain). Used by `--doctor` to flag a stale login proactively.
 */
export function oauthExpiry(): { expiresAt: Date; expired: boolean } | null {
  try {
    const p = path.join(os.homedir(), '.claude', '.credentials.json');
    if (!fs.existsSync(p)) return null;
    const c = JSON.parse(fs.readFileSync(p, 'utf8')) as { claudeAiOauth?: { expiresAt?: number } };
    const ms = c.claudeAiOauth?.expiresAt;
    if (!ms) return null;
    const expiresAt = new Date(ms);
    return { expiresAt, expired: Date.now() > ms };
  } catch {
    return null;
  }
}

/** Environment to hand the engine: subscription-forced unless explicitly allowed. */
export function engineEnv(): NodeJS.ProcessEnv {
  if (allowApiKey) return process.env;
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return env;
}
