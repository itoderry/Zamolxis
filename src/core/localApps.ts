import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../logger.js';

/**
 * Local-app bridges for the tool loop (usable by free/local models AND Claude):
 *  - onenote_read     — read/search OneNote notebooks via COM (desktop OneNote)
 *  - sql_query        — READ-ONLY queries against local SQL Server / LocalDB via sqlcmd
 *  - browser_history  — search Chrome/Edge/Firefox history + bookmarks (local profile files)
 *  - archive          — list/extract/create archives via 7-Zip
 * All child processes get args as arrays / env vars — nothing is string-spliced into a shell.
 */

const TIMEOUT_MS = 40_000;

function run(cmd: string, args: string[], env?: Record<string, string>, timeout = TIMEOUT_MS): Promise<{ out: string; err: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: env ? { ...process.env, ...env } : process.env, windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* gone */ }
      resolve({ out, err: err || 'timeout', code: null });
    }, timeout);
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('close', (code) => { clearTimeout(timer); resolve({ out, err, code }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ out: '', err: String(e), code: null }); });
  });
}

function clip(s: string, n = 8000): string {
  return s.length > n ? s.slice(0, n) + '\n...[truncated]' : s;
}

// ───────────────────────── OneNote (COM) ─────────────────────────

const ONENOTE_PS = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
function Out-Json($o) { Write-Output (ConvertTo-Json $o -Depth 6 -Compress) }
try {
  $on = New-Object -ComObject OneNote.Application
} catch {
  Out-Json @{ error = 'OneNote COM is unavailable (desktop OneNote from Microsoft 365/2016 is required; the Store version has no COM).' }
  exit 0
}
function Walk-Pages([xml]$x) {
  $out = @()
  foreach ($pg in $x.GetElementsByTagName('one:Page')) {
    $sec = ''; $nb = ''
    $p = $pg.ParentNode
    while ($null -ne $p) {
      if ($p.LocalName -eq 'Section' -and $sec -eq '') { $sec = [string]$p.GetAttribute('name') }
      if ($p.LocalName -eq 'Notebook') { $nb = [string]$p.GetAttribute('name'); break }
      $p = $p.ParentNode
    }
    $out += [pscustomobject]@{ notebook = $nb; section = $sec; page = [string]$pg.GetAttribute('name'); id = [string]$pg.GetAttribute('ID'); modified = [string]$pg.GetAttribute('lastModifiedTime') }
  }
  return $out
}
try {
  $action = $env:ZXON_ACTION
  if ($action -eq 'read') {
    $s = ''
    $on.GetPageContent($env:ZXON_ID, [ref]$s, 0)
    [xml]$x = $s
    $title = ''
    try { $title = [string]$x.Page.name } catch {}
    $parts = @()
    foreach ($t in $x.GetElementsByTagName('one:T')) { $parts += $t.InnerText }
    $txt = (($parts -join "\`n") -replace '<[^>]+>', '')
    if ($txt.Length -gt 8000) { $txt = $txt.Substring(0, 8000) + '...[truncated]' }
    Out-Json @{ title = $title; text = $txt }
    exit 0
  }
  $s = ''
  if ($action -eq 'search') { $on.FindPages('', $env:ZXON_QUERY, [ref]$s) } else { $on.GetHierarchy('', 4, [ref]$s) }
  [xml]$x = $s
  Out-Json @{ pages = (Walk-Pages $x) }
} catch {
  Out-Json @{ error = [string]$_.Exception.Message }
}
`;
const ONENOTE_B64 = Buffer.from(ONENOTE_PS, 'utf16le').toString('base64');

export function onenoteAvailable(): boolean {
  return process.platform === 'win32';
}

export async function onenoteRead(args: { action: string; query?: string; id?: string }): Promise<string> {
  if (!onenoteAvailable()) return 'onenote_read only works on the Windows machine where desktop OneNote is installed.';
  const action = ['notebooks', 'search', 'read'].includes(args.action) ? args.action : 'notebooks';
  if (action === 'search' && !args.query) return 'Pass `query` to search your notes.';
  if (action === 'read' && !args.id) return 'Pass `id` (a page id from notebooks/search) to read a page.';
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ONENOTE_B64], {
    ZXON_ACTION: action,
    ZXON_QUERY: args.query || '',
    ZXON_ID: args.id || '',
  });
  let d: { error?: string; title?: string; text?: string; pages?: Array<{ notebook: string; section: string; page: string; id: string; modified: string }> };
  try {
    d = JSON.parse(r.out.trim());
  } catch {
    logger.warn({ raw: r.out.slice(0, 200), err: r.err.slice(0, 200) }, 'onenote bridge returned non-JSON');
    return 'OneNote bridge error: ' + (r.err || r.out).slice(0, 300);
  }
  if (d.error) return 'OneNote: ' + d.error;
  if (d.text !== undefined) return `# ${d.title || '(untitled page)'}\n\n${d.text || '(empty page)'}`;
  const pages = d.pages ?? [];
  if (!pages.length) return action === 'search' ? `No pages matching "${args.query}".` : 'No OneNote pages found.';
  return pages.slice(0, 60).map((p, i) => `${i + 1}. ${p.notebook} / ${p.section} / ${p.page} (${(p.modified || '').slice(0, 10)})\n   id: ${p.id}`).join('\n');
}

