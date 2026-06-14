import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';
import { getJiraIssuesByKeys, type JiraIssue } from '../tools/jira.js';

/**
 * Watched Jira tasks — follow ANY issue you care about (not only ones assigned to you)
 * and get alerted when it changes: status moved, reassigned, or otherwise updated
 * (the `updated` timestamp advancing also catches new comments and edits).
 *
 * The list is managed from chat via the `jira_watch` tool, and the jiraWatched watcher
 * polls it on an interval. Persists in <dataDir>/jirawatch.json.
 */

export interface WatchedIssue {
  key: string;
  /** Optional reason/note the user gave for following it. */
  note?: string;
  addedAt: number;
  lastStatus?: string;
  lastAssignee?: string;
  lastUpdated?: string;
  lastSummary?: string;
}

let file = '';
let issues: WatchedIssue[] = [];

function persist(): void {
  try {
    fs.writeFileSync(file, JSON.stringify(issues, null, 2));
  } catch (err) {
    logger.warn({ err: String(err) }, 'jirawatch persist failed');
  }
}

export function initJiraWatch(dataDir: string): void {
  file = path.join(dataDir, 'jirawatch.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(raw)) issues = raw.filter((x) => x && typeof x.key === 'string');
  } catch {
    /* first run */
  }
}

export function listWatchedIssues(): WatchedIssue[] {
  return issues.slice();
}

function normKey(k: string): string {
  return (k || '').trim().toUpperCase();
}

export function addWatchedIssue(key: string, note?: string): { ok: boolean; key?: string; error?: string } {
  const k = normKey(key);
  if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(k)) return { ok: false, error: `"${key}" is not a Jira issue key (expected like PROJ-123).` };
  if (issues.some((x) => x.key === k)) return { ok: false, error: `${k} is already on your watch list.` };
  issues.push({ key: k, note: note?.trim() || undefined, addedAt: Date.now() });
  persist();
  logger.info({ key: k }, 'jirawatch: issue added');
  return { ok: true, key: k };
}

export function removeWatchedIssue(key: string): { ok: boolean; key?: string; error?: string } {
  const k = normKey(key);
  const before = issues.length;
  issues = issues.filter((x) => x.key !== k);
  if (issues.length === before) return { ok: false, error: `${k} is not on your watch list.` };
  persist();
  logger.info({ key: k }, 'jirawatch: issue removed');
  return { ok: true, key: k };
}

export interface IssueChange {
  key: string;
  url: string;
  summary: string;
  status: string;
  assignee: string;
  /** Human description of what changed since the last check (empty if first sighting baseline). */
  changes: string[];
  /** First time we have ever seen this issue's state (baseline — don't alert). */
  baseline: boolean;
}

/** Check all watched issues; updates stored state and returns the ones that CHANGED. */
export async function checkWatchedIssues(): Promise<{ ok: boolean; changed: IssueChange[]; error?: string }> {
  if (!issues.length) return { ok: true, changed: [] };
  const res = await getJiraIssuesByKeys(issues.map((x) => x.key));
  if (!res.ok) return { ok: false, changed: [], error: res.error };
  const byKey = new Map<string, JiraIssue>(res.issues.map((i) => [i.key, i]));
  const changed: IssueChange[] = [];
  for (const w of issues) {
    const cur = byKey.get(w.key);
    if (!cur) continue; // not returned (no longer visible / deleted) — leave as-is
    const baseline = w.lastUpdated === undefined;
    const diffs: string[] = [];
    if (!baseline) {
      if (cur.status !== w.lastStatus) diffs.push(`status: ${w.lastStatus} → ${cur.status}`);
      if (cur.assignee !== w.lastAssignee) diffs.push(`assignee: ${w.lastAssignee} → ${cur.assignee}`);
      if (cur.updated !== w.lastUpdated && !diffs.length) diffs.push('updated (comment or edit)');
    }
    w.lastStatus = cur.status;
    w.lastAssignee = cur.assignee;
    w.lastUpdated = cur.updated;
    w.lastSummary = cur.summary;
    if (!baseline && diffs.length) {
      changed.push({ key: cur.key, url: cur.url, summary: cur.summary, status: cur.status, assignee: cur.assignee, changes: diffs, baseline: false });
    }
  }
  persist();
  return { ok: true, changed };
}
