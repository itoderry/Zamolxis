import { logger } from '../logger.js';

/**
 * Minimal Jira Cloud REST v3 client for the built-in Jira tools and the
 * jira-assigned watcher. Credentials (Settings → Credentials, or .env):
 *   JIRA_BASE_URL        https://your-domain.atlassian.net
 *   JIRA_EMAIL           the Atlassian account email
 *   JIRA_API_TOKEN       id.atlassian.com/manage-profile/security/api-tokens
 *   JIRA_DEFAULT_PROJECT default project key for created issues (optional)
 */

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  reporter: string;
  assignee: string;
  created: string;
  updated: string;
  url: string;
  description: string;
}

function cfg(): { baseUrl: string; email: string; token: string } | null {
  const baseUrl = (process.env.JIRA_BASE_URL || '').trim().replace(/\/+$/, '');
  const email = (process.env.JIRA_EMAIL || '').trim();
  const token = (process.env.JIRA_API_TOKEN || '').trim();
  if (!baseUrl || !email || !token) return null;
  return { baseUrl, email, token };
}

export function jiraConfigured(): boolean {
  return cfg() !== null;
}

/** Step-by-step connection instructions, shown whenever a Jira tool is used before setup. */
export const JIRA_SETUP_INSTRUCTIONS =
  'Jira is not connected yet. To link it (about a minute):\n' +
  '1. Open https://id.atlassian.com/manage-profile/security/api-tokens and click "Create API token", give it a label (e.g. "Giskard"), and copy the token.\n' +
  '2. In Giskard, open Settings → Credentials → the "jira" group and fill in:\n' +
  '   • JIRA_BASE_URL — your site, e.g. https://your-company.atlassian.net\n' +
  '   • JIRA_EMAIL — the email you log in to Jira with\n' +
  '   • JIRA_API_TOKEN — the token from step 1\n' +
  '   • JIRA_DEFAULT_PROJECT (optional) — the project key new tickets default to, e.g. PROJ\n' +
  '3. Save (credentials apply live). Then ask me again — I will confirm with your assigned issues.\n' +
  'To find your project key: open any issue in Jira; the key is the prefix before the dash (PROJ-123 → PROJ).';

export function jiraDefaultProject(): string {
  return (process.env.JIRA_DEFAULT_PROJECT || '').trim();
}