/** Structured OneNote data for the Notes app (parsed bridge JSON). */
export async function onenoteData(args: { action: string; query?: string; id?: string }): Promise<Record<string, unknown>> {
  if (!onenoteAvailable()) return { error: 'OneNote is only available on this Windows machine.' };
  const action = ['notebooks', 'search', 'read'].includes(args.action) ? args.action : 'notebooks';
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ONENOTE_B64], {
    ZXON_ACTION: action, ZXON_QUERY: args.query || '', ZXON_ID: args.id || '',
  });
  try { return JSON.parse(r.out.trim()) as Record<string, unknown>; } catch { return { error: (r.err || r.out).slice(0, 300) }; }
}

// ───────────────────────── SQL Server / LocalDB (sqlcmd) ─────────────────────────

function sqlcmdPath(): string {
  const cands = [
    'sqlcmd',
    'C:\\Program Files\\Microsoft SQL Server\\Client SDK\\ODBC\\170\\Tools\\Binn\\SQLCMD.EXE',
    'C:\\Program Files\\Microsoft SQL Server\\Client SDK\\ODBC\\180\\Tools\\Binn\\SQLCMD.EXE',
  ];
  for (const c of cands) {
    if (c === 'sqlcmd') continue;
    try { fs.accessSync(c); return c; } catch { /* next */ }
  }
  return 'sqlcmd';
}

