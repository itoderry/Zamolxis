import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
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
  // 1) A long-lived OAuth token in the env (from `claude setup-token`). This is the most
  //    reliable subscription auth for the SDK, and the recommended path on macOS where
  //    `claude login` stores the token in the Keychain (which a background SDK often can't read).
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return true;
  // 2) A credentials file (Windows/Linux, and some macOS versions).
  const candidates = [
    path.join(os.homedir(), '.claude', '.credentials.json'),
    path.join(os.homedir(), '.claude', 'credentials.json'),
  ];
  if (candidates.some((p) => fs.existsSync(p))) return true;
  // 3) macOS Keychain item created by `claude login` (best-effort; service name may vary).
  if (process.platform === 'darwin') {
    try {
      const r = spawnSync('security', ['find-generic-password', '-s', 'Claude Code-credentials'], { stdio: 'ignore' });
      if (r.status === 0) return true;
    } catch {
      /* security unavailable */
    }
  }
  return false;
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
    if (process.platform === 'darwin') {
      logger.warn('No Claude credentials found. On macOS `claude auth login` stores the token in the Keychain, which the engine often cannot read. Run `claude setup-token` and put the result in .env as CLAUDE_CODE_OAUTH_TOKEN=..., then restart.');
    } else {
      logger.warn('No Claude credentials found. Run `claude auth login` (Pro/Max/Team/Enterprise; older CLI: `claude login`), or set CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) in .env, before starting.');
    }
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
