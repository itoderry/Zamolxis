import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';

/**
 * Site Sentinel — the watched-URL store and health checker.
 *
 * A list of URLs is checked on an interval (the urlHealth watcher, default hourly,
 * configurable): a URL is "loading correctly" when it answers 2xx/3xx within the
 * timeout — and, when `mustContain` is set, the body contains that text. State
 * transitions (up -> down, down -> up) raise notifications; steady states stay quiet.
 * URLs are added/removed from chat via the `url_watch` tool (site-sentinel skill).
 * Persists in <dataDir>/urlwatch.json.
 */

export interface WatchedUrl {
  url: string;
  /** Optional friendly name shown in alerts/lists. */
  name?: string;
  /** Optional text the response body must contain to count as healthy. */
  mustContain?: string;
  addedAt: number;
  /** Last check outcome. */
  lastOk?: boolean;
  lastStatus?: number;
  lastMs?: number;
  lastError?: string;
  lastChecked?: number;
  /** Consecutive failures (for "down for N checks" context in alerts). */
  failCount?: number;
}

let file = '';
let urls: WatchedUrl[] = [];

function persist(): void {
  try {
    fs.writeFileSync(file, JSON.stringify(urls, null, 2));
  } catch (err) {
    logger.warn({ err: String(err) }, 'urlwatch persist failed');
  }
}

export function initUrlWatch(dataDir: string): void {
  file = path.join(dataDir, 'urlwatch.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(raw)) urls = raw.filter((u) => u && typeof u.url === 'string');
  } catch {
    /* first run */
  }
}

export function listWatchedUrls(): WatchedUrl[] {
  return urls.slice();
}

function normalize(url: string): string {
  let u = (url || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try {
    return new URL(u).toString();
  } catch {
    return '';
  }
}

export function addWatchedUrl(url: string, name?: string, mustContain?: string): { ok: boolean; url?: string; error?: string } {
  const u = normalize(url);
  if (!u) return { ok: false, error: `"${url}" is not a valid URL.` };
  if (urls.some((x) => x.url === u)) return { ok: false, error: `${u} is already being watched.` };
  urls.push({ url: u, name: name?.trim() || undefined, mustContain: mustContain?.trim() || undefined, addedAt: Date.now() });
  persist();
  logger.info({ url: u }, 'urlwatch: url added');
  return { ok: true, url: u };
}

/** Remove by exact URL, by friendly name, or by a unique substring of the URL. */
export function removeWatchedUrl(ref: string): { ok: boolean; url?: string; error?: string } {
  const r = (ref || '').trim().toLowerCase();
  if (!r) return { ok: false, error: 'Nothing to remove.' };
  const norm = normalize(ref);
  let matches = urls.filter((x) => x.url === norm || x.name?.toLowerCase() === r);
  if (!matches.length) matches = urls.filter((x) => x.url.toLowerCase().includes(r));
  if (!matches.length) return { ok: false, error: `No watched URL matches "${ref}".` };
  if (matches.length > 1) return { ok: false, error: `"${ref}" matches ${matches.length} URLs — be more specific: ${matches.map((m) => m.url).join(', ')}` };
  const gone = matches[0]!;
  urls = urls.filter((x) => x !== gone);
  persist();
  logger.info({ url: gone.url }, 'urlwatch: url removed');
  return { ok: true, url: gone.url };
}

export interface UrlCheckResult {
  url: string;
  name?: string;
  ok: boolean;
  status?: number;
  ms: number;
  error?: string;
  /** Did this check CHANGE the state (up->down or down->up)? */
  changed: boolean;
  failCount: number;
}

async function checkOne(w: WatchedUrl): Promise<UrlCheckResult> {
  const started = Date.now();
  let ok = false;
  let status: number | undefined;
  let error: string | undefined;
  try {
    const res = await fetch(w.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
      headers: { 'User-Agent': 'Giskard-SiteSentinel/1.0 (+health check)' },
    });
    status = res.status;
    ok = res.ok;
    if (ok && w.mustContain) {
      const body = await res.text();
      if (!body.includes(w.mustContain)) {
        ok = false;
        error = `response does not contain "${w.mustContain}"`;
      }
    } else {
      await res.arrayBuffer().catch(() => undefined); // drain so the socket is released
    }
    if (!ok && !error) error = `HTTP ${status}`;
  } catch (err) {
    error = String((err as Error)?.message ?? err);
  }
  const ms = Date.now() - started;
  const wasOk = w.lastOk;
  const changed = wasOk !== undefined && wasOk !== ok;
  w.lastOk = ok;
  w.lastStatus = status;
  w.lastMs = ms;
  w.lastError = ok ? undefined : error;
  w.lastChecked = Date.now();
  w.failCount = ok ? 0 : (w.failCount ?? 0) + 1;
  return { url: w.url, name: w.name, ok, status, ms, error: ok ? undefined : error, changed, failCount: w.failCount };
}

/** Check every watched URL (in parallel) and persist the new states. */
export async function checkAllUrls(): Promise<UrlCheckResult[]> {
  if (!urls.length) return [];
  const results = await Promise.all(urls.map((w) => checkOne(w)));
  persist();
  return results;
}