// ── Saved connection profiles (server/db/user/password), stored in <dataDir>/db-connections.json. ──
interface DbConn { name: string; server: string; database?: string; user?: string; password?: string }
let connFile = '';
let appDataDir = '';
export function initLocalApps(dataDir: string): void { connFile = path.join(dataDir, 'db-connections.json'); appDataDir = dataDir; }
function readConns(): DbConn[] {
  try { const a = JSON.parse(fs.readFileSync(connFile, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; }
}
function writeConns(list: DbConn[]): void { try { fs.writeFileSync(connFile, JSON.stringify(list, null, 2)); } catch (e) { logger.warn({ err: String(e) }, 'db-connections write failed'); } }
/** Connection names + servers (NO passwords) for the UI. */
export function sqlConnections(): Array<{ name: string; server: string; database?: string; user?: string; hasPassword: boolean }> {
  return readConns().map((c) => ({ name: c.name, server: c.server, database: c.database, user: c.user, hasPassword: Boolean(c.password) }));
}
export function sqlAddConnection(c: DbConn): { ok: boolean; error?: string } {
  if (!c.name || !c.server) return { ok: false, error: 'name and server are required' };
  const list = readConns().filter((x) => x.name !== c.name);
  list.push({ name: c.name, server: c.server, database: c.database || undefined, user: c.user || undefined, password: c.password || undefined });
  writeConns(list);
  return { ok: true };
}
export function sqlRemoveConnection(name: string): { ok: boolean } { writeConns(readConns().filter((x) => x.name !== name)); return { ok: true }; }

export async function sqlQuery(args: { query: string; server?: string; database?: string; user?: string; password?: string; connection?: string }): Promise<string> {
  const q = String(args.query || '').trim();
  // READ-ONLY guard: a single SELECT/WITH statement, no INTO, no second statement.
  const stripped = q.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
  if (!/^(SELECT|WITH)\b/i.test(stripped)) return 'Read-only: only a SELECT (or WITH ... SELECT) query is allowed.';
  if (/;\s*\S/.test(stripped)) return 'Read-only: a single statement only (no ";" followed by more SQL).';
  if (/\bINTO\b/i.test(stripped)) return 'Read-only: SELECT ... INTO is not allowed.';
  let server = args.server, database = args.database, user = args.user, password = args.password;
  if (args.connection) {
    const c = readConns().find((x) => x.name.toLowerCase() === String(args.connection).toLowerCase());
    if (!c) return `No saved connection named "${args.connection}". Configured: ${readConns().map((x) => x.name).join(', ') || '(none)'}.`;
    server = server || c.server; database = database || c.database; user = user || c.user; password = password || c.password;
  }
  server = server || '(localdb)\\MSSQLLocalDB';
  // -C trusts the server certificate (corporate SQL servers often use a self-signed cert); -l connect timeout.
  const a = ['-S', server, '-W', '-s', '|', '-C', '-l', '15', '-Q', q.slice(0, 4000)];
  if (user) { a.push('-U', user, '-P', password || ''); } else { a.push('-E'); }
  if (database) a.push('-d', database);
  const r = await run(sqlcmdPath(), a, undefined, 60_000);
  if (r.code !== 0 && !r.out.trim()) return 'sqlcmd failed: ' + clip(r.err || 'unknown error', 600);
  const body = clip((r.out || '').trim(), 7000);
  return body || '(no rows)';
}

/** Structured SQL result for the Database app: { columns, rows } or { error }. */
export async function sqlQueryData(args: { query: string; server?: string; database?: string; user?: string; password?: string; connection?: string }): Promise<{ columns?: string[]; rows?: string[][]; note?: string; error?: string }> {
  const txt = await sqlQuery(args);
  if (/^(Read-only|sqlcmd failed)/.test(txt)) return { error: txt };
  const lines = txt.split(/\r?\n/);
  let note = '';
  const m = lines.find((l) => /^\(\d+ rows? affected\)/.test(l.trim()));
  if (m) note = m.trim();
  const body = lines.filter((l) => l.length && !/^\(\d+ rows? affected\)/.test(l.trim()));
  if (!body.length) return { columns: [], rows: [], note: note || '(no rows)' };
  const columns = body[0]!.split('|');
  const rows = body.slice(1).filter((l) => !/^[-\s|]+$/.test(l)).map((l) => l.split('|'));
  return { columns, rows, note };
}

// ───────────────────────── Browser history / bookmarks ─────────────────────────

interface HistRow { url: string; title: string; ts: number; browser: string }

function chromiumProfiles(base: string): string[] {
  try {
    return fs.readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(base, e.name, 'History')))
      .map((e) => path.join(base, e.name));
  } catch {
    return [];
  }
}

function browserSources(): Array<{ browser: string; kind: 'chromium' | 'firefox'; dir: string }> {
  const out: Array<{ browser: string; kind: 'chromium' | 'firefox'; dir: string }> = [];
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const roam = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  for (const p of chromiumProfiles(path.join(local, 'Google', 'Chrome', 'User Data'))) out.push({ browser: 'chrome', kind: 'chromium', dir: p });
  for (const p of chromiumProfiles(path.join(local, 'Microsoft', 'Edge', 'User Data'))) out.push({ browser: 'edge', kind: 'chromium', dir: p });
  try {
    const ffRoot = path.join(roam, 'Mozilla', 'Firefox', 'Profiles');
    for (const e of fs.readdirSync(ffRoot, { withFileTypes: true })) {
      if (e.isDirectory() && fs.existsSync(path.join(ffRoot, e.name, 'places.sqlite'))) out.push({ browser: 'firefox', kind: 'firefox', dir: path.join(ffRoot, e.name) });
    }
  } catch { /* no firefox */ }
  return out;
}

/** Copy a (possibly locked) profile db to temp and open it read-only. */
async function openDbCopy(src: string): Promise<{ db: InstanceType<typeof import('node:sqlite').DatabaseSync>; tmp: string } | null> {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const tmp = path.join(os.tmpdir(), 'zx-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.db');
    fs.copyFileSync(src, tmp);
    return { db: new DatabaseSync(tmp, { readOnly: true }), tmp };
  } catch {
    return null;
  }
}

