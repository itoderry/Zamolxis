import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';
import { pushNotif } from './notifications.js';
import { outlookMailData } from './outlookLocal.js';
import { checkAllUrls, listWatchedUrls } from './urlwatch.js';
import { checkWatchedIssues, listWatchedIssues } from './jirawatch.js';
import { jiraConfigured } from '../tools/jira.js';

/**
 * Proactive watchers (OpenClaw-style): background checks that run on an interval and push a
 * notification when something NEW happens — without the user asking. Ships:
 *  - outlookUnread: new unread mail in the local Outlook desktop.
 *  - urlHealth:     Site Sentinel — watched URLs load correctly (alerts on down / recovered).
 *  - jiraTasks:     followed Jira issues change (status / assignee / comment-or-edit).
 * Config persists in <dataDir>/watchers.json; each watcher baselines on first run (and on
 * restart) so it never alerts on the existing backlog. urlHealth/jiraTasks are enabled by
 * default but no-op until the user adds a watched URL / followed issue.
 */

interface OutlookWatch { enabled: boolean; intervalMin: number }
interface UrlWatch { enabled: boolean; intervalMin: number }
interface JiraTasksWatch { enabled: boolean; intervalMin: number }
interface WatchConfig { outlookUnread?: OutlookWatch; urlHealth?: UrlWatch; jiraTasks?: JiraTasksWatch }

type Watchers = { outlookUnread: OutlookWatch; urlHealth: UrlWatch; jiraTasks: JiraTasksWatch };

let cfgFile = '';
const timers: NodeJS.Timeout[] = [];
let seen = new Set<string>();
let primed = false;

function readCfg(): WatchConfig {
  try { return JSON.parse(fs.readFileSync(cfgFile, 'utf8')) as WatchConfig; } catch { return {}; }
}
function clampMin(v: number | undefined, def: number, max = 1440): number {
  return Math.max(1, Math.min(max, Math.round(v || def)));
}
export function getWatchers(): Watchers {
  const c = readCfg();
  return {
    outlookUnread: c.outlookUnread || { enabled: false, intervalMin: 5 },
    urlHealth: c.urlHealth || { enabled: true, intervalMin: 60 },
    jiraTasks: c.jiraTasks || { enabled: true, intervalMin: 10 },
  };
}
export function setWatchers(patch: WatchConfig): Watchers {
  const c = readCfg();
  if (patch.outlookUnread) c.outlookUnread = { enabled: !!patch.outlookUnread.enabled, intervalMin: clampMin(patch.outlookUnread.intervalMin, 5, 120) };
  if (patch.urlHealth) c.urlHealth = { enabled: !!patch.urlHealth.enabled, intervalMin: clampMin(patch.urlHealth.intervalMin, 60) };
  if (patch.jiraTasks) c.jiraTasks = { enabled: !!patch.jiraTasks.enabled, intervalMin: clampMin(patch.jiraTasks.intervalMin, 10) };
  try { fs.writeFileSync(cfgFile, JSON.stringify(c, null, 2)); } catch (e) { logger.warn({ err: String(e) }, 'watchers config write failed'); }
  primed = false; // re-baseline on config change so we don't alert the backlog
  schedule();
  return getWatchers();
}

async function runOutlook(): Promise<void> {
  try {
    const d = await outlookMailData({ action: 'list', unreadOnly: true, count: 25 });
    const msgs = (d.messages as Array<{ id: string; from: string; subject: string }> | undefined) || [];
    if (!primed) { msgs.forEach((m) => seen.add(m.id)); primed = true; return; } // baseline, no alerts
    const fresh = msgs.filter((m) => !seen.has(m.id));
    fresh.forEach((m) => seen.add(m.id));
    fresh.reverse().forEach((m) => pushNotif('📧 ' + (m.from || 'New email'), m.subject || '(no subject)', 'mail'));
    if (fresh.length) logger.info({ count: fresh.length }, 'outlook watcher: new unread mail');
  } catch (err) {
    logger.warn({ err: String(err) }, 'outlook watcher check failed');
  }
}

/** Site Sentinel: check every watched URL; alert only on state CHANGES (down / recovered). */
async function runUrlHealth(): Promise<void> {
  try {
    if (!listWatchedUrls().length) return; // nothing to watch yet
    const results = await checkAllUrls();
    for (const r of results) {
      const label = r.name ? `${r.name} (${r.url})` : r.url;
      if (r.changed && !r.ok) pushNotif('🌐 Site DOWN: ' + (r.name || r.url), `${label}\n${r.error || 'failed'} · ${r.ms}ms`, 'url');
      else if (r.changed && r.ok) pushNotif('✅ Site recovered: ' + (r.name || r.url), `${label}\nHTTP ${r.status} · ${r.ms}ms`, 'url');
      else if (!r.ok && r.failCount === 1) pushNotif('🌐 Site DOWN: ' + (r.name || r.url), `${label}\n${r.error || 'failed'} · ${r.ms}ms`, 'url'); // first-ever check already failing
    }
    const down = results.filter((r) => !r.ok).length;
    logger.info({ checked: results.length, down }, 'url health watcher ran');
  } catch (err) {
    logger.warn({ err: String(err) }, 'url health watcher failed');
  }
}

/** Watched Jira tasks: alert when a followed issue changes (status / assignee / updated). */
async function runJiraTasks(): Promise<void> {
  try {
    if (!jiraConfigured() || !listWatchedIssues().length) return;
    const res = await checkWatchedIssues();
    if (!res.ok) { logger.warn({ err: res.error }, 'jira-tasks watcher check failed'); return; }
    for (const c of res.changed) {
      pushNotif(`🔔 Jira ${c.key} updated`, `${c.summary} [${c.status}]\n${c.changes.join('; ')}\n${c.url}`, 'jira');
    }
    if (res.changed.length) logger.info({ count: res.changed.length }, 'jira-tasks watcher: followed issues changed');
  } catch (err) {
    logger.warn({ err: String(err) }, 'jira-tasks watcher failed');
  }
}

function schedule(): void {
  while (timers.length) clearInterval(timers.pop()!);
  const w = getWatchers();
  const arm = (enabled: boolean, intervalMin: number, fn: () => Promise<void>, label: string) => {
    if (!enabled) return;
    void fn(); // prime immediately (baselines the current state)
    const t = setInterval(() => void fn(), Math.max(1, intervalMin) * 60_000);
    t.unref?.();
    timers.push(t);
    logger.info({ everyMin: intervalMin }, `${label} watcher started`);
  };
  arm(w.outlookUnread.enabled, w.outlookUnread.intervalMin, runOutlook, 'outlook inbox');
  arm(w.urlHealth.enabled, w.urlHealth.intervalMin, runUrlHealth, 'url health');
  arm(w.jiraTasks.enabled, w.jiraTasks.intervalMin, runJiraTasks, 'jira tasks');
}

export function initWatchers(dataDir: string): void {
  cfgFile = path.join(dataDir, 'watchers.json');
  schedule();
}
