import { logger } from '../logger.js';
import { jiraConfigured, searchJira } from '../tools/jira.js';
import { listWatchedIssues } from './jirawatch.js';
import { outlookAvailable, outlookMailData } from './outlookLocal.js';

/**
 * Cheap, no-LLM gate for the high-frequency watch agents. Before a scheduled/headless run spends a
 * model turn, we do one tiny API/COM call to ask "is there actually anything new?" and skip the run
 * when there clearly isn't. This is the single biggest token saver for agents that fire on a clock.
 *
 * Hard rule: FAIL OPEN. If we can't be sure (not configured the way we expect, an error, an unknown
 * shape), we return run:true and let the agent do its normal thing — a wasted run is cheap, a missed
 * alert is not. We only return run:false when we positively determined there's nothing to do.
 */
export interface PrecheckResult {
  run: boolean;
  reason?: string;
}

const RUN: PrecheckResult = { run: true };

async function jiraWatcherPrecheck(): Promise<PrecheckResult> {
  // Nothing to watch until Jira is wired up — don't burn a model turn restating that every hour.
  if (!jiraConfigured()) return { run: false, reason: 'Jira is not configured yet' };
  // If the user follows specific issues we can't peek at them without advancing the change watermark
  // (that's checkWatchedIssues' job, and it persists), so just let the agent run and do the diff.
  try {
    if (listWatchedIssues().length > 0) return RUN;
  } catch {
    return RUN;
  }
  // No watched issues → the only thing the agent reports is assigned issues that moved. Ask Jira for
  // anything assigned to me touched in the last 90 min (covers the hourly cadence with slack). This
  // is read-only and side-effect free.
  try {
    const r = await searchJira('assignee = currentUser() AND updated >= "-90m" ORDER BY updated DESC', 5);
    if (!r.ok) return RUN; // fail open on any API trouble
    return r.issues.length > 0 ? RUN : { run: false, reason: 'no assigned-issue changes in the last 90 min' };
  } catch {
    return RUN;
  }
}

async function inboxTriagePrecheck(): Promise<PrecheckResult> {
  // We can only cheaply peek the local Outlook mailbox; IMAP-only setups fall through and run.
  if (!outlookAvailable()) return RUN;
  try {
    const data = await outlookMailData({ action: 'list', unreadOnly: true, count: 3 });
    if (data && (data as { error?: unknown }).error) return RUN; // fail open
    const msgs = (data as { messages?: unknown }).messages;
    const list = Array.isArray(msgs) ? msgs : msgs ? [msgs] : [];
    return list.length > 0 ? RUN : { run: false, reason: 'no unread mail' };
  } catch {
    return RUN;
  }
}

/** Decide whether a scheduled run of `agent` is worth a model turn. Unknown agents always run. */
export async function agentPrecheck(agent: string): Promise<PrecheckResult> {
  try {
    let res: PrecheckResult = RUN;
    if (agent === 'jira-watcher') res = await jiraWatcherPrecheck();
    else if (agent === 'inbox-triage') res = await inboxTriagePrecheck();
    if (!res.run) logger.info({ agent, reason: res.reason }, 'pre-check skipped a scheduled run (nothing new)');
    return res;
  } catch (err) {
    logger.warn({ agent, err: String(err) }, 'pre-check errored — running anyway');
    return RUN;
  }
}