function chromeBookmarks(dir: string, browser: string, q: string): HistRow[] {
  const out: HistRow[] = [];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'Bookmarks'), 'utf8')) as { roots?: Record<string, unknown> };
    const walk = (n: { type?: string; name?: string; url?: string; date_added?: string; children?: unknown[] }): void => {
      if (n.type === 'url' && n.url) {
        if (!q || (n.name || '').toLowerCase().includes(q) || n.url.toLowerCase().includes(q)) {
          out.push({ url: n.url, title: n.name || '', ts: (Number(n.date_added || 0) / 1000 - 11644473600000) || 0, browser });
        }
      }
      for (const c of n.children || []) walk(c as never);
    };
    for (const k of Object.keys(j.roots || {})) { const root = (j.roots as Record<string, unknown>)[k]; if (root && typeof root === 'object') walk(root as never); }
  } catch { /* no bookmarks file */ }
  return out;
}

async function gatherHistory(args: { what?: string; query?: string; limit?: number; browser?: string }): Promise<HistRow[]> {
  const what = args.what === 'bookmarks' ? 'bookmarks' : 'history';
  const q = String(args.query || '').toLowerCase();
  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
  const sources = browserSources().filter((s) => !args.browser || s.browser === args.browser);
  if (!sources.length) return [];
  const rows: HistRow[] = [];
  for (const s of sources) {
    if (what === 'bookmarks' && s.kind === 'chromium') {
      rows.push(...chromeBookmarks(s.dir, s.browser, q));
      continue;
    }
    const file = s.kind === 'chromium' ? path.join(s.dir, 'History') : path.join(s.dir, 'places.sqlite');
    const h = await openDbCopy(file);
    if (!h) continue;
    try {
      // Timestamps are converted to epoch SECONDS inside SQL — raw chromium/firefox
      // microsecond values overflow JS safe integers when read directly.
      if (s.kind === 'chromium') {
        const stmt = h.db.prepare('SELECT url, title, (last_visit_time/1000000 - 11644473600) AS t FROM urls WHERE (LOWER(title) LIKE ? OR LOWER(url) LIKE ?) ORDER BY t DESC LIMIT ?');
        for (const r of stmt.all(`%${q}%`, `%${q}%`, limit) as Array<{ url: string; title: string; t: number }>) {
          rows.push({ url: r.url, title: r.title || '', ts: r.t * 1000, browser: s.browser });
        }
      } else if (what === 'history') {
        const stmt = h.db.prepare('SELECT url, title, (last_visit_date/1000000) AS t FROM moz_places WHERE (LOWER(title) LIKE ? OR LOWER(url) LIKE ?) AND last_visit_date IS NOT NULL ORDER BY t DESC LIMIT ?');
        for (const r of stmt.all(`%${q}%`, `%${q}%`, limit) as Array<{ url: string; title: string; t: number }>) {
          rows.push({ url: r.url, title: r.title || '', ts: r.t * 1000, browser: s.browser });
        }
      } else {
        const stmt = h.db.prepare('SELECT p.url AS url, b.title AS title, (b.dateAdded/1000000) AS t FROM moz_bookmarks b JOIN moz_places p ON p.id = b.fk WHERE b.type = 1 AND (LOWER(b.title) LIKE ? OR LOWER(p.url) LIKE ?) ORDER BY t DESC LIMIT ?');
        for (const r of stmt.all(`%${q}%`, `%${q}%`, limit) as Array<{ url: string; title: string; t: number }>) {
          rows.push({ url: r.url, title: r.title || '', ts: r.t * 1000, browser: s.browser });
        }
      }
    } catch (err) {
      logger.warn({ err: String(err), browser: s.browser }, 'browser db query failed');
    } finally {
      try { h.db.close(); } catch { /* */ }
      try { fs.unlinkSync(h.tmp); } catch { /* */ }
    }
  }
  const seen = new Set<string>();
  return rows.sort((a, b) => b.ts - a.ts).filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true))).slice(0, limit);
}

export async function browserHistory(args: { what?: string; query?: string; limit?: number; browser?: string }): Promise<string> {
  const what = args.what === 'bookmarks' ? 'bookmarks' : 'history';
  const merged = await gatherHistory(args);
  if (!merged.length) return args.query ? `No ${what} entries matching "${args.query}".` : `No ${what} entries found (or no browser profiles).`;
  return merged.map((r, i) => `${i + 1}. [${r.browser}] ${r.ts > 0 ? new Date(r.ts).toISOString().slice(0, 16).replace('T', ' ') : ''} ${r.title || '(no title)'}\n   ${r.url}`).join('\n');
}