async function jfetch(pathname: string, init?: RequestInit): Promise<Response> {
  const c = cfg();
  if (!c) throw new Error('Jira is not configured (set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN in Settings → Credentials).');
  const auth = Buffer.from(`${c.email}:${c.token}`).toString('base64');
  return fetch(c.baseUrl + pathname, {
    ...init,
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
}

/** Flatten an Atlassian Document Format tree to plain text (best-effort). */
export function adfToText(node: unknown): string {
  if (!node || typeof node !== 'object') return typeof node === 'string' ? node : '';
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.type === 'text') return n.text ?? '';
  const inner = (n.content ?? []).map(adfToText).join('');
  if (n.type === 'paragraph' || n.type === 'heading' || n.type === 'listItem') return inner + '\n';
  return inner;
}

function textToAdf(text: string): unknown {
  const paragraphs = String(text || '').split(/\n{2,}/).map((p) => ({
    type: 'paragraph',
    content: p ? [{ type: 'text', text: p.replace(/\n/g, ' ') }] : [],
  }));
  return { type: 'doc', version: 1, content: paragraphs.length ? paragraphs : [{ type: 'paragraph', content: [] }] };
}

function issueUrl(key: string): string {
  return `${cfg()?.baseUrl ?? ''}/browse/${key}`;
}

export async function createJiraIssue(opts: {
  summary: string;
  description?: string;
  projectKey?: string;
  issueType?: string;
  labels?: string[];
}): Promise<{ ok: boolean; key?: string; url?: string; error?: string }> {
  const project = (opts.projectKey || jiraDefaultProject()).trim();
  if (!project) return { ok: false, error: 'No project key: pass projectKey or set JIRA_DEFAULT_PROJECT.' };
  try {
    const body = {
      fields: {
        project: { key: project },
        issuetype: { name: opts.issueType || 'Task' },
        summary: opts.summary.slice(0, 250),
        ...(opts.description ? { description: textToAdf(opts.description) } : {}),
        ...(opts.labels && opts.labels.length ? { labels: opts.labels } : {}),
      },
    };
    const r = await jfetch('/rest/api/3/issue', { method: 'POST', body: JSON.stringify(body) });
    const d = (await r.json().catch(() => ({}))) as { key?: string; errorMessages?: string[]; errors?: Record<string, string> };
    if (!r.ok || !d.key) {
      const msg = [...(d.errorMessages ?? []), ...Object.values(d.errors ?? {})].join('; ') || `HTTP ${r.status}`;
      return { ok: false, error: msg };
    }
    logger.info({ key: d.key, project }, 'jira issue created');
    return { ok: true, key: d.key, url: issueUrl(d.key) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

const ISSUE_FIELDS = ['summary', 'status', 'reporter', 'assignee', 'created', 'updated', 'description'];

function mapIssue(raw: { key: string; fields?: Record<string, unknown> }): JiraIssue {
  const f = (raw.fields ?? {}) as Record<string, { displayName?: string; name?: string } & unknown>;
  const person = (v: unknown): string => ((v as { displayName?: string } | null)?.displayName ?? '').trim() || '(unknown)';
  return {
    key: raw.key,
    summary: String((f.summary as unknown) ?? ''),
    status: ((f.status as { name?: string } | null)?.name ?? '').trim(),
    reporter: person(f.reporter),
    assignee: person(f.assignee),
    created: String((f.created as unknown) ?? ''),
    updated: String((f.updated as unknown) ?? ''),
    url: issueUrl(raw.key),
    description: adfToText(f.description).trim(),
  };
}

/** JQL search. Tries the newer /search/jql endpoint first, falls back to legacy /search. */
export async function searchJira(jql: string, maxResults = 25): Promise<{ ok: boolean; issues: JiraIssue[]; error?: string }> {
  try {
    const q = `jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&fields=${ISSUE_FIELDS.join(',')}`;
    let r = await jfetch(`/rest/api/3/search/jql?${q}`);
    if (r.status === 404) r = await jfetch(`/rest/api/3/search?${q}`);
    const d = (await r.json().catch(() => ({}))) as { issues?: Array<{ key: string; fields?: Record<string, unknown> }>; errorMessages?: string[] };
    if (!r.ok) return { ok: false, issues: [], error: (d.errorMessages ?? []).join('; ') || `HTTP ${r.status}` };
    return { ok: true, issues: (d.issues ?? []).map(mapIssue) };
  } catch (err) {
    return { ok: false, issues: [], error: String(err) };
  }
}

export async function getJiraIssue(key: string): Promise<{ ok: boolean; issue?: JiraIssue; error?: string }> {
  try {
    const r = await jfetch(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=${ISSUE_FIELDS.join(',')}`);
    const d = (await r.json().catch(() => ({}))) as { key?: string; fields?: Record<string, unknown>; errorMessages?: string[] };
    if (!r.ok || !d.key) return { ok: false, error: (d.errorMessages ?? []).join('; ') || `HTTP ${r.status}` };
    return { ok: true, issue: mapIssue(d as { key: string; fields?: Record<string, unknown> }) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** Fetch the current state of specific issue keys (any issue you can view, not just yours).
 *  Powers the watched-tasks feature; uses one JQL `key in (...)` search. */
export async function getJiraIssuesByKeys(keys: string[]): Promise<{ ok: boolean; issues: JiraIssue[]; error?: string }> {
  const list = keys.map((k) => k.trim().toUpperCase()).filter(Boolean);
  if (!list.length) return { ok: true, issues: [] };
  const jql = `key in (${list.join(',')})`;
  return searchJira(jql, Math.min(list.length, 100));
}

/** Who last set the assignee on an issue (from the changelog). '' when unknown. */
export async function whoAssigned(key: string): Promise<string> {
  try {
    const r = await jfetch(`/rest/api/3/issue/${encodeURIComponent(key)}/changelog?maxResults=100`);
    if (!r.ok) return '';
    const d = (await r.json()) as { values?: Array<{ author?: { displayName?: string }; items?: Array<{ field?: string }> }> };
    const changes = (d.values ?? []).filter((v) => (v.items ?? []).some((i) => i.field === 'assignee'));
    const last = changes[changes.length - 1];
    return last?.author?.displayName ?? '';
  } catch {
    return '';
  }
}