export async function browserHistoryData(args: { what?: string; query?: string; limit?: number; browser?: string }): Promise<{ what: string; rows: HistRow[] }> {
  return { what: args.what === 'bookmarks' ? 'bookmarks' : 'history', rows: await gatherHistory(args) };
}

// ───────────────────────── Open in Excel (real spreadsheet, real app) ─────────────────────────

function openWithOs(file: string): void {
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', file], { detached: true, windowsHide: true }).unref();
  else if (process.platform === 'darwin') spawn('open', [file], { detached: true }).unref();
  else spawn('xdg-open', [file], { detached: true }).unref();
}

/** Write tabular data to a real .xlsx and open it in the user's spreadsheet app (Excel).
 *  Alternatively pass just `file` to open an existing spreadsheet. */
export async function openInExcel(args: { columns?: string[]; rows?: string[][]; title?: string; file?: string }): Promise<string> {
  if (args.file) {
    try { fs.accessSync(args.file); } catch { return `File not found: ${args.file}`; }
    openWithOs(args.file);
    return `Opened ${args.file} in the spreadsheet app.`;
  }
  const cols = (args.columns || []).map(String);
  const rows = (args.rows || []).map((r) => (r || []).map((v) => (v == null ? '' : v)));
  if (!cols.length && !rows.length) return 'Pass columns + rows (the data), or file (an existing spreadsheet path).';
  try {
    const mod = (await import('xlsx')) as unknown as { default?: unknown };
    const XLSX = (mod.default || mod) as { utils: { aoa_to_sheet: (a: unknown[][]) => unknown; book_new: () => unknown; book_append_sheet: (wb: unknown, ws: unknown, n: string) => void }; write: (wb: unknown, o: { type: string; bookType: string }) => Buffer };
    const ws = XLSX.utils.aoa_to_sheet([cols, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, (args.title || 'Data').slice(0, 31));
    const dir = path.join(appDataDir || os.tmpdir(), 'exports');
    fs.mkdirSync(dir, { recursive: true });
    const safe = (args.title || 'table').replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 50);
    const file = path.join(dir, `${safe}-${Date.now()}.xlsx`);
    fs.writeFileSync(file, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    openWithOs(file);
    return `Saved ${rows.length} rows × ${cols.length} columns to ${file} and opened it in Excel.`;
  } catch (err) {
    return 'Could not create the spreadsheet: ' + String((err as Error)?.message || err);
  }
}

// ───────────────────────── Archives (7-Zip) ─────────────────────────

function sevenZipPath(): string | null {
  const cands = ['C:\\Program Files\\7-Zip\\7z.exe', 'C:\\Program Files (x86)\\7-Zip\\7z.exe', '/usr/local/bin/7z', '/opt/homebrew/bin/7z', '/usr/bin/7z'];
  for (const c of cands) {
    try { fs.accessSync(c); return c; } catch { /* next */ }
  }
  return null;
}

export function archiveAvailable(): boolean {
  return sevenZipPath() !== null;
}

export async function archiveTool(args: { action: string; archive: string; dest?: string; paths?: string[] }): Promise<string> {
  const zip = sevenZipPath();
  if (!zip) return '7-Zip is not installed (looked in the standard locations).';
  const action = ['list', 'extract', 'create'].includes(args.action) ? args.action : 'list';
  const archive = String(args.archive || '');
  if (!archive) return 'Pass `archive` (path to the archive file).';
  if (action === 'list') {
    const r = await run(zip, ['l', '-ba', archive]);
    return r.code === 0 ? clip(r.out.trim() || '(empty archive)') : '7z failed: ' + clip(r.err || r.out, 500);
  }
  if (action === 'extract') {
    const dest = args.dest || archive.replace(/\.[^.\\/]+$/, '');
    const r = await run(zip, ['x', '-y', '-o' + dest, archive], undefined, 120_000);
    return r.code === 0 ? `Extracted to ${dest}` : '7z failed: ' + clip(r.err || r.out, 500);
  }
  const paths = (args.paths || []).map(String).filter(Boolean);
  if (!paths.length) return 'Pass `paths` (files/folders to put in the archive).';
  const r = await run(zip, ['a', '-y', archive, ...paths], undefined, 120_000);
  return r.code === 0 ? `Created ${archive} (${paths.length} item(s))` : '7z failed: ' + clip(r.err || r.out, 500);
}
