import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { Channel, ChannelHandler, OutboundMessage } from './types.js';
import type { ZamolxisConfig } from '../config.js';
import type { SettingsManager } from '../core/settings.js';
import type { TabsManager } from '../core/tabs.js';
import type { UsageTracker } from '../core/usage.js';
import type { SkillsManager } from '../skills/manager.js';
import type { MemoryManager } from '../core/memory.js';
import type { AgentStore } from '../core/agents.js';
import { packSetup, type PackParts } from '../core/pack.js';
import { autostartStatus, setAutostart } from '../core/autostart.js';
import { oauthExpiry } from '../core/auth.js';
import { effectiveName, tempName } from '../core/displayName.js';
import { providerStatus } from '../core/providers.js';
import { searchProviderName } from '../core/localTools.js';
import { cliProviderStatus, hasDocker, runInstall } from '../core/cliProviders.js';
import { logger } from '../logger.js';

const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];

// Build-freshness: capture when THIS process started; compare to the on-disk dist
// mtime (re-read per request). If the build is newer than the running process, the
// user rebuilt but is still running stale code — surfaced in the UI so it's obvious.
const START_TIME = Date.now();
const DIST_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // dist/
function buildInfo(): { started: number; built: number; stale: boolean } {
  let built = START_TIME;
  try {
    built = fs.statSync(path.join(DIST_DIR, 'index.js')).mtimeMs;
  } catch {
    /* ignore */
  }
  return { started: START_TIME, built, stale: built > START_TIME + 2000 };
}

// Git-update freshness: if this install is a git checkout, periodically `git fetch` and
// see whether origin is ahead. The web UI surfaces "update available" and offers a one-click
// pull + reinstall + restart. The check is cached (refreshed at most every 5 min) and never
// blocks a request; a non-git install or an offline box just reports isRepo:false / behind:0.
const REPO_ROOT = path.dirname(DIST_DIR); // dist/.. = repo root
const pexec = promisify(execFile);
// Resolve a usable `git` even when the daemon's PATH is minimal (common on macOS when started
// detached / via a launcher — git is at /usr/bin/git but may not be on the inherited PATH).
function resolveGit(): string {
  const cands: string[] = ['git'];
  if (process.platform === 'win32') {
    // Git is often NOT on the daemon's PATH (esp. when started via autostart/login). Probe the
    // standard install locations and `where git` so update-check works regardless of PATH.
    try {
      const w = spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true });
      if (w.status === 0) {
        const first = (w.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
        if (first) cands.push(first);
      }
    } catch {
      /* where unavailable */
    }
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const la = process.env['LOCALAPPDATA'] || '';
    cands.push(path.join(pf, 'Git', 'cmd', 'git.exe'), path.join(pf, 'Git', 'bin', 'git.exe'), path.join(pf86, 'Git', 'cmd', 'git.exe'));
    if (la) cands.push(path.join(la, 'Programs', 'Git', 'cmd', 'git.exe'));
  } else {
    cands.push('/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git');
  }
  for (const c of cands) {
    try {
      if (spawnSync(c, ['--version'], { stdio: 'ignore', windowsHide: true }).status === 0) return c;
    } catch {
      /* try next candidate */
    }
  }
  return 'git';
}
const GIT_BIN = resolveGit();

// Version shown in the UI: package.json semver (human-bumped per release) + a build number that
// counts commits SINCE the current version was set in package.json (so a version bump resets the
// build to 0) + the short commit SHA. Computed ONCE at startup. Non-git installs fall back to 0.
const VERSION = (() => {
  let pkg = '0.0.0';
  try {
    pkg = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version?: string }).version || pkg;
  } catch {
    /* keep default */
  }
  let commit = '';
  let build = 0;
  try {
    // The commit that last set this version in package.json — build counts commits AFTER it.
    const bump = spawnSync(GIT_BIN, ['log', '-1', '--format=%H', '-S', `"version": "${pkg}"`, '--', 'package.json'], { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true });
    const since = bump.status === 0 ? (bump.stdout || '').trim() : '';
    const range = since ? [`${since}..HEAD`] : ['HEAD'];
    const r = spawnSync(GIT_BIN, ['rev-list', '--count', ...range], { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true });
    if (r.status === 0) build = parseInt((r.stdout || '').trim(), 10) || 0;
    const s = spawnSync(GIT_BIN, ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true });
    if (s.status === 0) commit = (s.stdout || '').trim();
  } catch {
    /* not a git checkout */
  }
  return { pkg, build, commit };
})();

type UpdateState = { isRepo: boolean; behind: number; local: string; remote: string; branch: string; checkedAt: number };
let UPDATE: UpdateState = { isRepo: false, behind: 0, local: '', remote: '', branch: '', checkedAt: 0 };
let UPDATE_CHECKING = false;
async function refreshUpdate(): Promise<void> {
  if (UPDATE_CHECKING) return;
  UPDATE_CHECKING = true;
  const git = (args: string[], timeout = 8000) => pexec(GIT_BIN, args, { cwd: REPO_ROOT, timeout, windowsHide: true });
  try {
    await git(['rev-parse', '--is-inside-work-tree']);
    const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    let fetched = true;
    try {
      await git(['fetch', '--quiet', 'origin'], 30000);
    } catch (err) {
      fetched = false; // offline, no remote, or git unusable — fall back to existing refs
      logger.debug({ err: String(err) }, 'update-check: git fetch failed');
    }
    const local = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    let remote = '';
    let behind = 0;
    try {
      remote = (await git(['rev-parse', '@{u}'])).stdout.trim();
      behind = parseInt((await git(['rev-list', '--count', 'HEAD..@{u}'])).stdout.trim(), 10) || 0;
    } catch (err) {
      logger.debug({ err: String(err) }, 'update-check: no upstream branch configured');
    }
    UPDATE = { isRepo: true, behind, local: local.slice(0, 7), remote: remote.slice(0, 7), branch, checkedAt: Date.now() };
    logger.info({ branch, behind, local: UPDATE.local, remote: UPDATE.remote, fetched, gitBin: GIT_BIN }, 'update-check');
  } catch (err) {
    UPDATE = { isRepo: false, behind: 0, local: '', remote: '', branch: '', checkedAt: Date.now() };
    logger.info({ err: String(err), gitBin: GIT_BIN, repoRoot: REPO_ROOT }, 'update-check: not a git checkout or git unavailable');
  } finally {
    UPDATE_CHECKING = false;
  }
}
function maybeRefreshUpdate(): void {
  if (UPDATE_CHECKING) return;
  if (UPDATE.checkedAt && Date.now() - UPDATE.checkedAt < 5 * 60 * 1000) return;
  void refreshUpdate();
}

/**
 * Browser interface: a chat web page + Settings panel + agent-managed dashboard
 * tabs, served over HTTP with a WebSocket for streaming replies. Binds to
 * 127.0.0.1 by default; exposing on the network requires ZAMOLXIS_WEB_AUTH_TOKEN.
 */
/** Curated general-chat all-rounders offered in the Local-model panel — all tool-capable in Ollama.
 *  `need` = approx GB to run the Q4 build comfortably (for the UI hint). Mirrors the installer. */
const OLLAMA_CATALOG: Array<{ id: string; need: number; desc: string }> = [
  { id: 'llama3.2:1b', need: 2, desc: 'Tiny & fast - routing / simple offload (general, tools).' },
  { id: 'llama3.2:3b', need: 4, desc: 'Light all-rounder, fully GPU; broad general chat.' },
  { id: 'mistral:7b', need: 5, desc: 'Lean, friendly general chat - fast.' },
  { id: 'llama3.1:8b', need: 6, desc: 'Dependable all-rounder + reliable tool calling.' },
  { id: 'hermes3:8b', need: 6, desc: 'Most natural general chat (Llama-3.1 tune), strong tools.' },
  { id: 'mistral-nemo', need: 8, desc: 'Smarter all-rounder, multilingual (uses RAM on small GPUs).' },
  { id: 'mixtral:8x7b', need: 26, desc: 'Strong general MoE - needs a big GPU.' },
  { id: 'llama3.3:70b', need: 42, desc: 'Best local general model - needs a large GPU.' },
];

export class WebChannel implements Channel {
  readonly name = 'web';
  /** In-flight / finished Ollama pulls, surfaced as progress in the Local-model panel. */
  private readonly ollamaPulls = new Map<string, { status: string; pct: number; done: boolean; error?: string }>();
  /** State of an in-progress "install Ollama" run (null = never started). */
  private ollamaInstall: { running: boolean; done: boolean; error?: string; log: string } | null = null;
  private server?: http.Server;
  private wss?: WebSocketServer;
  private handler?: ChannelHandler;
  private readonly sockets = new Map<string, WebSocket>();

  constructor(
    private readonly config: ZamolxisConfig,
    private readonly settings: SettingsManager,
    private readonly onReload?: () => Promise<void>,
    private readonly forget?: (conversationKey: string) => boolean,
    private readonly tabs?: TabsManager,
    private readonly usage?: UsageTracker,
    private readonly skills?: SkillsManager,
    private readonly memory?: MemoryManager,
    private readonly agentStore?: AgentStore,
    private readonly runAgent?: (name: string, task?: string) => Promise<{ reply: string; via?: string }>,
    /** Live agent-message log (agent->agent and agent->user), polled by the Agents chat. */
    private readonly agentMsgs?: Array<{ from: string; to: string; text: string; ts: number }>,
    /** Schedule a named agent on a cron expression (deterministic — does not rely on the model). */
    private readonly scheduleAgent?: (name: string, cron: string, task?: string) => { id: string },
    /** List active agent schedules (for the rail). */
    private readonly listAgentSchedules?: () => Array<{ id: string; agent?: string; cron?: string; at?: string; prompt: string }>,
    /** Cancel a schedule by id. */
    private readonly cancelSchedule?: (id: string) => boolean,
    /** Compile an agent's NL job into an executable plan via the smart model (planner/executor). */
    private readonly compileAgent?: (name: string) => Promise<{
      ok: boolean;
      executor?: string;
      skills?: string[];
      codeTools?: { name: string }[];
      risk?: { level: string; note: string; recommendedModel?: string };
      schedule?: { cron: string; task?: string; humanReadable?: string };
    }>,
    /** Convert a plain-language schedule to a cron expression via the smart model. */
    private readonly nlToCron?: (text: string) => Promise<{ cron?: string; note: string }>,
    /** Stop (suspend all schedules + halt) or resume an agent. */
    private readonly stopAgent?: (name: string, stop: boolean) => Promise<{ ok: boolean; suspended: number; stopped: boolean }>,
    /** Analyze an agent: smart model reviews recent outputs and improves its spec. */
    private readonly analyzeAgent?: (name: string) => Promise<{ ok: boolean; assessment?: string; changed?: boolean; note?: string }>,
    /** Recent turns for a conversation key (to restore chat history when switching threads). */
    private readonly getHistory?: (conversationKey: string) => Array<{ role: string; text: string; ts: number }>,
    /** Per-(model, skill) ban list management + the capability/model vocab (for the / autocomplete). */
    private readonly banApi?: {
      list: () => Array<{ model: string; skill: string }>;
      add: (model: string, skill: string) => { ok: boolean; reason?: string };
      remove: (model: string, skill: string) => boolean;
      capabilities: () => string[];
      models: () => string[];
    },
  ) {
    const { bind, authToken } = config.web;
    if (!LOOPBACK.includes(bind) && !authToken) {
      throw new Error(
        'web channel bound to a non-loopback address requires ZAMOLXIS_WEB_AUTH_TOKEN (refusing to expose an unauthenticated agent that can run commands).',
      );
    }
  }

  async start(handler: ChannelHandler): Promise<void> {
    this.handler = handler;
    this.server = http.createServer((req, res) => this.onHttp(req, res));
    this.server.on('error', (err) => {
      logger.error(
        { err: String(err), port: this.config.web.port },
        'web server error (is another Zamolxis already using this port? change ZAMOLXIS_WEB_PORT or stop the other instance)',
      );
    });
    this.wss = new WebSocketServer({ noServer: true });

    this.server.on('upgrade', (req, socket, head) => {
      if (!this.authOk(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.onWs(ws, req));
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.config.web.port, this.config.web.bind, () => {
        const exposed = !LOOPBACK.includes(this.config.web.bind);
        logger.info(
          { url: `http://${this.config.web.bind}:${this.config.web.port}`, auth: this.config.web.authToken ? 'token' : 'none', exposed },
          'web channel listening',
        );
        resolve();
      });
    });
  }

  private tokenFromReq(req: http.IncomingMessage): string | undefined {
    const url = new URL(req.url ?? '/', 'http://x');
    const q = url.searchParams.get('token');
    if (q) return q;
    const h = req.headers['x-zamolxis-token'];
    if (typeof h === 'string') return h;
    const a = req.headers.authorization;
    if (typeof a === 'string' && a.startsWith('Bearer ')) return a.slice(7);
    return undefined;
  }

  private authOk(req: http.IncomingMessage): boolean {
    const token = this.config.web.authToken;
    if (!token) return true;
    if (LOOPBACK.includes(this.config.web.bind)) return true;
    return this.tokenFromReq(req) === token;
  }

  private json(res: http.ServerResponse, code: number, body: unknown): void {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private onHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://x');

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      const name = effectiveName(this.config.agentName).replace(/[<>'"`\\]/g, '');
      res.end(PAGE.replace(/__AGENT_NAME__/g, name));
      return;
    }
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (url.pathname === '/help') {
      let md = 'Help is unavailable (HELP.md not found).';
      try { md = fs.readFileSync(path.join(REPO_ROOT, 'HELP.md'), 'utf8'); } catch { /* missing */ }
      const escd = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const html = `<!doctype html><meta charset="utf-8"><title>Zamolxis — Help</title><style>body{margin:0;background:#0c0a07;color:#e8e2d4;font:15px/1.6 system-ui,Segoe UI,Roboto,sans-serif}main{max-width:860px;margin:0 auto;padding:28px 22px}pre{white-space:pre-wrap;word-wrap:break-word;font:inherit}a{color:#d4a55a}code{background:#1a150d;padding:1px 5px;border-radius:5px}</style><main><pre>${escd}</pre></main>`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (url.pathname === '/api/settings') {
      if (!this.authOk(req)) return this.json(res, 401, { error: 'unauthorized' });
      if (req.method === 'GET') return this.json(res, 200, this.settings.snapshot());
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try {
            const { snapshot, restartRequired } = this.settings.update(JSON.parse(body || '{}'));
            this.json(res, 200, { ...snapshot, restartRequired });
            if (restartRequired && this.onReload) {
              setTimeout(() => this.onReload!().catch((err) => logger.error({ err: String(err) }, 'reload failed')), 300);
            }
          } catch (err) {
            this.json(res, 400, { error: String(err) });
          }
        });
        return;
      }
    }
    if (url.pathname === '/api/status' && req.method === 'GET') {
      if (!this.authOk(req)) return this.json(res, 401, { error: 'unauthorized' });
      maybeRefreshUpdate(); // non-blocking; result lands in a later poll
      const exp = oauthExpiry();
      const now = new Date();
      const snap = this.usage?.snapshot();
      const tn = tempName();
      return this.json(res, 200, {
        agentName: effectiveName(this.config.agentName),
        tempUntil: tn ? tn.until : null,
        time: now.getTime(),
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        tzOffsetMin: now.getTimezoneOffset(),
        // "found" also when a CLAUDE_CODE_OAUTH_TOKEN is set: the engine authenticates off that env
        // token (no credentials.json / expiry). On macOS `claude login` writes only to the Keychain,
        // so credentials.json is absent and the UI must not hide Claude when the token is present.
        auth: exp
          ? { found: true, expiresAt: exp.expiresAt.getTime(), expired: exp.expired }
          : { found: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN), expiresAt: null, expired: false },
        models: {
          primary: this.config.model || 'default',
          fast: this.config.fastModel || null,
          local: this.config.localModel?.model || null,
        },
        build: buildInfo(),
        version: VERSION,
        update: UPDATE,
        localRouting: this.config.localRouting,
        last: snap?.last ?? null,
        engineTokens: { session: snap?.engine.session.totals.total ?? 0, total: snap?.engine.total.totals.total ?? 0 },
      });
    }
    if (url.pathname === '/api/tabs' && req.method === 'GET') {
      if (!this.authOk(req)) return this.json(res, 401, { error: 'unauthorized' });
      return this.json(res, 200, this.tabs?.list() ?? []);
    }
    if (url.pathname === '/api/usage' && req.method === 'GET') {
      if (!this.authOk(req)) return this.json(res, 401, { error: 'unauthorized' });
      return this.json(res, 200, this.usage?.snapshot() ?? null);
    }
    if (url.pathname === '/api/providers' && req.method === 'GET') {
      if (!this.authOk(req)) return this.json(res, 401, { error: 'unauthorized' });
      {
        const exp = oauthExpiry();
        const has = (k: string) => Boolean(process.env[k]);
        return this.json(res, 200, {
          providers: providerStatus(),
          routeChain: this.config.routeChain,
          localModel: this.config.localModel?.model || null,
          claude: {
            // Also "found" when the engine's CLAUDE_CODE_OAUTH_TOKEN env is set (no credentials.json needed).
            found: Boolean(exp) || Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN),
            expired: exp ? exp.expired : false,
            primary: this.config.model || '(cli default)',
            fast: this.config.fastModel || '-',
            smart: this.config.smartModel || 'opus',
          },
          searchProvider: searchProviderName(),
          search: [
            { envKey: 'TAVILY_API_KEY', label: 'Tavily', set: has('TAVILY_API_KEY'), signup: 'https://app.tavily.com' },
            { envKey: 'BRAVE_API_KEY', label: 'Brave Search', set: has('BRAVE_API_KEY'), signup: 'https://brave.com/search/api/' },
          ],
          cli: cliProviderStatus(),
          dockerInstalled: hasDocker(),
        });
      }
    }
    if (url.pathname === '/api/install') {
      if (!this.authOk(req)) return this.json(res, 401, { error: 'unauthorized' });
      if (req.method === 'GET') return this.json(res, 200, { docker: hasDocker(), cli: cliProviderStatus() });
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', async () => {
          try {
            const target = String(JSON.parse(body || '{}').target || '');
            const r = await runInstall(target);
            this.json(res, 200, r);
          } catch (err) {
            this.json(res, 400, { error: String(err) });
          }
        });
        return;
      }
    }
    if (url.pathname === '/api/uninstall' && req.method === 'POST') {
      if (!this.authOk(req)) return this.json(res, 401, { error: 'unauthorized' });
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let purge = false;
        try {
          purge = Boolean(JSON.parse(body || '{}').purge);
        } catch {
          /* default: keep data */
        }
        this.json(res, 200, { ok: true, uninstalling: true, purge });
        // Detached `zamolxis uninstall --yes [--purge]`: stops this daemon, removes the service,
        // unlinks the global command, and (only with --purge) deletes the data dir. Detached so
        // it survives the stop it performs. The program folder is left for the user to delete.
        try {
          const bin = fileURLToPath(new URL('../../bin/zamolxis.mjs', import.meta.url));
          const root = fileURLToPath(new URL('../../', import.meta.url));
          const args = [bin, 'uninstall', '--yes', ...(purge ? ['--purge'] : [])];
          logger.warn({ purge }, 'web-triggered uninstall');
          const child = spawn(process.execPath, args, { cwd: root, detached: true, stdio: 'ignore', windowsHide: true });
          child.unref();
        } catch (err) {
          logger.warn({ err: String(err) }, 'web uninstall spawn failed');
        }
      });
      return;
    }
    if (url.pathname === '/api/restart' && req.method === 'POST') {
      if (!this.authOk(req)) return this.json(res, 401, { error: 'unauthorized' });
      this.json(res, 200, { ok: true, restarting: true });
      // Spawn a DETACHED `zamolxis restart` so it outlives this process: it stops this daemon
      // (frees the port) and starts a fresh one on the new build. Triggered by the web UI's
      // "outdated build — click to restart" alert.
      try {
        const bin = fileURLToPath(new URL('../../bin/zamolxis.mjs', import.meta.url));
        const root = fileURLToPath(new URL('../../', import.meta.url));
        logger.info('web-triggered restart');
        const child = spawn(process.execPath, [bin, 'restart'], { cwd: root, detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
      } catch (err) {
        logger.warn({ err: String(err) }, 'web restart spawn failed');
      }
      return;
    }
    if (url.pathname === '/api/checkupdate' && req.method === 'POST') {
      if (!this.authOk(req)) return this.json(res, 401, { error: 'unauthorized' });
      // Force an immediate git fetch + behind-count (bypasses the ~5-min poll cache) and return it.
      refreshUpdate().then(() => this.json(res, 200, UPDATE)).catch((err) => this.json(res, 500, { error: String(err) }));
      return;
    }
    if (url.pathname === '/api/update' && req.method === 'POST') {
      if (!this.authOk(req)) return this.json(res, 401, { error: 'unauthorized' });
      this.json(res, 200, { ok: true, updating: true });
      // Spawn a DETACHED `zamolxis update`: it git-pulls, reinstalls, rebuilds, then restarts the
      // daemon. Detached so it survives the restart it performs. Triggered by the UI's
      // "update available" alert. (A broken pull/build aborts WITHOUT restarting - see bin.)
      try {
        const bin = fileURLToPath(new URL('../../bin/zamolxis.mjs', import.meta.url));
        const root = fileURLToPath(new URL('../../', import.meta.url));
        logger.info('web-triggered update (git pull + install + build + restart)');
        const child = spawn(process.execPath, [bin, 'update'], { cwd: root, detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
      } catch (err) {
        logger.warn({ err: String(err) }, 'web update spawn failed');
      }
      return;
    }
    if (url.pathname === '/api/upload' && req.method === 'POST') {
      if (!this.authOk(req)) return this.json(res, 401, { error: 'unauthorized' });
      // Accept a single file as base64 JSON ({chatId,name,contentB64}); save it under
      // <dataDir>/uploads/<chatId>/ and return the absolute path. The chat message then
      // references that path so the agent reads it with its file tools (Read/PDF/docx/...).
      let body = '';
      let tooBig = false;
      req.on('data', (c) => {
        body += c;
        if (body.length > 35_000_000) {
          tooBig = true;
          req.destroy();
        }
      });
      req.on('end', () => {
        if (tooBig) return this.json(res, 413, { error: 'file too large (25 MB max)' });
        try {
          const o = JSON.parse(body || '{}');
          const b64 = String(o.contentB64 || '');
          if (!b64) return this.json(res, 400, { error: 'no content' });
          const buf = Buffer.from(b64, 'base64');
          if (buf.length > 25 * 1024 * 1024) return this.json(res, 413, { error: 'file too large (25 MB max)' });
          const safeCid = String(o.chatId || 'web').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'web';
          const safeName = String(o.name || 'file').replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 120) || 'file';
          const dir = path.join(this.config.dataDir, 'uploads', safeCid);
          fs.mkdirSync(dir, { recursive: true });
          const dest = path.join(dir, `${Date.now()}-${safeName}`);
          fs.writeFileSync(dest, buf);
          logger.info({ dest, bytes: buf.length }, 'web upload saved');
          return this.json(res, 200, { ok: true, path: dest, name: safeName, bytes: buf.length });
        } catch (err) {
          return this.json(res, 400, { error: String(err) });
        }
      });
      return;
    }
    if (url.pathname === '/api/pack' && req.method === 'POST') {
      if (!this.authOk(req)) return this.json(res, 401, { error: 'unauthorized' });
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const o = JSON.parse(body || '{}');
          // ALWAYS bundles every skill. NEVER bundles settings/credentials (API keys,
          // the HA token, etc.) — those stay on this machine. Persona/profile/teachings opt-in.
          const parts: PackParts = {};
          if (o.soul && this.memory) parts.soul = this.memory.getSoul();
          if (o.user && this.memory) parts.user = this.memory.getUser();
          if (o.learnings && this.memory) parts.learnings = this.memory.getLearnings();
          const stamp = new Date().toISOString();
          const r = packSetup(this.config.skillsDir, path.join(this.config.dataDir, 'exports'), parts, stamp);
          const content = fs.readFileSync(r.path);
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-disposition': `attachment; filename="${path.basename(r.path)}"`,
            'x-pack-skills': String(r.skills),
          });
          res.end(content);
        } catch (err) {
          this.json(res, 400, { error: String(err) });
        }
      });
      return;
    }
    if (url.pathname === '/api/agents') {
      if (!this.authOk(req)) return this.json(res, 401, { error: 'unauthorized' });
      if (req.method === 'GET') return this.json(res, 200, this.agentStore?.list() ?? []);
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', async () => {
          try {
            const o = JSON.parse(body || '{}');
            const action = String(o.action || '');
            if (!this.agentStore) return this.json(res, 400, { error: 'agents unavailable' });
            if (action === 'create') {
              const name = this.agentStore.upsert({ name: String(o.name || ''), job: String(o.job || ''), tools: Array.isArray(o.tools) ? o.tools : undefined, model: o.model ? String(o.model) : undefined, canElevate: typeof o.canElevate === 'boolean' ? o.canElevate : undefined, open: typeof o.open === 'boolean' ? o.open : undefined, autostart: typeof o.autostart === 'boolean' ? o.autostart : undefined, createdBy: 'user' });
              // Planner: the smart model compiles the NL job into an executable plan (skills, code tools,
              // executor tier, risk) so the cheap executor follows a script instead of improvising.
              let plan = null;
              if (this.compileAgent && o.compile !== false) {
                try { plan = await this.compileAgent(name); } catch { /* best-effort; the agent still runs on its raw job */ }
              }
              return this.json(res, 200, { ok: true, name, plan, agents: this.agentStore.list() });
            }
            if (action === 'delete') {
              return this.json(res, 200, { ok: this.agentStore.remove(String(o.name || '')), agents: this.agentStore.list() });
            }
            if (action === 'run') {
              if (!this.runAgent) return this.json(res, 400, { error: 'cannot run agents here' });
              const name = String(o.name || '');
              const task = o.task ? String(o.task) : undefined;
              // 'run' is one-shot, but if the task states a cadence ("every minute"), also set up a
              // recurring schedule — that's what the user means by "every minute tell me ...".
              let scheduled: { cron: string; note?: string } | null = null;
              const hasSchedule = this.listAgentSchedules ? this.listAgentSchedules().some((s) => s.agent === name) : false;
              if (task && this.scheduleAgent && this.nlToCron && !hasSchedule &&
                  /\b(every|each|hourly|daily|weekly|minute|minutes|hour|hours|morning|evening|night|noon|midnight|weekday|weekdays|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(task)) {
                const c = await this.nlToCron(task);
                if (c.cron) { this.scheduleAgent(name, c.cron, undefined); scheduled = { cron: c.cron, note: c.note }; }
              }
              const r = await this.runAgent(name, task);
              return this.json(res, 200, { ok: true, reply: r.reply, via: r.via, scheduled, schedules: this.listAgentSchedules ? this.listAgentSchedules() : [] });
            }
            if (action === 'schedule') {
              if (!this.scheduleAgent) return this.json(res, 400, { error: 'scheduling unavailable' });
              const name = String(o.name || '');
              if (!this.agentStore.get(name)) return this.json(res, 400, { error: 'no such agent' });
              let cron = String(o.cron || '').trim();
              let note = '';
              // Plain-language schedule ("every 5 minutes", "weekdays at 9am") -> cron via the smart model.
              if (!cron && o.when && this.nlToCron) {
                const r = await this.nlToCron(String(o.when));
                if (!r.cron) return this.json(res, 400, { error: 'Could not read that schedule. Try e.g. "every 5 minutes" or "weekdays at 9am".' });
                cron = r.cron;
                note = r.note;
              }
              if (!cron) return this.json(res, 400, { error: 'cron or when required' });
              const j = this.scheduleAgent(name, cron, o.task ? String(o.task) : undefined);
              return this.json(res, 200, { ok: true, id: j.id, cron, note, schedules: this.listAgentSchedules ? this.listAgentSchedules() : [] });
            }
            if (action === 'stop') {
              if (!this.stopAgent) return this.json(res, 400, { error: 'stop unavailable' });
              const r = await this.stopAgent(String(o.name || ''), o.stop !== false);
              return this.json(res, 200, { ok: r.ok, stopped: r.stopped, suspended: r.suspended, agents: this.agentStore.list(), schedules: this.listAgentSchedules ? this.listAgentSchedules() : [] });
            }
            if (action === 'analyze') {
              if (!this.analyzeAgent) return this.json(res, 400, { error: 'analyze unavailable' });
              const r = await this.analyzeAgent(String(o.name || ''));
              return this.json(res, 200, { ok: r.ok, assessment: r.assessment, changed: r.changed, note: r.note, agents: this.agentStore.list() });
            }
            if (action === 'schedules') {
              return this.json(res, 200, { ok: true, schedules: this.listAgentSchedules ? this.listAgentSchedules() : [] });
            }
            if (action === 'unschedule') {
              const ok = this.cancelSchedule ? this.cancelSchedule(String(o.id || '')) : false;
              return this.json(res, 200, { ok, schedules: this.listAgentSchedules ? this.listAgentSchedules() : [] });
            }
            return this.json(res, 400, { error: 'unknown action' });
          } catch (err) {
            this.json(res, 400, { error: String(err) });
          }
        });
        return;
      }
    }
    if (url.pathname === '/api/autostart') {
      if (!this.authOk(req)) return this.json(res, 401, { error: 'unauthorized' });
      if (req.method === 'GET') return this.json(res, 200, autostartStatus());
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try {
            const o = JSON.parse(body || '{}');
            this.json(res, 200, setAutostart(!!o.enabled));
          } catch (err) {
            this.json(res, 400, { error: String(err) });
          }
        });
        return;
      }
    }
    if (url.pathname === '/api/history' && req.method === 'GET') {
      if (!this.authOk(req)) return this.json(res, 401, { error: 'unauthorized' });
      const cidp = url.searchParams.get('cid') || '';
      // The main chat shares the bridged "main" key; other web threads use "web:<cid>".
      const key = cidp === 'main' ? 'main' : `web:${cidp}`;
      return this.json(res, 200, this.getHistory ? this.getHistory(key) : []);
    }
    if (url.pathname === '/api/agentmsgs' && req.method === 'GET') {
      if (!this.authOk(req)) return this.json(res, 401, { error: 'unauthorized' });
      const since = Number(url.searchParams.get('since') || 0) || 0;
      return this.json(res, 200, (this.agentMsgs ?? []).filter((m) => m.ts > since).slice(-100));
    }
    if (url.pathname === '/api/bans') {
      if (!this.authOk(req)) return this.json(res, 401, { error: 'unauthorized' });
      if (!this.banApi) return this.json(res, 200, { bans: [], capabilities: [], models: [] });
      if (req.method === 'GET') return this.json(res, 200, { bans: this.banApi.list(), capabilities: this.banApi.capabilities(), models: this.banApi.models() });
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        return void req.on('end', () => {
          try {
            const o = JSON.parse(body || '{}') as { action?: string; model?: string; skill?: string };
            const model = String(o.model || '').trim();
            const skill = String(o.skill || '').trim();
            if (o.action === 'remove') {
              const removed = this.banApi!.remove(model, skill);
              return this.json(res, 200, { ok: removed, bans: this.banApi!.list() });
            }
            const r = this.banApi!.add(model, skill);
            return this.json(res, r.ok ? 200 : 400, { ok: r.ok, reason: r.reason, bans: this.banApi!.list() });
          } catch {
            return this.json(res, 400, { error: 'bad request' });
          }
        });
      }
    }
    if (url.pathname === '/api/local') {
      if (!this.authOk(req)) return this.json(res, 401, { error: 'unauthorized' });
      if (req.method === 'GET') return void this.localStatus().then((s) => this.json(res, 200, s));
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        return void req.on('end', async () => {
          try {
            const o = JSON.parse(body || '{}') as { action?: string; model?: string; value?: unknown };
            const model = String(o.model || '').trim();
            if (o.action === 'use' && model) { this.settings.update({ live: { localModel: model } }); return this.json(res, 200, await this.localStatus()); }
            if (o.action === 'routing') { this.settings.update({ live: { localRouting: o.value === 'auto' ? 'auto' : 'off' } }); return this.json(res, 200, await this.localStatus()); }
            if (o.action === 'context') { this.settings.update({ live: { localContext: Number(o.value) || 0 } }); return this.json(res, 200, await this.localStatus()); }
            if (o.action === 'keepalive') { this.settings.update({ live: { localKeepAlive: String(o.value ?? '') } }); return this.json(res, 200, await this.localStatus()); }
            if (o.action === 'temp') { this.settings.update({ live: { localTemp: o.value === '' || o.value === null ? null : Number(o.value) } }); return this.json(res, 200, await this.localStatus()); }
            if (o.action === 'test' && model) { return this.json(res, 200, await this.testLocalModel(model)); }
            if (o.action === 'pull' && model) { this.startOllamaPull(model); return this.json(res, 200, await this.localStatus()); }
            if (o.action === 'delete' && model) {
              if (this.config.localModel?.model === model) return this.json(res, 400, { error: 'That is the active model; switch to another first.' });
              const r = await fetch(this.ollamaBase() + '/api/delete', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: model }) }).catch(() => null);
              this.ollamaPulls.delete(model);
              return this.json(res, 200, { ok: !!(r && r.ok), ...(await this.localStatus()) });
            }
            if (o.action === 'install-ollama') { this.startOllamaInstall(); return this.json(res, 200, await this.localStatus()); }
            return this.json(res, 400, { error: 'unknown action' });
          } catch {
            return this.json(res, 400, { error: 'bad request' });
          }
        });
      }
    }
    if (url.pathname === '/api/skills') {
      if (!this.authOk(req)) return this.json(res, 401, { error: 'unauthorized' });
      if (req.method === 'GET') return this.json(res, 200, this.skills?.detailsAll() ?? []);
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try {
            const { action, slug, slugs } = JSON.parse(body || '{}');
            let ok = false;
            if (this.skills && action === 'import' && Array.isArray(slugs)) {
              ok = this.skills.importMany(slugs.filter((x: unknown) => typeof x === 'string')) > 0;
            } else if (this.skills && typeof slug === 'string') {
              if (action === 'delete') ok = this.skills.remove(slug);
              else if (action === 'enable') ok = this.skills.setEnabled(slug, true);
              else if (action === 'disable') ok = this.skills.setEnabled(slug, false);
              else if (action === 'import') ok = this.skills.importSkill(slug);
            }
            this.json(res, 200, { ok, skills: this.skills?.detailsAll() ?? [] });
          } catch (err) {
            this.json(res, 400, { error: String(err) });
          }
        });
        return;
      }
    }
    if (url.pathname === '/api/forget' && req.method === 'POST') {
      if (!this.authOk(req)) return this.json(res, 401, { error: 'unauthorized' });
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const cid = JSON.parse(body || '{}').cid;
          const ok = typeof cid === 'string' && cid && this.forget ? this.forget(`web:${cid}`) : false;
          this.json(res, 200, { ok });
        } catch (err) {
          this.json(res, 400, { error: String(err) });
        }
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }

  private safeSend(ws: WebSocket, obj: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  private onWs(ws: WebSocket, req: http.IncomingMessage): void {
    const url = new URL(req.url ?? '/', 'http://x');
    const chatId = url.searchParams.get('cid') || randomUUID();
    this.sockets.set(chatId, ws);
    this.safeSend(ws, { type: 'status', text: 'connected' });

    ws.on('message', async (data) => {
      let text: unknown;
      let route: unknown;
      let model: unknown;
      try {
        const parsed = JSON.parse(data.toString());
        text = parsed.text;
        route = parsed.route;
        model = parsed.model;
      } catch {
        return;
      }
      if (typeof text !== 'string' || !text.trim()) return;
      // Accept auto/local/claude/freecloud or a provider id (validated against the registry in planRoute).
      const r = typeof route === 'string' && /^[a-z0-9_-]{1,32}$/i.test(route) && route !== 'auto' ? route : undefined;
      // Only allow safe model aliases from the UI (never an arbitrary string).
      const mdl = model === 'opus' || model === 'sonnet' || model === 'haiku' ? model : undefined;
      try {
        const reply = await this.handler!(
          { channel: this.name, chatId, from: 'web', text, route: r, model: mdl },
          (chunk) => this.safeSend(ws, { type: 'chunk', text: chunk }),
        );
        this.safeSend(ws, { type: 'reply', text: reply });
      } catch (err) {
        logger.error({ err: String(err) }, 'web handler error');
        this.safeSend(ws, { type: 'reply', text: '(internal error)' });
      }
    });

    ws.on('close', () => {
      if (this.sockets.get(chatId) === ws) this.sockets.delete(chatId);
    });
  }

  async send(msg: OutboundMessage): Promise<void> {
    const ws = this.sockets.get(msg.chatId);
    if (ws) this.safeSend(ws, { type: 'reply', text: msg.text });
  }

  /** Native Ollama API base (the OpenAI-compat URL minus the /v1 suffix). */
  private ollamaBase(): string {
    const u = this.config.localModel?.url || process.env.ZAMOLXIS_LOCAL_MODEL_URL || 'http://localhost:11434/v1';
    return u.replace(/\/v1\/?$/, '');
  }

  /** Is the `ollama` binary on PATH (installed, even if the server isn't responding)? */
  private ollamaOnPath(): boolean {
    try {
      return spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ollama'], { windowsHide: true }).status === 0;
    } catch {
      return false;
    }
  }

  /** Snapshot for the Local-model panel: Ollama status, installed models, catalog, active, pulls. */
  private async localStatus(): Promise<Record<string, unknown>> {
    const base = this.ollamaBase();
    let installed: Array<{ name: string; size: number }> = [];
    let running = false;
    try {
      const r = await fetch(base + '/api/tags', { signal: AbortSignal.timeout(4000) });
      if (r.ok) {
        running = true;
        const d = (await r.json()) as { models?: Array<{ name: string; size: number }> };
        installed = (d.models ?? []).map((m) => ({ name: m.name, size: m.size }));
      }
    } catch {
      /* server down */
    }
    // Currently-loaded models + their GPU/CPU split (native /api/ps).
    const loaded: Record<string, { gpuPct: number }> = {};
    if (running) {
      try {
        const pr = await fetch(base + '/api/ps', { signal: AbortSignal.timeout(4000) });
        if (pr.ok) {
          const pd = (await pr.json()) as { models?: Array<{ name: string; size?: number; size_vram?: number }> };
          for (const m of pd.models ?? []) {
            const total = m.size || 0;
            const vram = m.size_vram || 0;
            loaded[m.name] = { gpuPct: total > 0 ? Math.round((vram / total) * 100) : 0 };
          }
        }
      } catch {
        /* ps unavailable */
      }
    }
    const has = (id: string): boolean => installed.some((m) => m.name === id || m.name === id + ':latest' || m.name.startsWith(id + ':'));
    return {
      ollamaInstalled: running || this.ollamaOnPath(),
      ollamaRunning: running,
      base,
      active: this.config.localModel?.model || '',
      localRouting: this.config.localRouting,
      localContext: this.config.localContext ?? 0,
      localKeepAlive: this.config.localKeepAlive ?? '',
      localTemp: this.config.localTemp ?? null,
      installed,
      loaded,
      catalog: OLLAMA_CATALOG.map((c) => ({ ...c, installed: has(c.id) })),
      pulls: Object.fromEntries(this.ollamaPulls),
      install: this.ollamaInstall,
    };
  }

  /** Send a tiny prompt to a specific local model and time it (the panel's "Test" button). */
  private async testLocalModel(model: string): Promise<{ ok: boolean; reply?: string; ms?: number; error?: string }> {
    const url = (this.config.localModel?.url || process.env.ZAMOLXIS_LOCAL_MODEL_URL || 'http://localhost:11434/v1') + '/chat/completions';
    const t0 = Date.now();
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: 'Reply with a short friendly hello (one sentence).' }], ...(this.config.localKeepAlive ? { keep_alive: this.config.localKeepAlive } : {}) }),
        signal: AbortSignal.timeout(60000),
      });
      if (!r.ok) return { ok: false, error: 'HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200) };
      const d = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const reply = (d.choices?.[0]?.message?.content || '').trim();
      return { ok: true, reply: reply.slice(0, 300), ms: Date.now() - t0 };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  /** Background `ollama pull` via the native streaming API; progress lands in `ollamaPulls`. */
  private startOllamaPull(model: string): void {
    const cur = this.ollamaPulls.get(model);
    if (cur && !cur.done) return; // already pulling
    this.ollamaPulls.set(model, { status: 'starting', pct: 0, done: false });
    const base = this.ollamaBase();
    void (async () => {
      try {
        const r = await fetch(base + '/api/pull', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: model, stream: true }) });
        if (!r.ok || !r.body) {
          this.ollamaPulls.set(model, { status: 'failed', pct: 0, done: true, error: 'HTTP ' + (r ? r.status : '?') });
          return;
        }
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            try {
              const o = JSON.parse(line) as { status?: string; total?: number; completed?: number; error?: string };
              const pct = o.total && o.completed ? Math.round((o.completed / o.total) * 100) : (this.ollamaPulls.get(model)?.pct ?? 0);
              if (o.error) this.ollamaPulls.set(model, { status: 'failed', pct, done: true, error: o.error });
              else this.ollamaPulls.set(model, { status: o.status || 'pulling', pct, done: false });
            } catch {
              /* skip non-JSON line */
            }
          }
        }
        const fin = this.ollamaPulls.get(model);
        if (fin && !fin.error) this.ollamaPulls.set(model, { status: 'success', pct: 100, done: true });
      } catch (err) {
        this.ollamaPulls.set(model, { status: 'failed', pct: 0, done: true, error: String(err) });
      }
    })();
  }

  /** Best-effort background install of Ollama (winget on Windows, the official script on Linux,
   *  Homebrew on macOS). Output is captured for the panel; failures point the user to the download. */
  private startOllamaInstall(): void {
    if (this.ollamaInstall?.running) return;
    this.ollamaInstall = { running: true, done: false, log: '' };
    const append = (d: unknown): void => { if (this.ollamaInstall) this.ollamaInstall.log = (this.ollamaInstall.log + String(d)).slice(-2000); };
    let cmd: string;
    let args: string[];
    let useShell = false;
    if (process.platform === 'win32') { cmd = 'winget'; args = ['install', '-e', '--id', 'Ollama.Ollama', '--silent', '--accept-package-agreements', '--accept-source-agreements']; useShell = true; }
    else if (process.platform === 'darwin') { cmd = 'brew'; args = ['install', 'ollama']; }
    else { cmd = 'sh'; args = ['-c', 'curl -fsSL https://ollama.com/install.sh | sh']; }
    try {
      const child = spawn(cmd, args, { shell: useShell, windowsHide: true });
      child.stdout?.on('data', append);
      child.stderr?.on('data', append);
      child.on('error', (e) => { this.ollamaInstall = { running: false, done: true, error: String(e), log: (this.ollamaInstall?.log || '') + '\n' + String(e) }; });
      child.on('exit', (code) => { this.ollamaInstall = { running: false, done: true, error: code === 0 ? undefined : 'exit ' + code + ' (try installing from https://ollama.com/download)', log: this.ollamaInstall?.log || '' }; });
    } catch (err) {
      this.ollamaInstall = { running: false, done: true, error: String(err) + ' - install from https://ollama.com/download', log: '' };
    }
  }

  async stop(): Promise<void> {
    for (const client of this.wss?.clients ?? []) {
      try {
        client.terminate();
      } catch {
        /* already closing */
      }
    }
    this.wss?.close();
    this.sockets.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.closeAllConnections?.();
      this.server.close(() => resolve());
    });
  }
}

// Single-page UI: chat + agent dashboard tabs + Settings + Memory + Chats.
// This is a template literal — avoid backticks and ${} inside it.
const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>__AGENT_NAME__</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><defs><linearGradient id='g' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='%23e8c87a'/><stop offset='1' stop-color='%23b8893f'/></linearGradient></defs><path d='M32 3 58 18 V46 L32 61 6 46 V18 Z' fill='%231a150d' stroke='url(%23g)' stroke-width='3' stroke-linejoin='round'/><path d='M22 22 H42 L24 40 H43' fill='none' stroke='url(%23g)' stroke-width='5' stroke-linecap='round' stroke-linejoin='round'/></svg>">
<style>
:root{
  --bg:#0d0c0a; --panel:#17130d; --panel2:#1f1a12; --line:#2c261c;
  --ink:#ece3d2; --mut:#9a8e78; --accent:#cda349; --accent2:#b5651d;
  --user:#cda34920; --userline:#cda34955; --bot:#1b160f;
}
*{box-sizing:border-box}
body{margin:0;font:15px/1.55 system-ui,Segoe UI,Roboto,sans-serif;color:var(--ink);height:100vh;display:flex;flex-direction:column;transition:padding-right .2s;box-sizing:border-box;
  background:radial-gradient(1200px 700px at 50% -10%,#1a150d 0%,var(--bg) 60%) fixed;}
::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-thumb{background:#2c261c;border-radius:6px}::-webkit-scrollbar-thumb:hover{background:#3a3225}
header{display:flex;align-items:center;gap:10px;padding:11px 18px;border-bottom:1px solid var(--line);background:linear-gradient(#1a150d,#120f0a);flex-wrap:wrap}
#models{display:flex;gap:6px;align-items:center;font-size:11px;color:var(--mut);flex-wrap:wrap}
.mchip{padding:1px 7px;border:1px solid var(--line);border-radius:999px;color:var(--mut)}
.mchip.used{color:#1a150d;background:linear-gradient(135deg,var(--accent),#dcb964);border-color:var(--accent);font-weight:700}
#models .tok{color:var(--accent);font-variant-numeric:tabular-nums}
#emblem{width:26px;height:26px;flex:none;filter:drop-shadow(0 0 6px #cda34966)}
#brand{font-family:Georgia,'Times New Roman',serif;font-weight:700;letter-spacing:3px;font-size:18px;color:var(--accent);text-transform:uppercase}
#version{font-size:10px;color:var(--mut);opacity:.85;align-self:flex-end;margin-bottom:2px;cursor:default}
#clock{margin-left:auto;font-variant-numeric:tabular-nums;font-size:12px;color:var(--mut);white-space:nowrap}
#auth{font-size:11px;padding:2px 9px;border-radius:999px;border:1px solid var(--line);color:var(--mut);cursor:default;white-space:nowrap}
#auth.ok{color:#7dd08a;border-color:#2f5a35}
#auth.warn{color:#e0a55f;border-color:#5a4326}
#auth.bad{color:#e88;border-color:#a44}
#build{font-size:11px;padding:2px 9px;border-radius:999px;border:1px solid #a44;color:#e88;white-space:nowrap;cursor:default}
#status{font-size:12px;color:var(--mut)}
#modelsbar{display:flex;align-items:center;padding:5px 18px;border-bottom:1px solid var(--line);background:#15110b;overflow-x:auto}
#modelsbar #models{flex-wrap:nowrap;white-space:nowrap}
#toolsmenu{position:relative}
#toolsdrop{position:absolute;right:0;top:calc(100% + 6px);background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:6px;display:none;flex-direction:column;gap:3px;min-width:152px;z-index:30;box-shadow:0 10px 28px #000a}
#toolsdrop.open{display:flex}
#toolsdrop button{width:100%;text-align:left;background:transparent;border:none;border-radius:6px;padding:8px 11px;font-size:13px}
#toolsdrop button:hover{background:var(--panel2);color:var(--accent)}
button{background:var(--panel2);color:var(--ink);border:1px solid var(--line);border-radius:9px;padding:7px 12px;cursor:pointer;font:inherit;font-size:13px;transition:.15s}
button:hover{border-color:var(--accent);color:var(--accent)}
#tabbar{display:flex;gap:6px;align-items:center;padding:8px 18px;border-bottom:1px solid var(--line);background:#120f0a;overflow-x:auto}
.tab{padding:6px 14px;border-radius:999px;border:1px solid var(--line);background:transparent;color:var(--mut);cursor:pointer;font-size:13px;white-space:nowrap}
.tab:hover{color:var(--ink)}
.tab.active{color:#1a150d;background:linear-gradient(135deg,var(--accent),#dcb964);border-color:var(--accent);font-weight:600}
#main{flex:1;display:flex;overflow:hidden}
#provrail{width:158px;flex:none;border-right:1px solid var(--line);background:#120f0a;display:flex;flex-direction:column;position:relative}
#provsec{overflow:auto;padding:10px 8px;flex:none;height:50%}
#railsplit,#railsplit2{height:7px;flex:none;cursor:row-resize;background:var(--line);opacity:.45}
#railsplit:hover,#railsplit2:hover{opacity:1;background:var(--accent)}
#agentsec{overflow:auto;padding:8px 8px 10px;flex:none;height:25%;min-height:42px}
#railwidth{position:absolute;top:0;right:-3px;width:7px;height:100%;cursor:col-resize;z-index:6}
#railwidth:hover{background:var(--accent);opacity:.5}
#maininner{flex:1;display:flex;overflow:hidden}
#chatwrap{flex:1;position:relative;overflow:hidden}
@media(max-width:680px){#provrail{display:none}}
#chatview{position:absolute;inset:0;display:flex;flex-direction:column}
#log{flex:1;overflow:auto;padding:22px 0}
#loginner{max-width:840px;margin:0 auto;padding:0 20px;display:flex;flex-direction:column;gap:14px}
.who{font-size:11px;color:var(--mut);margin:0 4px 2px;letter-spacing:.3px}
.msg{max-width:80%;padding:11px 15px;border-radius:14px;white-space:pre-wrap;word-wrap:break-word;line-height:1.55}
.user{align-self:flex-end;background:var(--user);border:1px solid var(--userline)}
.bot{align-self:flex-start;background:var(--bot);border:1px solid var(--line)}
footer{border-top:1px solid var(--line);background:#120f0a}
#footinner{max-width:840px;margin:0 auto;display:flex;gap:10px;padding:14px 20px}
#in{flex:1;resize:none;max-height:160px;background:#0c0a07;color:var(--ink);border:1px solid var(--line);border-radius:12px;padding:11px 13px;font:inherit}
#in:focus{outline:none;border-color:var(--accent)}
#route,#model{width:auto;flex:0 0 auto;align-self:center;font-size:12px;padding:8px;color:var(--mut)}
#send{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#17130d;border:none;font-weight:600;padding:0 18px}
#send:hover{filter:brightness(1.08)}
#attach{background:#0c0a07;color:var(--mut);border:1px solid var(--line);border-radius:12px;padding:0 12px;cursor:pointer;font-size:17px;align-self:stretch}
#attach:hover{color:var(--accent);border-color:var(--accent)}
#attachbar{max-width:840px;margin:0 auto;display:flex;flex-wrap:wrap;gap:6px;padding:8px 20px 0}
#attachbar:empty{display:none}
.achip{display:inline-flex;align-items:center;gap:7px;background:#1a150d;border:1px solid var(--line);border-radius:8px;padding:3px 9px;font-size:12px;color:var(--mut)}
.achip b{color:var(--ink);font-weight:500;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.achip .x{cursor:pointer;color:#e88;font-weight:700}
#chatview.drag{outline:2px dashed var(--accent);outline-offset:-10px;border-radius:12px}
#tabview{position:absolute;inset:0;overflow:auto;display:none}
#tabview.show{display:block}
#tabinner{max-width:900px;margin:0 auto;padding:26px 22px}
.tabhead{display:flex;align-items:baseline;gap:12px;border-bottom:1px solid var(--line);padding-bottom:10px;margin-bottom:16px}
.tabhead h2{margin:0;font-family:Georgia,serif;color:var(--accent);font-weight:700}
.tabhead .when{font-size:12px;color:var(--mut)}
.tabbody{font-size:15px;line-height:1.7}
.tabbody h2{font-family:Georgia,serif;color:var(--accent);border-bottom:1px solid var(--line);padding-bottom:4px}
.tabbody h3,.tabbody h4{color:#dcb964;margin:14px 0 4px}
.tabbody a{color:var(--accent)}.tabbody code{background:#0c0a07;border:1px solid var(--line);border-radius:5px;padding:1px 5px;font-size:13px}
.tabbody ul{margin:6px 0;padding-left:22px}.tabbody p{margin:6px 0}
/* slide-in panels */
.side{position:fixed;top:0;height:100%;background:var(--panel);transition:transform .2s;z-index:15;display:flex;flex-direction:column}
/* Chats is now a permanent section of the left rail (alongside Models and Agents). */
#chatsec{overflow:auto;padding:8px 8px 10px;flex:1 1 0;min-height:42px;border-top:1px solid var(--line)}
#panel{right:0;width:420px;border-left:1px solid var(--line);transform:translateX(100%)}
#mempanel{right:0;width:420px;border-left:1px solid var(--line);transform:translateX(100%);z-index:16}
#localpanel{right:0;width:480px;border-left:1px solid var(--line);transform:translateX(100%);z-index:16}
#skillpanel{right:0;width:460px;border-left:1px solid var(--line);transform:translateX(100%);z-index:16}
#provpanel{right:0;width:460px;border-left:1px solid var(--line);transform:translateX(100%);z-index:16}
#panel.open,#mempanel.open,#skillpanel.open,#provpanel.open,#localpanel.open{transform:none}
/* shared sticky head + scrollable body (Settings-style) for side panels */
.phead{position:sticky;top:0;display:flex;align-items:center;gap:8px;padding:14px 18px;background:var(--panel);border-bottom:1px solid var(--line);z-index:2}
.phead h3{margin:0;flex:1;font-family:Georgia,serif;color:var(--accent)}
.pbody{flex:1;overflow:auto;padding:16px 18px}
#panelhead{position:sticky;top:0;display:flex;align-items:center;gap:8px;padding:14px 18px;background:var(--panel);border-bottom:1px solid var(--line);z-index:2}
#panelhead h3{margin:0;flex:1;font-family:Georgia,serif;color:var(--accent)}
#panelbody{overflow:auto;padding:16px 18px}
h3{margin:0 0 12px;font-family:Georgia,serif;color:var(--accent)}
label{display:block;font-size:12px;color:var(--mut);margin:10px 0 4px}
input,select,textarea{width:100%;background:#0c0a07;color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:8px;font:inherit}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent)}
.ro{font-size:12px;color:var(--mut);border-top:1px solid var(--line);margin-top:14px;padding-top:10px}
.sec{margin:18px 0 4px;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.7px;color:var(--accent);border-bottom:1px solid var(--line);padding-bottom:4px}
.chk{display:flex;align-items:center;gap:8px;color:var(--ink);margin:6px 0;font-size:14px}.chk input{width:auto}
.accent{color:var(--accent)}
.preset{color:var(--accent);cursor:pointer;text-decoration:none}
#toast{position:fixed;left:50%;top:18px;transform:translateX(-50%);max-width:80%;background:var(--panel2);border:1px solid var(--accent);color:var(--ink);padding:12px 18px;border-radius:10px;display:none;z-index:30;box-shadow:0 8px 30px #000b;text-align:center}
#toast.show{display:block}
.thread{display:flex;align-items:center;gap:6px;padding:8px;border-radius:8px;cursor:pointer;color:var(--ink);font-size:14px}
.thread:hover{background:var(--panel2)}.thread.cur{background:var(--user);border:1px solid var(--userline)}
.thread .lbl{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.thread .del{color:var(--mut);font-size:12px;padding:2px 6px;border-radius:6px}.thread .del:hover{background:#3a2520;color:#e88}
</style></head><body>
<div id="toast"></div>
<header><svg id="emblem" viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="eg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e8c87a"/><stop offset="1" stop-color="#b8893f"/></linearGradient></defs><path d="M32 3 58 18 V46 L32 61 6 46 V18 Z" fill="#1a150d" stroke="url(#eg)" stroke-width="3" stroke-linejoin="round"/><path d="M22 22 H42 L24 40 H43" fill="none" stroke="url(#eg)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg><b id="brand">__AGENT_NAME__</b><span id="version" title=""></span>
  <span id="clock"></span><span id="build" title="" style="display:none"></span><span id="auth" title="">login ...</span><span id="status">connecting...</span>
  <div id="toolsmenu"><button id="toolsbtn">Tools ▾</button><div id="toolsdrop"><button id="skillsbtn">Skills</button><button id="provbtn">Providers</button><button id="localbtn">Local model</button><button id="mem">Memory</button><button id="cog">Settings</button><button id="helpbtn">Help</button></div></div></header>
<div id="modelsbar"><span id="models"></span></div>
<div id="tabbar"></div>
<div id="main">
  <aside id="provrail"><div id="provsec"><div id="provchain"></div></div><div id="railsplit" title="Drag to resize Providers / Agents"></div><div id="agentsec"><div style="text-transform:uppercase;font-size:10px;letter-spacing:.5px;color:var(--mut);margin:2px 4px 6px">Agents</div><div id="agentrail"></div><div id="newagent" style="color:var(--accent);font-size:11px;margin:6px 4px;cursor:pointer">+ new agent</div></div><div id="railsplit2" title="Drag to resize Agents / Chats"></div><div id="chatsec"><div style="text-transform:uppercase;font-size:10px;letter-spacing:.5px;color:var(--mut);margin:2px 4px 6px">Chats</div><div id="threadlist"></div><div id="newchat" style="color:var(--accent);font-size:11px;margin:6px 4px;cursor:pointer">+ new chat</div></div><div id="railwidth" title="Drag to resize the panel width"></div></aside>
  <div id="maininner">
  <div id="chatwrap">
  <div id="chatview">
    <div id="log"><div id="loginner"></div></div>
    <footer><div id="attachbar"></div><div id="footinner"><select id="route" title="Where this chat is answered: Auto routes simple turns to the local model, Local forces on-device, Claude forces the subscription"><option value="auto">Auto</option><option value="local">Local</option><option value="claude">Claude</option></select><select id="model" title="Which Claude model answers this chat. Default = automatic: the fast model for simple turns, the primary model for complex ones. Sonnet/Haiku are faster than Opus."><option value="">Model: auto</option><option value="opus">Opus · deep</option><option value="sonnet">Sonnet · fast</option><option value="haiku">Haiku · fastest</option></select><input id="fileinput" type="file" multiple style="display:none"><button id="attach" type="button" title="Attach files (or drag-and-drop / paste)">&#128206;</button><textarea id="in" rows="1" placeholder="Message __AGENT_NAME__..."></textarea><button id="send">Send</button></div></footer>
  </div>
  <div id="tabview"><div id="tabinner"></div></div>
  </div>
  </div>
</div>
<div id="panel" class="side"><div id="panelhead"><h3>Settings</h3><button id="save">Save</button><button id="close">Close</button></div><div id="panelbody"><div id="settings">loading...</div><div class="ro" id="ro"></div></div></div>
<div id="mempanel" class="side"><div class="phead"><h3>Memory</h3><button id="memclose">Close</button></div><div class="pbody" id="memview">loading...</div></div>
<div id="skillpanel" class="side"><div class="phead"><h3>Skills</h3><button id="skillclose">Close</button></div><div class="pbody" id="skillview">loading...</div></div>
<div id="provpanel" class="side"><div class="phead"><h3>AI Providers</h3><button id="provsave">Save</button><button id="provclose">Close</button></div><div class="pbody" id="provview">loading...</div></div>
<div id="localpanel" class="side"><div class="phead"><h3>Local model</h3><button id="localclose">Close</button></div><div class="pbody" id="localview">loading...</div></div>
<div id="agentmodal" style="display:none;position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.55);align-items:center;justify-content:center"><div style="background:#161108;border:1px solid var(--line);border-radius:12px;padding:18px 18px 16px;width:min(600px,94vw);box-shadow:0 12px 40px rgba(0,0,0,.5)"><h3 style="margin:0 0 12px;color:var(--accent)">New agent</h3><label style="display:block;font-size:12px;color:var(--mut);margin-bottom:3px">Name</label><input id="am_name" placeholder="e.g. mailproc" style="width:100%;box-sizing:border-box;margin-bottom:12px"><label style="display:block;font-size:12px;color:var(--mut);margin-bottom:3px">Instructions &mdash; what it does, and how often if it repeats. Leave blank for an <b>open</b> agent you task each time.</label><textarea id="am_job" rows="9" placeholder="e.g. Every morning at 8, read my gmail and Slack me a 5-bullet digest of anything that needs a reply." style="width:100%;box-sizing:border-box;resize:vertical;margin-bottom:12px"></textarea><label style="display:block;font-size:12px;color:var(--mut);margin-bottom:3px">Runs on</label><select id="am_model" style="margin-bottom:14px"></select><label style="display:block;font-size:12px;color:var(--mut);margin-bottom:3px">On restart</label><select id="am_autostart" style="margin-bottom:14px"><option value="">Use global default</option><option value="resume">Always resume</option><option value="pause">Start paused</option></select><div style="display:flex;gap:8px;justify-content:flex-end"><button id="am_cancel" type="button">Cancel</button><button id="am_create" type="button">Create</button></div></div></div>
<div id="jobmodal" style="display:none;position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.55);align-items:center;justify-content:center"><div style="background:#161108;border:1px solid var(--line);border-radius:12px;padding:18px;width:min(660px,94vw);box-shadow:0 12px 40px rgba(0,0,0,.5)"><h3 style="margin:0 0 10px;color:var(--accent)">Edit job &mdash; <span id="jm_name"></span></h3><label style="display:block;font-size:12px;color:var(--mut);margin-bottom:3px">Runs on</label><select id="jm_model" style="margin-bottom:10px"></select><div id="jm_why" style="display:none;font-size:12px;color:#e0a55f;margin-bottom:8px"></div><label style="display:block;font-size:12px;color:var(--mut);margin-bottom:3px">Instructions in plain language (incl. how often if it repeats). On save, the smartest model recompiles the plan, skills and schedule &mdash; just like when you create an agent. If your chosen model looks too weak, it will warn you but keep your choice unless you change it.</label><textarea id="jm_job" rows="8" style="width:100%;box-sizing:border-box;resize:vertical;margin-bottom:10px"></textarea><details style="margin-bottom:12px"><summary style="cursor:pointer;font-size:12px;color:var(--mut)">Current compiled plan (read-only)</summary><pre id="jm_spec" style="white-space:pre-wrap;font-size:11px;color:var(--mut);max-height:220px;overflow:auto;background:#0c0a07;border:1px solid var(--line);border-radius:8px;padding:8px;margin-top:6px"></pre></details><div style="display:flex;gap:8px;justify-content:flex-end"><button id="jm_cancel" type="button">Cancel</button><button id="jm_save" type="button">Save &amp; recompile</button></div></div></div>
<script>
function uuid(){return crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random()}
/* ---- shared status helpers (masked keys, status dots, active-provider rail, installer) ---- */
var KEYMASK='************';
var C_OK='#7dd08a',C_BAD='#e06a5f',C_WARN='#e0a55f',C_OFF='#5a5a5a';
function dotHtml(color,title){return '<span title="'+(title||'')+'" style="display:inline-block;width:9px;height:9px;border-radius:50%;flex:none;background:'+color+';box-shadow:0 0 4px '+color+'"></span>'}
var RAIL=null,LAST_USED='',LASTD=null;
function freeReady(p){return p.configured&&!(p.freeDaily&&p.used>=p.freeDaily)}
function tokMatch(tok,d){var u=(LAST_USED||'').toLowerCase();if(!u)return false;
  if(tok==='local')return !!(d.localModel&&u.indexOf(String(d.localModel).toLowerCase())>=0);
  if(tok==='claude')return /claude|opus|sonnet|haiku/.test(u);
  if(tok==='freecloud')return (d.providers||[]).some(function(p){return p.kind==='free'&&u.indexOf(String(p.model).toLowerCase())>=0});
  var pp=(d.providers||[]).filter(function(p){return p.id===tok})[0];return !!(pp&&u.indexOf(String(pp.model).toLowerCase())>=0)}
/* Model "smartness" color: lightest green = on-device/dumbest, blue = Claude/smartest. Same scale
   used in the rail and on each answer's header, so a model change is visible at a glance. */
function gradColor(r){r=Math.max(0,Math.min(1,r));var g=[125,208,138],b=[90,160,224];return 'rgb('+Math.round(g[0]+(b[0]-g[0])*r)+','+Math.round(g[1]+(b[1]-g[1])*r)+','+Math.round(g[2]+(b[2]-g[2])*r)+')'}
// Color by model CAPABILITY (how smart it is), not chain order: small on-device models -> green,
// frontier models (Claude Opus, GPT-4/o-series, Gemini Pro, big 70B+/MoE) -> blue. Heuristic from
// the model name + parameter size.
function smartScore(name){name=String(name||'').toLowerCase();if(!name)return .5;
  if(/opus/.test(name))return 1;
  if(/gpt-?4|gpt4o|\bo1\b|\bo3\b/.test(name))return .92;
  if(/sonnet/.test(name))return .82;
  if(/haiku|flash/.test(name))return .55;
  if(/gemini[-\s.]?(1\.5[-\s.]?)?pro|gemini[-\s.]?2|gemini[-\s.]?ultra/.test(name))return .8;
  if(/\blarge\b/.test(name))return .68;
  if(/deepseek[-\s.]?(v3|r1)|qwen[-\s.]?(2\.5[-\s.]?)?(72b|max)|405b|llama[-\s.]?3\.[13][-\s.]?70b/.test(name))return .72;
  if(/mixtral|8x7b|gemma2?[-\s.]?27b|command[-\s.]?r|32b/.test(name))return .55;
  var mm=name.match(/(\d+(?:\.\d+)?)\s*b(?![a-z0-9])/);if(mm){var b=parseFloat(mm[1]);if(b>=180)return .85;if(b>=60)return .7;if(b>=27)return .5;if(b>=12)return .35;if(b>=6)return .22;return .15}
  if(/qwen|llama|gemma|phi|mistral[-\s.]?7|tinyllama|smollm/.test(name))return .2;
  return .5}
function modelNameOf(id){return String(id||'').replace(/^(?:free|paid):[^:]+:/,'').replace(/^local:/,'')}
function rankForTok(d,tok){if(tok==='local')return smartScore(d.localModel);if(tok==='claude')return smartScore((d.claude&&d.claude.model)||'opus');if(tok==='freecloud')return .5;var pp=(d.providers||[]).filter(function(p){return p.id===tok})[0];return pp?smartScore(pp.model):.5}
function viaColor(id){return gradColor(smartScore(modelNameOf(id)))}
function railItem(d,tok,rank){var label=tok,color=C_OFF,title=tok;
  if(tok==='local'){label='Local'+(d.localModel?' - '+d.localModel:'');color=d.localModel?C_OK:C_OFF;title=d.localModel||'no on-device model'}
  else if(tok==='claude'){label='Claude';var c=d.claude||{};color=c.found?(c.expired?C_BAD:C_OK):C_WARN;title='subscription'}
  else if(tok==='freecloud'){label='Free cloud';var any=(d.providers||[]).some(function(p){return p.kind==='free'&&freeReady(p)});color=any?C_OK:C_BAD;title='rotates free providers'}
  else{var pp=(d.providers||[]).filter(function(p){return p.id===tok})[0];if(pp){label=pp.label;var lim=pp.freeDaily&&pp.used>=pp.freeDaily;color=!pp.configured?C_OFF:(lim?C_BAD:C_OK);title=pp.kind}}
  var used=tokMatch(tok,d);
  return '<div title="'+esc(title)+'" style="display:flex;align-items:center;gap:7px;padding:6px 7px;border-radius:7px;margin-bottom:4px;'+(used?'background:rgba(212,165,90,.14);border:1px solid var(--accent)':'border:1px solid transparent')+'">'+dotHtml(color,title)+'<span style="flex:1;color:'+gradColor(rankForTok(d,tok))+';overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(label)+'</span>'+(used?'<span style="color:var(--accent);font-size:10px">last</span>':'')+'</div>'}
function renderRail(){var box=el('provchain');if(!box)return;var d=RAIL;if(!d){box.innerHTML='';return}
  var chain=d.routeChain||[];
  // Flatten (freecloud -> each configured free provider) into the displayed order, then color each
  // by its position so the gradient spans every model, not just two buckets.
  var flat=[];chain.forEach(function(tok){if(tok==='freecloud'){var fps=(d.providers||[]).filter(function(p){return p.kind==='free'&&p.configured});if(fps.length)fps.forEach(function(p){flat.push(p.id)});else flat.push('freecloud')}else flat.push(tok)});
  // Order by capability (weakest/green at top -> smartest/blue at bottom) to match the color scale.
  flat.sort(function(a,b){return rankForTok(d,a)-rankForTok(d,b)});
  var h='<div style="color:var(--mut);text-transform:uppercase;font-size:10px;letter-spacing:.5px;margin:2px 4px 8px">Models (by capability)</div>';
  if(!flat.length)h+='<div style="color:var(--mut);padding:4px 7px">none</div>';
  flat.forEach(function(tok){h+=railItem(d,tok)});
  h+='<div id="raillink" style="color:var(--mut);font-size:10px;margin:9px 4px 4px;cursor:pointer">edit in Providers &#8594;</div>';
  box.innerHTML=h;var lk=el('raillink');if(lk)lk.onclick=function(){el('provbtn').click()};loadAgents()}
function loadRail(){fetch('/api/providers',{headers:hdrs()}).then(function(r){return r.ok?r.json():null}).then(function(d){if(d){RAIL=d;renderRail();rebuildRouteSelect();if(LASTD)renderModels(LASTD)}}).catch(function(){})}
var AGENTS=[],SCHEDS=[];
function loadAgents(){fetch('/api/agents',{headers:hdrs()}).then(function(r){return r.ok?r.json():null}).then(function(a){if(!a)return;AGENTS=a;
  // Prune orphaned agent chats whose agent no longer exists (e.g. a deleted 'charlie').
  var before=threads.length;threads=threads.filter(function(t){return !t.agent||AGENTS.some(function(x){return x.name===t.agent})});
  if(threads.length!==before){if(!threads.some(function(t){return t.id===cid}))loadThread('main');else{saveThreads();renderThreads()}}
  renderAgents();loadSchedules()}).catch(function(){})}
function loadSchedules(){fetch('/api/agents',{method:'POST',headers:hdrs(),body:JSON.stringify({action:'schedules'})}).then(function(r){return r.ok?r.json():null}).then(function(d){if(d&&d.schedules){SCHEDS=d.schedules;renderAgents()}}).catch(function(){})}
function schedsFor(n){return SCHEDS.filter(function(s){return s.agent===n})}
/* Model choices an agent can run on (Auto + the configured tiers), and availability checks. */
function agentModelOpts(){var d=RAIL||{};var o=[['auto','Auto (smartest model decides)']];
  if(d.localModel)o.push(['local','Local ('+d.localModel+')']);
  o.push(['freecloud','Free cloud (rotates free providers)']);
  (d.providers||[]).filter(function(p){return p.configured}).forEach(function(p){o.push([p.id,p.label])});
  o.push(['claude','Claude (subscription)']);return o}
function fillModelSel(id,cur){var s=el(id);if(!s)return;cur=cur||'auto';var opts=agentModelOpts();
  if(cur!=='auto'&&!opts.some(function(o){return o[0]===cur}))opts.push([cur,cur+' (not configured)']);
  s.innerHTML=opts.map(function(o){return '<option value="'+esc(o[0])+'"'+(o[0]===cur?' selected':'')+'>'+esc(o[1])+'</option>'}).join('')}
function modelAvail(tok){var d=RAIL||{};tok=tok||'auto';
  if(tok==='auto'||!tok)return true;
  if(tok==='local')return !!d.localModel;
  if(tok==='freecloud')return (d.providers||[]).some(function(p){return p.kind==='free'&&p.configured});
  if(tok==='claude'||/claude|opus|sonnet|haiku/i.test(tok))return !!(d.claude&&d.claude.found&&!d.claude.expired);
  var pp=(d.providers||[]).filter(function(p){return p.id===tok})[0];if(pp)return !!pp.configured;
  return true}
function modelWhy(tok){var d=RAIL||{};tok=tok||'auto';
  if(tok==='local')return 'The local model is not configured \\u2014 open Tools \\u2192 Local model to install/select one (or switch this agent to another model).';
  if(tok==='freecloud')return 'No free cloud provider is configured \\u2014 add a key in AI Providers (or switch this agent).';
  if(tok==='claude'||/claude|opus|sonnet|haiku/i.test(tok))return (d.claude&&d.claude.expired)?'Your Claude subscription login expired \\u2014 run "claude auth login" on the host (older CLI: "claude login"). Or switch this agent.':'Claude is not logged in.';
  return 'The model "'+tok+'" is unavailable \\u2014 its provider key is missing in AI Providers (or switch this agent).'}
function renderAgents(){var box=el('agentrail');if(!box)return;
  if(!AGENTS.length){box.innerHTML='<div style="color:var(--mut);font-size:11px;padding:2px 7px">none yet</div>';return}
  box.innerHTML=AGENTS.map(function(a){
    var sl=schedsFor(a.name).map(function(s){return '<div style="font-size:10px;color:var(--mut);margin-left:8px;margin-top:1px">\\u23F0 '+esc(s.cron||s.at||'')+' <span class="ascd" data-id="'+esc(s.id)+'" title="cancel" style="color:#e88;cursor:pointer">\\u00d7</span></div>'}).join('');
    var avail=modelAvail(a.model);var why=avail?'':modelWhy(a.model);
    return '<div style="padding:4px 7px"><div style="font-size:12px" title="'+esc(a.job)+'"><span class="aopen" data-n="'+esc(a.name)+'" style="cursor:pointer;text-decoration:underline" title="open '+esc(a.name)+' chat">'+esc(a.label||a.name)+'</span> <span style="color:var(--mut);font-size:10px">['+esc(a.model)+(a.canElevate?'\\u2191':'')+']</span>'+(a.createdBy==='agent'?' <span title="Created by Zamolxis. Temporary unless you enable persistence in Settings." style="color:var(--mut);font-size:9px">auto</span>':'')+(!avail?(' <span title="'+esc(why)+'" style="color:#e06a5f;font-size:10px">[inactive]</span>'):'')+((a.risk&&a.risk.level&&a.risk.level!=='low')?(' <span title="'+esc(a.risk.note||'')+'" style="color:'+(a.risk.level==='high'?'#e06a5f':'#e0a55f')+';font-size:10px">\\u26A0 '+esc(a.risk.level)+'</span>'):'')+((a.stopped)?' <span style="color:var(--mut);font-size:10px">[stopped]</span>':'')+'</div><div style="margin-top:1px">'+(!avail?'<span class="afix" data-n="'+esc(a.name)+'" title="'+esc(why)+'" style="color:#e0a55f;cursor:pointer;font-size:11px;margin-right:10px;font-weight:600">fix</span>':'')+'<span class="arun" data-n="'+esc(a.name)+'" style="color:var(--accent);cursor:pointer;font-size:11px">run</span><span class="ajob" data-n="'+esc(a.name)+'" style="color:var(--accent);cursor:pointer;font-size:11px;margin-left:10px">job</span><span class="aana" data-n="'+esc(a.name)+'" style="color:var(--accent);cursor:pointer;font-size:11px;margin-left:10px">analyze</span><span class="asch" data-n="'+esc(a.name)+'" style="color:var(--accent);cursor:pointer;font-size:11px;margin-left:10px">schedule</span><span class="astp" data-n="'+esc(a.name)+'" data-stop="'+(a.stopped?'0':'1')+'" style="color:'+(a.stopped?'#7dd08a':'#e0a55f')+';cursor:pointer;font-size:11px;margin-left:10px">'+(a.stopped?'resume':'stop')+'</span><span class="adel" data-n="'+esc(a.name)+'" style="color:#e88;cursor:pointer;font-size:11px;margin-left:10px">delete</span></div>'+sl+'</div>'}).join('');
  [].slice.call(box.querySelectorAll('.afix')).forEach(function(x){x.onclick=function(){openJobModal(x.getAttribute('data-n'))}});
  [].slice.call(box.querySelectorAll('.arun')).forEach(function(x){x.onclick=function(){runAgentUI(x.getAttribute('data-n'))}});
  [].slice.call(box.querySelectorAll('.aopen')).forEach(function(x){x.onclick=function(){openAgentChat(x.getAttribute('data-n'))}});
  [].slice.call(box.querySelectorAll('.ajob')).forEach(function(x){x.onclick=function(){openJobModal(x.getAttribute('data-n'))}});
  [].slice.call(box.querySelectorAll('.aana')).forEach(function(x){x.onclick=function(){analyzeAgentUI(x.getAttribute('data-n'))}});
  [].slice.call(box.querySelectorAll('.asch')).forEach(function(x){x.onclick=function(){scheduleAgentUI(x.getAttribute('data-n'))}});
  [].slice.call(box.querySelectorAll('.astp')).forEach(function(x){x.onclick=function(){stopAgentUI(x.getAttribute('data-n'),x.getAttribute('data-stop')==='1')}});
  [].slice.call(box.querySelectorAll('.ascd')).forEach(function(x){x.onclick=function(){cancelSched(x.getAttribute('data-id'))}});
  [].slice.call(box.querySelectorAll('.adel')).forEach(function(x){x.onclick=function(){var n=x.getAttribute('data-n');if(!confirm('Delete agent "'+n+'"?'))return;fetch('/api/agents',{method:'POST',headers:hdrs(),body:JSON.stringify({action:'delete',name:n})}).then(function(){var tid='agent:'+n;threads=threads.filter(function(t){return t.id!==tid});if(cid===tid){loadThread('main')}else{saveThreads();renderThreads()}loadAgents()})}})}
function scheduleAgentUI(name){var when=prompt('When should "'+name+'" run? Say it in plain language:\\n  "every 5 minutes"\\n  "every day at noon"\\n  "weekdays at 9am"\\n  "every hour"');if(!when)return;var task=prompt('What should it do each time? (blank = its standard job)','');if(task===null)return;
  showToast('Working out the schedule...');
  fetch('/api/agents',{method:'POST',headers:hdrs(),body:JSON.stringify({action:'schedule',name:name,when:when,task:task||undefined})}).then(function(r){return r.json()}).then(function(d){if(d&&d.ok){if(d.schedules){SCHEDS=d.schedules;renderAgents()}showToast('Scheduled: '+(d.note||d.cron));setTimeout(hideToast,2800)}else{showToast((d&&d.error)?d.error:'Schedule failed.');setTimeout(hideToast,3200)}}).catch(function(){showToast('Schedule failed.')})}
function stopAgentUI(name,stop){fetch('/api/agents',{method:'POST',headers:hdrs(),body:JSON.stringify({action:'stop',name:name,stop:stop})}).then(function(r){return r.json()}).then(function(d){if(d){if(d.schedules)SCHEDS=d.schedules;loadAgents();showToast(stop?('Stopped "'+name+'" ('+(d.suspended||0)+' schedule(s) suspended)'):('Resumed "'+name+'"'));setTimeout(hideToast,2500)}}).catch(function(){showToast('Action failed.')})}
function analyzeAgentUI(name){showToast('Analyzing "'+name+'" with the smart model...');fetch('/api/agents',{method:'POST',headers:hdrs(),body:JSON.stringify({action:'analyze',name:name})}).then(function(r){return r.json()}).then(function(d){loadAgents();hideToast();if(d&&d.ok){alert('Analysis of "'+name+'":\\n\\n'+(d.assessment||'(no assessment)')+'\\n\\n'+(d.changed?'\\u2713 The prompt was improved.':'No change needed.'))}else{showToast((d&&d.note)?d.note:'Analyze failed.');setTimeout(hideToast,3000)}}).catch(function(){showToast('Analyze failed.')})}
function cancelSched(id){if(!confirm('Cancel this schedule?'))return;fetch('/api/agents',{method:'POST',headers:hdrs(),body:JSON.stringify({action:'unschedule',id:id})}).then(function(r){return r.ok?r.json():null}).then(function(d){if(d&&d.schedules){SCHEDS=d.schedules;renderAgents()}}).catch(function(){})}
function doRunAgent(name,task){switchView('chat');var m=add('bot',name,'(running '+name+'...)');setStatus('agent '+name+' running...');
  fetch('/api/agents',{method:'POST',headers:hdrs(),body:JSON.stringify({action:'run',name:name,task:task||undefined})}).then(function(r){return r.ok?r.json():null}).then(function(d){setStatus('');if(m)m.textContent=(d&&d.reply)?d.reply:'(no reply)';agentVia(m,d&&d.via);if(d&&d.schedules){SCHEDS=d.schedules;renderAgents()}if(d&&d.scheduled){showToast('Also scheduled: '+(d.scheduled.note||d.scheduled.cron));setTimeout(hideToast,3000)}}).catch(function(){setStatus('');if(m)m.textContent='(agent run failed)'})}
/* Stamp an agent reply's header with the model that produced it (name + capability color). */
function agentVia(m,via){if(!m||!m.whoEl||!via)return;var inner=String(via).replace(/^[^(]*\\(/,'').replace(/[)]$/,'');m.whoEl.dataset.vid=inner;setMeta(m.whoEl,null,null,via)}
function runAgentUI(name){var a=AGENTS.filter(function(x){return x.name===name})[0];
  if(a&&!a.open){doRunAgent(name,undefined);return} /* dedicated agent: run its standing job, no prompt */
  var task=prompt('Task for "'+name+'" (this is an open agent). Tip: say "every minute ..." and it will also be scheduled.','');if(task===null)return;doRunAgent(name,task||undefined)}
function createAgentPrompt(){var m=el('agentmodal');if(!m)return;el('am_name').value='';el('am_job').value='';fillModelSel('am_model','auto');m.style.display='flex';setTimeout(function(){el('am_name').focus()},30)}
function postCreateAgent(name,job,model,toolArr,open,autostart){
  var body={action:'create',name:name,job:job,model:model,tools:toolArr,canElevate:true,open:!!open};if(open)body.compile=false;if(typeof autostart==='boolean')body.autostart=autostart;
  fetch('/api/agents',{method:'POST',headers:hdrs(),body:JSON.stringify(body)}).then(function(r){return r.json()}).then(function(d){
    loadAgents();if(open){showToast('Open agent "'+name+'" created \\u2014 click run to give it a task.');setTimeout(hideToast,2800);return}var p=d&&d.plan;
    if(p&&p.ok){var parts=['executor: '+(p.executor||'?')];
      if(p.schedule&&p.schedule.cron)parts.push('schedule: '+(p.schedule.humanReadable||p.schedule.cron));
      if(p.skills&&p.skills.length)parts.push('skills: '+p.skills.join(', '));
      if(p.codeTools&&p.codeTools.length)parts.push('built tools: '+p.codeTools.map(function(t){return t.name}).join(', '));
      showToast('Compiled \\u2713  '+parts.join('  |  '));setTimeout(hideToast,3500);
      if(p.risk&&p.risk.level&&p.risk.level!=='low'){var rec=p.risk.recommendedModel||'claude';var cur=p.executor||model;
        if(rec!==cur&&confirm('\\u26A0 '+String(p.risk.level).toUpperCase()+' RISK\\n\\n'+(p.risk.note||'')+'\\n\\nPlanned to run on: '+cur+'\\nRun on the recommended (safer) model "'+rec+'" instead?')){postCreateAgent(name,job,rec,toolArr,false)}}
    }else{showToast('Agent saved (planner unavailable - runs on the raw job).');setTimeout(hideToast,2800)}
  }).catch(function(){showToast('Create failed.')})}
// Per-chat route picker: Auto, Local, every CONFIGURED provider, Free (rotate), Claude.
function rebuildRouteSelect(){var sel=el('route');if(!sel||!RAIL)return;var d=RAIL;var cur=sel.value||curRoute();
  var opts=[['auto','Auto']];
  if(d.localModel)opts.push(['local','Local']);
  (d.providers||[]).filter(function(p){return p.configured}).forEach(function(p){opts.push([p.id,p.label])});
  if((d.providers||[]).some(function(p){return p.kind==='free'&&p.configured}))opts.push(['freecloud','Free (rotate)']);
  if(d.claude&&d.claude.found)opts.push(['claude','Claude']);
  var has=opts.some(function(o){return o[0]===cur});var pick=has?cur:'auto';
  sel.innerHTML=opts.map(function(o){return '<option value="'+esc(o[0])+'"'+(o[0]===pick?' selected':'')+'>'+esc(o[1])+'</option>'}).join('');
  updateModelVis()}
function doInstall(target,outId,btn){var out=el(outId);if(out){out.style.display='';out.textContent='Installing '+target+'... this can take several minutes; leave the panel open.'}if(btn){btn.disabled=true;btn.textContent='Installing...'}
  fetch('/api/install',{method:'POST',headers:hdrs(),body:JSON.stringify({target:target})}).then(function(r){return r.json()}).then(function(d){
    if(out)out.textContent=(d&&d.output)?d.output:((d&&d.error)?d.error:'(no output)');
    if(btn){btn.disabled=false;btn.textContent=(d&&d.ok)?'Done':'Retry'}
    showToast((d&&d.ok)?'Install finished. Reload to refresh status.':'Install failed - see output.');setTimeout(hideToast,3500);
    loadRail()}).catch(function(){if(out)out.textContent='Request failed.';if(btn){btn.disabled=false;btn.textContent='Retry'}})}
function doPack(){var btn=el('packbtn');if(btn){btn.disabled=true;btn.textContent='Building...'}
  var body={soul:!!(el('pk_soul')&&el('pk_soul').checked),user:!!(el('pk_user')&&el('pk_user').checked),learnings:!!(el('pk_learn')&&el('pk_learn').checked)};
  showToast('Building install pack...');
  fetch('/api/pack',{method:'POST',headers:hdrs(),body:JSON.stringify(body)}).then(function(r){if(!r.ok)throw new Error('pack failed');var dn=r.headers.get('content-disposition')||'';var mm=/filename="([^"]+)"/.exec(dn);var fn=mm?mm[1]:'zamolxis-pack.json';var sk=r.headers.get('x-pack-skills')||'?';return r.blob().then(function(b){return {b:b,fn:fn,sk:sk}})}).then(function(o){var u=URL.createObjectURL(o.b);var a=document.createElement('a');a.href=u;a.download=o.fn;document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(u);showToast('Pack with '+o.sk+' skill(s) downloaded: '+o.fn+'. Seed a new install with: zamolxis unpack <file>');setTimeout(hideToast,5000)}).catch(function(){showToast('Pack failed.');setTimeout(hideToast,2500)}).then(function(){if(btn){btn.disabled=false;btn.textContent='Create install pack'}})}
function doUninstall(){var purge=!!(el('un_purge')&&el('un_purge').checked);
  var msg=purge
    ?'PERMANENTLY DELETE everything?\\n\\nThis stops '+AGENT_NAME+', removes the auto-start service and the global command, AND deletes your data dir (skills, memory, learned facts, and .env secrets). This cannot be undone.'
    :'Uninstall '+AGENT_NAME+'?\\n\\nStops it and removes the auto-start service + global command. Your data dir is KEPT, and the program folder stays for you to delete.';
  if(!confirm(msg))return;
  if(purge){var t=prompt('To confirm deleting ALL your data, type:  DELETE');if(t!=='DELETE'){showToast('Uninstall cancelled - confirmation text did not match.');setTimeout(hideToast,2500);return}}
  var b=el('uninstallbtn');if(b){b.disabled=true;b.textContent='Uninstalling...'}
  awaitingReload=true;showToast('Uninstalling '+AGENT_NAME+'... the server will stop shortly.');
  fetch('/api/uninstall',{method:'POST',headers:hdrs(),body:JSON.stringify({purge:purge})}).catch(function(){});}
var threads=[];try{threads=JSON.parse(localStorage.zx_threads||'[]')}catch(e){}
// The Main chat is permanent + undeletable, always first, and is bridged two-way to every
// configured messaging channel (Telegram, etc.).
threads=threads.filter(function(t){return t.id!=='main'});
threads.unshift({id:'main',label:'Main',main:true});
var cid=localStorage.zx_thread||'main';
if(!threads.some(function(t){return t.id===cid})){cid='main'}
var token=localStorage.zx_token||'';
var AGENT_NAME='__AGENT_NAME__',BOT_LABEL=AGENT_NAME.toLowerCase();
var ws=null,gen=0,cur=null,curStarted=false,awaitingReload=false,buildStarted=0;
var tabsData=[],activeView='chat';
function el(id){return document.getElementById(id)}
function setStatus(t){el('status').textContent=t}
function showToast(msg){var t=el('toast');t.textContent=msg;t.classList.add('show')}
function hideToast(){el('toast').classList.remove('show')}
function hdrs(){var h={'content-type':'application/json'};if(token)h['x-zamolxis-token']=token;return h}
function esc(v){return v==null?'':String(v).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;')}
function fmtTime(ts){try{return new Date(Number(ts)).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}catch(e){return ''}}
/* The "who" line carries a timestamp (always) + gen time/tokens (for replies), and
   is re-renderable so a name change relabels every past bubble too. */
function renderWho(w){if(!w)return;var t=w.dataset.ts?fmtTime(w.dataset.ts):'';
  if(w.dataset.role==='you'){w.textContent='you'+(t?' · '+t:'')}
  else{var s=w.dataset.secs,tok=w.dataset.tok,via=w.dataset.via;var x=(w.dataset.label||BOT_LABEL)+(t?' · '+t:'');if(s)x+=' · '+s+'s';if(tok)x+=' · '+tok+' tok';if(via)x+=' · via '+via;w.textContent=x;var vid=w.dataset.vid||via;w.style.color=vid?viaColor(vid):''}}
/* Human label for the model that produced an answer (from usage.last.model). */
function viaLabel(id){if(!id)return '';id=String(id);
  var m=id.match(/^(?:free|paid):([^:]+):/);if(m){var pp=(RAIL&&RAIL.providers||[]).filter(function(p){return p.id===m[1]})[0];return pp?pp.label:m[1]}
  if(id.indexOf('local:')===0)return 'Local';
  if(/claude|opus|sonnet|haiku/i.test(id))return 'Claude '+shortModel(id);
  return shortModel(id)}
function add(cls,who,text){var w=document.createElement('div');w.className='who';w.dataset.role=(cls==='user'?'you':'bot');w.dataset.ts=String(Date.now());if(cls!=='user'&&who&&who!==BOT_LABEL)w.dataset.label=who;renderWho(w);var m=document.createElement('div');m.className='msg '+cls;m.textContent=text;el('loginner').appendChild(w);el('loginner').appendChild(m);el('log').scrollTop=el('log').scrollHeight;m.whoEl=w;return m}
var genStart=0,genTimer=null;
function setMeta(w,secs,tokens,via){if(!w)return;if(secs!=null)w.dataset.secs=secs;if(tokens!=null)w.dataset.tok=fmtNum(tokens);if(via!=null)w.dataset.via=via;renderWho(w)}
function tickGen(){if(!cur||!cur.whoEl)return;setMeta(cur.whoEl,((Date.now()-genStart)/1000).toFixed(1),null)}
function startGen(){genStart=Date.now();if(genTimer)clearInterval(genTimer);genTimer=setInterval(tickGen,100)}
function stopGen(){if(genTimer){clearInterval(genTimer);genTimer=null}return((Date.now()-genStart)/1000).toFixed(1)}
function openWs(){
  var myGen=++gen;
  var proto=location.protocol==='https:'?'wss':'ws';
  var sock=new WebSocket(proto+'://'+location.host+'/?cid='+encodeURIComponent(cid)+'&token='+encodeURIComponent(token));
  ws=sock;
  sock.onopen=function(){if(myGen!==gen)return;setStatus('connected');if(awaitingReload){awaitingReload=false;hideToast();setStatus('settings applied')}};
  sock.onclose=function(){if(myGen!==gen)return;setStatus('disconnected - retrying');setTimeout(function(){if(myGen===gen)openWs()},2000)};
  sock.onmessage=function(ev){if(myGen!==gen)return;var m=JSON.parse(ev.data);
    if(m.type==='chunk'){if(!cur)cur=add('bot',BOT_LABEL,'');if(!curStarted){cur.textContent='';curStarted=true}cur.textContent+=m.text;el('log').scrollTop=el('log').scrollHeight}
    else if(m.type==='reply'){if(!cur)cur=add('bot',BOT_LABEL,'');cur.textContent=m.text;var w=cur.whoEl,secs=stopGen();setMeta(w,secs,null);cur=null;curStarted=false;setStatus('connected');
      fetch('/api/status',{headers:hdrs()}).then(function(r){return r.ok?r.json():null}).then(function(d){if(!d)return;renderModels(d);if(d.last&&w){w.dataset.vid=d.last.model||'';setMeta(w,secs,d.last.total,viaLabel(d.last.model))}if(d.last)maybeStick(d.last.model)}).catch(function(){})}
    else if(m.type==='status'){setStatus(m.text)}};
}
var routes={};try{routes=JSON.parse(localStorage.zx_routes||'{}')}catch(e){}
function curRoute(){return routes[cid]||'auto'}
function applyRoute(){var r=el('route');if(r)r.value=curRoute();updateModelVis()}
function tierFromModel(id){id=String(id||'').toLowerCase();return /claude|opus|sonnet|haiku/.test(id)?'claude':''}
function stickyOn(){return localStorage.zx_stickyesc!=='0'}
/* Sticky escalation: when an Auto chat is answered by the smart model (Claude took over), pin the
   chat to Claude so it doesn't bounce back to the local model. The user resets to Auto to undo. */
function maybeStick(modelId){if(!stickyOn())return;if(curRoute()!=='auto')return;if(tierFromModel(modelId)!=='claude')return;
  routes[cid]='claude';try{localStorage.zx_routes=JSON.stringify(routes)}catch(e){}
  var sel=el('route');if(sel){sel.value='claude';updateModelVis()}
  showToast('This chat escalated — pinned to Claude. Set the route back to Auto to undo.');setTimeout(hideToast,3500)}
var models={};try{models=JSON.parse(localStorage.zx_models||'{}')}catch(e){}
function curModel(){return models[cid]||''}
function applyModel(){var n=el('model');if(n)n.value=curModel()}
/* The Claude-model picker only applies when the turn goes to Claude. Show it when
   route=Claude (or when there's no local model, so route is hidden and all turns
   are Claude); hide it on Auto/Local where the model is chosen automatically/locally. */
// The Claude model picker is only meaningful when Claude is explicitly chosen. In Auto (and
// for local/provider routes) hide it — otherwise a stale selection gets sent and forces Claude.
function updateModelVis(){var re=el('route'),me=el('model');if(!me)return;me.style.display=(re&&re.value==='claude')?'':'none'}
function saveThreads(){localStorage.zx_threads=JSON.stringify(threads);localStorage.zx_thread=cid}
function isAgentCid(id){return !!id&&id.indexOf('agent:')===0}
function agentNameOf(id){return id.slice(6)}
function renderAgentThread(name){el('loginner').innerHTML='';
  var def=AGENTS.filter(function(a){return a.name===name})[0];
  if(def){var job='Job: '+(def.job||def.label||name);if(def.model)job+='\\n\\nRuns on: '+def.model+(def.canElevate?' (can escalate)':'');var sc=SCHEDS.filter(function(s){return s.agent===name})[0];if(sc)job+='\\nSchedule: '+(sc.cron||sc.at||'');add('bot','\\uD83E\\uDD16 '+name,job)}
  fetch('/api/agentmsgs?since=0',{headers:hdrs()}).then(function(r){return r.ok?r.json():[]}).then(function(ms){
    if(ms&&ms.length){AGENTLOG=ms;if(ms[ms.length-1].ts>agentSince)agentSince=ms[ms.length-1].ts}
    var any=false;AGENTLOG.forEach(function(m){if(m.from===name||m.to===name){var lbl=(m.from===name)?('\\uD83E\\uDD16 '+m.from+' \\u2192 '+m.to):(m.from+' \\u2192 '+name);add('bot',lbl,m.text);any=true}});
    if(!any)add('bot','\\uD83E\\uDD16 '+name,'(no messages yet - run '+name+', or wait for its next scheduled run)')
  }).catch(function(){})}
function loadThread(id){cid=id;saveThreads();applyRoute();applyModel();el('loginner').innerHTML='';cur=null;curStarted=false;
  if(isAgentCid(id)){var oa=ws;if(oa){try{oa.close()}catch(e){}}ws=null;renderAgentThread(agentNameOf(id));renderThreads();return}
  var old=ws;openWs();if(old){try{old.close()}catch(e){}}renderThreads();
  // Restore this thread's history from the server so switching chats doesn't lose it.
  fetch('/api/history?cid='+encodeURIComponent(id),{headers:hdrs()}).then(function(r){return r.ok?r.json():[]}).then(function(h){if(cid!==id||!h||!h.length)return;el('loginner').innerHTML='';h.forEach(function(t){if(t.role==='user')add('user','you',t.text);else add('bot',BOT_LABEL,t.text)})}).catch(function(){})}
function renderThreads(){var h='';threads.forEach(function(t){var del=(t.id==='main'||t.agent)?'':'<span class="del" data-del="'+t.id+'">delete</span>';h+='<div class="thread'+(t.id===cid?' cur':'')+'" data-id="'+t.id+'"><span class="lbl">'+esc(t.label)+'</span>'+del+'</div>'});el('threadlist').innerHTML=h;
  Array.prototype.forEach.call(el('threadlist').querySelectorAll('.thread'),function(n){n.onclick=function(e){if(e.target.getAttribute('data-del'))return;loadThread(n.getAttribute('data-id'))}});
  Array.prototype.forEach.call(el('threadlist').querySelectorAll('[data-del]'),function(n){n.onclick=function(e){e.stopPropagation();deleteThread(n.getAttribute('data-del'))}})}
function newChat(){var id=uuid();threads.unshift({id:id,label:'New chat'});loadThread(id);switchView('chat')}
function openAgentChat(name){var id='agent:'+name;if(!threads.some(function(t){return t.id===id})){threads.push({id:id,label:'\\uD83E\\uDD16 '+name,agent:name});saveThreads()}switchView('chat');loadThread(id)}
function deleteThread(id){if(id==='main')return; /* the Main chat is permanent */
  if(!isAgentCid(id))fetch('/api/forget',{method:'POST',headers:hdrs(),body:JSON.stringify({cid:id})}).catch(function(){});
  threads=threads.filter(function(t){return t.id!==id});if(id===cid){loadThread('main')}else{saveThreads();renderThreads()}}
var inHist=[];try{inHist=JSON.parse(localStorage.zx_inhist||'[]')}catch(e){}
var histPos=-1,histDraft='';
function pushHist(t){if(!t)return;if(inHist[inHist.length-1]!==t){inHist.push(t);if(inHist.length>100)inHist.shift();try{localStorage.zx_inhist=JSON.stringify(inHist)}catch(e){}}histPos=-1;histDraft=''}
var pending=[];var MAXUP=20*1024*1024;
function renameThreadFrom(t){if(!t)return;var th=threads.filter(function(x){return x.id===cid})[0];if(th&&(th.label==='New chat'||th.label==='Chat 1')){th.label=t.slice(0,32);saveThreads();renderThreads()}}
function sendMsg(){var t=el('in').value.trim();var files=pending.slice();if(!t&&!files.length)return;
  if(isAgentCid(cid)){if(!t)return;switchView('chat');add('user','you',t);pushHist(t);el('in').value='';var nm=agentNameOf(cid);var mm=add('bot','\\uD83E\\uDD16 '+nm,'(running...)');setStatus('agent '+nm+' running...');
    fetch('/api/agents',{method:'POST',headers:hdrs(),body:JSON.stringify({action:'run',name:nm,task:t})}).then(function(r){return r.ok?r.json():null}).then(function(d){setStatus('');if(mm)mm.textContent=(d&&d.reply)?d.reply:'(no reply)';agentVia(mm,d&&d.via)}).catch(function(){setStatus('');if(mm)mm.textContent='(run failed)'});return}
  if(!ws||ws.readyState!==1){setStatus('not connected');return}
  switchView('chat');
  var shown=t+(files.length?((t?'\\n':'')+files.map(function(f){return '📎 '+f.name}).join('\\n')):'');
  add('user','you',shown||'(file)');if(t)pushHist(t);el('in').value='';
  var sendModel=(el('model')&&el('model').style.display!=='none')?curModel():'';
  cur=add('bot',BOT_LABEL,'thinking...');curStarted=false;
  renameThreadFrom(t||(files[0]&&files[0].name));
  if(!files.length){setStatus('thinking...');startGen();ws.send(JSON.stringify({text:t,route:curRoute(),model:sendModel}));return}
  setStatus('uploading...');clearAttach();startGen();
  Promise.all(files.map(function(f){return fetch('/api/upload',{method:'POST',headers:hdrs(),body:JSON.stringify({chatId:cid,name:f.name,contentB64:f.b64})}).then(function(r){return r.ok?r.json():null})})).then(function(rs){
    var paths=rs.filter(Boolean).map(function(x){return x.path});
    if(!paths.length){setStatus('upload failed');if(cur){cur.textContent='(upload failed)'}return}
    var note=(t?t+'\\n\\n':'')+'Attached file(s) - read them with your tools to answer:\\n'+paths.map(function(p){return '- '+p}).join('\\n');
    setStatus('thinking...');ws.send(JSON.stringify({text:note,route:'claude',model:sendModel}));
  }).catch(function(){setStatus('upload failed');if(cur){cur.textContent='(upload failed)'}})}
el('route').onchange=function(){routes[cid]=el('route').value;localStorage.zx_routes=JSON.stringify(routes);updateModelVis()};applyRoute();
el('model').onchange=function(){models[cid]=el('model').value;localStorage.zx_models=JSON.stringify(models)};applyModel();
el('send').onclick=sendMsg;
function addFiles(list){var arr=[].slice.call(list||[]);if(!arr.length)return;arr.forEach(function(f){if(f.size>MAXUP){showToast('"'+f.name+'" is too big (max 20 MB).');setTimeout(hideToast,3000);return}var rd=new FileReader();rd.onload=function(){var s=String(rd.result||'');var i=s.indexOf(',');pending.push({name:f.name,size:f.size,b64:i>=0?s.slice(i+1):s});renderAttach()};rd.onerror=function(){showToast('Could not read "'+f.name+'".');setTimeout(hideToast,3000)};rd.readAsDataURL(f)})}
function renderAttach(){var bar=el('attachbar');if(!bar)return;bar.innerHTML=pending.map(function(f,i){return '<span class="achip">📎 <b title="'+esc(f.name)+'">'+esc(f.name)+'</b><span class="x" data-i="'+i+'">&times;</span></span>'}).join('');[].slice.call(bar.querySelectorAll('.x')).forEach(function(x){x.onclick=function(){pending.splice(+x.getAttribute('data-i'),1);renderAttach()}})}
function clearAttach(){pending=[];renderAttach()}
if(el('attach'))el('attach').onclick=function(){el('fileinput').click()};
if(el('fileinput'))el('fileinput').onchange=function(){addFiles(this.files);this.value=''};
el('in').addEventListener('paste',function(e){var f=e.clipboardData&&e.clipboardData.files;if(f&&f.length){e.preventDefault();addFiles(f)}});
(function(){var cv=el('chatview');if(!cv)return;function over(e){e.preventDefault();cv.classList.add('drag')}cv.addEventListener('dragenter',over);cv.addEventListener('dragover',over);cv.addEventListener('dragleave',function(e){e.preventDefault();cv.classList.remove('drag')});cv.addEventListener('drop',function(e){e.preventDefault();cv.classList.remove('drag');if(e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files.length)addFiles(e.dataTransfer.files)})})();
var ESC_OPEN=false,ESC_ITEMS=[],ESC_SEL=0,ESC_HEAD='',ESC_NUM=false;
var CAPS=[],BANMODELS=[];
function loadBanVocab(){fetch('/api/bans',{headers:hdrs()}).then(function(r){return r.ok?r.json():null}).then(function(d){if(d){CAPS=d.capabilities||[];BANMODELS=d.models||[]}}).catch(function(){})}
function escModels(){var d=RAIL;if(!d)return [];var list=[];if(d.localModel)list.push({label:'Local',name:String(d.localModel)});(d.providers||[]).filter(function(p){return p.configured}).forEach(function(p){list.push({label:p.label,name:p.model})});list.push({label:'Claude',name:'claude opus'});list.forEach(function(x){x.score=smartScore(x.name)});list.sort(function(a,b){return a.score-b.score});return list}
function escBoxEl(){var b=el('escac');if(b)return b;b=document.createElement('div');b.id='escac';b.style.cssText='display:none;position:fixed;z-index:80;max-height:240px;overflow:auto;background:#161108;border:1px solid var(--line);border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.5);font-size:13px';document.body.appendChild(b);return b}
function escHide(){ESC_OPEN=false;var b=el('escac');if(b)b.style.display='none'}
function escRender(){var b=escBoxEl();var r=el('in').getBoundingClientRect();b.style.left=r.left+'px';b.style.width=Math.min(460,r.width)+'px';b.style.bottom=(window.innerHeight-r.top+6)+'px';
  b.innerHTML='<div style="padding:4px 9px;color:var(--mut);font-size:11px;border-bottom:1px solid var(--line)">'+esc(ESC_HEAD||'escalate to')+' \\u2014 \\u2191\\u2193 then Enter</div>'+ESC_ITEMS.map(function(it,i){var col=it.color||(it.name?gradColor(smartScore(it.name)):'var(--ink)');return '<div class="escit" data-i="'+i+'" style="padding:6px 9px;cursor:pointer;display:flex;gap:8px;align-items:center;'+(i===ESC_SEL?'background:rgba(212,165,90,.18)':'')+'">'+(ESC_NUM?'<span style="color:var(--mut);width:14px;text-align:right">'+(i+1)+'</span>':'')+'<span style="flex:1;color:'+col+'">'+esc(it.label)+'</span><span style="color:var(--mut);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px">'+esc(it.name||'')+'</span></div>'}).join('');
  b.style.display='block';[].slice.call(b.querySelectorAll('.escit')).forEach(function(x){x.onmousedown=function(ev){ev.preventDefault();escPick(+x.getAttribute('data-i'))}})}
function escShow(partial){var all=escModels();if(!all.length){escHide();return}partial=(partial||'').trim().toLowerCase();var items=partial?all.filter(function(x){return x.label.toLowerCase().indexOf(partial)>=0||String(x.name).toLowerCase().indexOf(partial)>=0}):all;if(!items.length){escHide();return}items.forEach(function(it){it.fill='escalate '+it.label});ESC_ITEMS=items;ESC_SEL=0;ESC_OPEN=true;ESC_HEAD='escalate to';ESC_NUM=true;escRender()}
function escShowSlash(partial){partial=(partial||'').toLowerCase();
  var items=[];
  [['ban','manage skill bans'],['unban','manage skill bans'],['hasync','rebuild Home Assistant device map']].forEach(function(c){if(('/'+c[0]).indexOf('/'+partial)===0)items.push({label:'/'+c[0],name:c[1],fill:'/'+c[0]+(c[0]==='hasync'?'':' '),color:'var(--ink)'})});
  CAPS.forEach(function(c){if(c.toLowerCase().indexOf(partial)===0)items.push({label:'/'+c,name:'run this skill/tool',fill:'/'+c+' ',color:'var(--ink)'})});
  items=items.slice(0,40);
  if(!items.length){escHide();return}
  ESC_ITEMS=items;ESC_SEL=0;ESC_OPEN=true;ESC_HEAD='skills & commands';ESC_NUM=false;escRender()}
function escPick(i){var it=ESC_ITEMS[i];if(!it)return;el('in').value=(it.fill||('escalate '+it.label));escHide();el('in').focus()}
el('in').addEventListener('input',function(){var v=el('in').value;
  var em=v.match(/^(escalate|escalade|elevate)\\s+(.*)$/i);if(em){escShow(em[2]||'');return}
  var sl=v.match(/^[/]([a-z0-9_-]*)$/i);if(sl){escShowSlash(sl[1]||'');return}
  escHide()});
el('in').addEventListener('blur',function(){setTimeout(escHide,150)});
el('in').addEventListener('keydown',function(e){var n=el('in');
  if(ESC_OPEN){
    if(e.key==='ArrowDown'){ESC_SEL=Math.min(ESC_ITEMS.length-1,ESC_SEL+1);escRender();e.preventDefault();return}
    if(e.key==='ArrowUp'){ESC_SEL=Math.max(0,ESC_SEL-1);escRender();e.preventDefault();return}
    if((e.key==='Enter'&&!e.shiftKey)||e.key==='Tab'){escPick(ESC_SEL);e.preventDefault();return}
    if(e.key==='Escape'){escHide();e.preventDefault();return}
  }
  if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMsg();return}
  // Shell-style history: Up at the very start of the field, Down at the very end.
  if(e.key==='ArrowUp'&&n.selectionStart===0&&n.selectionEnd===0&&inHist.length){
    if(histPos===-1){histDraft=n.value;histPos=inHist.length}
    if(histPos>0){histPos--;n.value=inHist[histPos];e.preventDefault();setTimeout(function(){n.selectionStart=n.selectionEnd=0},0)}
  } else if(e.key==='ArrowDown'&&n.selectionStart===n.value.length&&n.selectionEnd===n.value.length&&histPos!==-1){
    if(histPos<inHist.length-1){histPos++;n.value=inHist[histPos]}else{histPos=-1;n.value=histDraft}
    e.preventDefault();
  }});
// Only ONE panel/overlay open at a time (prevents Settings opening UNDER Memory, etc.).
var panelDirty=false;
// Shift the page content aside by the open panel's width (the fixed panel then sits in the gap),
// so a tool panel pushes the chat over instead of covering it.
function pushAside(p){document.body.style.paddingRight=p?(p.getBoundingClientRect().width+'px'):''}
// Hard close: drop all tool panels + un-shift the content. No prompt (used by each panel's X).
function clearPanels(){['panel','mempanel','skillpanel','provpanel','localpanel','threadpanel'].forEach(function(id){var e=el(id);if(e)e.classList.remove('open')});document.body.style.paddingRight='';panelDirty=false}
// Switch close: when opening another tool, warn first if the current panel has unsaved edits.
function closePanels(){if(panelDirty&&!confirm('You have unsaved changes in this panel. Discard them and switch?'))return false;clearPanels();return true}
function closeTools(){var d=el('toolsdrop');if(d)d.classList.remove('open')}
el('toolsbtn').onclick=function(e){e.stopPropagation();el('toolsdrop').classList.toggle('open')};
document.addEventListener('click',function(){closeTools()});
if(el('newagent'))el('newagent').onclick=createAgentPrompt;
var JM_NAME='';
function openJobModal(name){var a=AGENTS.filter(function(x){return x.name===name})[0];if(!a)return;JM_NAME=name;el('jm_name').textContent=name;el('jm_job').value=a.job||'';el('jm_spec').textContent=a.spec||'(not compiled yet)';fillModelSel('jm_model',a.model||'auto');var w=el('jm_why');if(w){if(modelAvail(a.model)){w.style.display='none';w.textContent=''}else{w.style.display='block';w.textContent='\\u26A0 Inactive: '+modelWhy(a.model)}}el('jobmodal').style.display='flex';setTimeout(function(){el('jm_job').focus()},30)}
if(el('jm_cancel'))el('jm_cancel').onclick=function(){el('jobmodal').style.display='none'};
if(el('jobmodal'))el('jobmodal').onclick=function(e){if(e.target===el('jobmodal'))el('jobmodal').style.display='none'};
if(el('jm_save'))el('jm_save').onclick=function(){var nj=el('jm_job').value.trim();if(!nj){el('jm_job').focus();return}var a=AGENTS.filter(function(x){return x.name===JM_NAME})[0];var mdl=(el('jm_model')&&el('jm_model').value)||(a&&a.model)||'auto';var tl=(a&&a.tools&&a.tools.length)?a.tools:undefined;el('jobmodal').style.display='none';showToast('Recompiling "'+JM_NAME+'" with the smart model...');postCreateAgent(JM_NAME,nj,mdl,tl,false,undefined)};
if(el('am_cancel'))el('am_cancel').onclick=function(){el('agentmodal').style.display='none'};
if(el('agentmodal'))el('agentmodal').onclick=function(e){if(e.target===el('agentmodal'))el('agentmodal').style.display='none'};
if(el('am_create'))el('am_create').onclick=function(){var nm=el('am_name').value.trim();if(!nm){el('am_name').focus();return}var jb=el('am_job').value.trim();var asv=el('am_autostart')?el('am_autostart').value:'';var as=asv==='resume'?true:asv==='pause'?false:undefined;el('agentmodal').style.display='none';
  var mdl=(el('am_model')&&el('am_model').value)||'auto';
  if(jb){showToast('The smart model is writing the plan (instructions, skills, schedule)...');postCreateAgent(nm,jb,mdl,undefined,false,as)}
  else{showToast('Creating open agent...');postCreateAgent(nm,'Open agent: carry out whatever task you are given when you are run.',mdl,undefined,true,as)}};
// Auto-detect the user's timezone and persist it (once) so agents report LOCAL time even on a UTC host.
(function autoTz(){try{var tz=Intl.DateTimeFormat().resolvedOptions().timeZone;if(!tz)return;fetch('/api/settings',{headers:hdrs()}).then(function(r){return r.ok?r.json():null}).then(function(s){if(s&&s.live&&!s.live.timezone){fetch('/api/settings',{method:'POST',headers:hdrs(),body:JSON.stringify({live:{timezone:tz}})}).catch(function(){})}}).catch(function(){})}catch(e){}})();
(function setupRailResize(){var rail=el('provrail'),sec=el('provsec'),split=el('railsplit'),sec2=el('agentsec'),split2=el('railsplit2'),wh=el('railwidth');if(!rail||!sec||!split||!wh)return;
  try{if(localStorage.zx_railsplit)sec.style.height=localStorage.zx_railsplit}catch(e){}
  try{if(localStorage.zx_railsplit2&&sec2)sec2.style.height=localStorage.zx_railsplit2}catch(e){}
  try{if(localStorage.zx_railw)rail.style.width=localStorage.zx_railw}catch(e){}
  var dragY=false,dragY2=false,dragX=false;
  split.addEventListener('mousedown',function(e){dragY=true;e.preventDefault();document.body.style.userSelect='none'});
  if(split2)split2.addEventListener('mousedown',function(e){dragY2=true;e.preventDefault();document.body.style.userSelect='none'});
  wh.addEventListener('mousedown',function(e){dragX=true;e.preventDefault();document.body.style.userSelect='none'});
  document.addEventListener('mousemove',function(e){
    if(dragY){var top=rail.getBoundingClientRect().top;var h=Math.max(42,Math.min(rail.clientHeight-120,e.clientY-top));sec.style.height=h+'px'}
    if(dragY2&&sec2){var t2=sec2.getBoundingClientRect().top;var h2=Math.max(42,Math.min(rail.clientHeight-70,e.clientY-t2));sec2.style.height=h2+'px'}
    if(dragX){var left=rail.getBoundingClientRect().left;var w=Math.max(120,Math.min(440,e.clientX-left));rail.style.width=w+'px'}});
  document.addEventListener('mouseup',function(){if(dragY){try{localStorage.zx_railsplit=sec.style.height}catch(e){}}if(dragY2&&sec2){try{localStorage.zx_railsplit2=sec2.style.height}catch(e){}}if(dragX){try{localStorage.zx_railw=rail.style.width}catch(e){}}if(dragY||dragY2||dragX)document.body.style.userSelect='';dragY=false;dragY2=false;dragX=false});
})();
el('newchat').onclick=newChat;
el('cog').onclick=function(){if(closePanels()===false)return;closeTools();el('panel').classList.add('open');pushAside(el('panel'));loadSettings()};
el('close').onclick=function(){clearPanels()};
el('mem').onclick=function(){if(closePanels()===false)return;closeTools();loadMemory();el('mempanel').classList.add('open');pushAside(el('mempanel'))};
el('memclose').onclick=function(){clearPanels()};
/* ---- skills ---- */
function renderSkills(list){var arr=list||[];
  var own=arr.filter(function(s){return s.source!=='external'}).length, ext=arr.length-own;
  var h='<input id="skillfilter" placeholder="filter skills (e.g. docker, weather, stocks)..." style="width:100%;margin-bottom:8px">';
  h+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><span style="flex:1;font-size:11px;color:var(--mut)">'+own+' own · '+ext+' external (Hermes) — filter, then <b>Import all shown</b>, or Import one.</span><button id="impall" style="font-size:12px;padding:3px 10px">Import all shown</button></div>';
  if(!arr.length)h+='<div style="color:var(--mut)">No skills yet. The agent creates skills as it learns; import external ones below.</div>';
  arr.forEach(function(s){
    var external=(s.source==='external');
    var tag=(s.name+' '+(s.description||'')+' '+(s.category||'')).toLowerCase();
    h+='<div class="skrow" data-s="'+esc(tag)+'" data-ext="'+(external?1:0)+'" style="border:1px solid var(--line);border-radius:10px;padding:10px;margin-bottom:10px'+(s.enabled?'':';opacity:.55')+'">';
    h+='<div style="display:flex;align-items:center;gap:8px"><b class="accent" style="flex:1">'+esc(s.name)+'</b>';
    if(external){h+='<span style="font-size:10px;color:var(--mut);border:1px solid var(--line);border-radius:6px;padding:1px 6px">Hermes'+(s.category?' · '+esc(s.category):'')+'</span><button class="impbtn" data-imp="'+esc(s.name)+'" style="font-size:12px;padding:2px 10px">Import</button>';}
    else{h+='<label class="chk" style="margin:0;font-size:12px"><input type="checkbox" data-en="'+esc(s.name)+'"'+(s.enabled?' checked':'')+'> on</label><span class="del" data-del="'+esc(s.name)+'">delete</span>';}
    h+='</div>';
    h+='<div style="font-size:12px;color:var(--mut);margin:4px 0">'+esc(s.description)+'</div>';
    h+='<details><summary style="cursor:pointer;font-size:12px;color:var(--accent)">view</summary><pre style="white-space:pre-wrap;font-size:12px;background:#0c0a07;border:1px solid var(--line);border-radius:8px;padding:8px;overflow:auto;max-height:240px;margin:6px 0 0">'+esc(s.body)+'</pre></details>';
    h+='</div>';
  });
  el('skillview').innerHTML=h;
  var fi=el('skillfilter');if(fi)fi.oninput=skFilter;
  var ia=el('impall');if(ia)ia.onclick=importShown;
  Array.prototype.forEach.call(el('skillview').querySelectorAll('[data-en]'),function(n){n.onchange=function(){skillAction(n.checked?'enable':'disable',n.getAttribute('data-en'))}});
  Array.prototype.forEach.call(el('skillview').querySelectorAll('[data-del]'),function(n){n.onclick=function(){if(confirm('Delete skill "'+n.getAttribute('data-del')+'"?'))skillAction('delete',n.getAttribute('data-del'))}});
  Array.prototype.forEach.call(el('skillview').querySelectorAll('[data-imp]'),function(n){n.onclick=function(){var nm=n.getAttribute('data-imp');n.disabled=true;n.textContent='...';skillAction('import',nm);showToast('Imported "'+nm+'".');setTimeout(hideToast,2000)}});
  skFilter();}
function skFilter(){var fi=el('skillfilter');var q=(fi?fi.value:'').toLowerCase();var n=0;
  Array.prototype.forEach.call(el('skillview').querySelectorAll('.skrow'),function(r){var vis=(!q||r.getAttribute('data-s').indexOf(q)>=0);r.style.display=vis?'':'none';if(vis&&r.getAttribute('data-ext')==='1')n++;});
  var b=el('impall');if(b){b.textContent=n?('Import all shown ('+n+')'):'Import all shown';b.disabled=!n;b.style.opacity=n?'1':'.5';}}
function importShown(){var names=[];
  Array.prototype.forEach.call(el('skillview').querySelectorAll('.skrow'),function(r){if(r.style.display==='none')return;var b=r.querySelector('[data-imp]');if(b)names.push(b.getAttribute('data-imp'))});
  if(!names.length){showToast('No external skills shown.');setTimeout(hideToast,1600);return;}
  if(!confirm('Import '+names.length+' Hermes skill(s) into your own skills?'))return;
  showToast('Importing '+names.length+'...');
  fetch('/api/skills',{method:'POST',headers:hdrs(),body:JSON.stringify({action:'import',slugs:names})}).then(function(r){return r.json()}).then(function(d){if(d&&d.skills)renderSkills(d.skills);showToast('Imported '+names.length+' skill(s).');setTimeout(hideToast,2400)}).catch(function(){showToast('Import failed.');setTimeout(hideToast,2000)})}
function loadSkills(){fetch('/api/skills',{headers:hdrs()}).then(function(r){return r.ok?r.json():null}).then(function(d){renderSkills(d)})}
function skillAction(action,slug){fetch('/api/skills',{method:'POST',headers:hdrs(),body:JSON.stringify({action:action,slug:slug})}).then(function(r){return r.json()}).then(function(d){if(d&&d.skills)renderSkills(d.skills)}).catch(function(){})}
el('skillsbtn').onclick=function(){if(closePanels()===false)return;closeTools();loadSkills();el('skillpanel').classList.add('open');pushAside(el('skillpanel'))};
el('skillclose').onclick=function(){clearPanels()};
/* ---- AI providers ---- */
function provRow(p){var lim=(p.kind==='free'&&p.freeDaily&&p.used>=p.freeDaily);
  var color=!p.configured?C_OFF:(lim?C_BAD:C_OK);var lbl=!p.configured?'no key':(lim?'limit reached':'ready');
  var s='<div style="border:1px solid var(--line);border-radius:10px;padding:10px;margin-bottom:10px">';
  s+='<div style="display:flex;align-items:center;gap:8px">'+dotHtml(color,lbl)+'<b style="flex:1;color:'+color+'">'+esc(p.label)+'</b><span style="font-size:11px;color:var(--mut)">id: '+esc(p.id)+'</span><span style="font-size:12px;color:'+color+'">'+lbl+'</span></div>';
  s+='<div style="font-size:12px;color:var(--mut);margin:3px 0">'+esc(p.note)+' · model '+esc(p.model)+(p.kind==="free"?(' · used today '+p.used+'/'+p.freeDaily):'')+'</div>';
  s+='<a href="'+esc(p.signup)+'" target="_blank" rel="noopener" style="color:var(--accent);font-size:12px">Get a key &#8599;</a>';
  s+='<input id="prov_'+esc(p.envKey)+'" type="password" autocomplete="new-password" value="'+(p.configured?KEYMASK:'')+'" placeholder="'+(p.configured?"configured - leave to keep":"paste API key")+'" style="margin-top:6px">';
  return s+'</div>'}
function renderProviders(d){var provs=d.providers||[];var h='';
  h+='<div style="font-size:12px;color:var(--mut);margin-bottom:8px">Routing order: each tier is tried in turn; if it can\\'t cope it hands off to the next. Drop "claude" to run only on local/free/paid models. To USE a provider, add its id to the chain.</div>';
  h+='<label>Routing chain (comma-separated, in order)</label><input id="prov_chain" value="'+esc((d.routeChain||[]).join(', '))+'">';
  var presets=[["local only","local"],["local + free","local,freecloud"],["local + free + Claude","local,freecloud,claude"],["free + Claude","freecloud,claude"],["Claude only","claude"]];
  h+='<div style="font-size:11px;color:var(--mut);margin:4px 0">Tokens: local, freecloud, claude, or a provider id ('+esc(provs.map(function(p){return p.id}).join(", "))+'). Presets: '+presets.map(function(pr){return '<a href="#" class="preset" data-c="'+pr[1]+'">'+pr[0]+'</a>'}).join(" · ")+'</div>';
  function pcard(inner){return '<div style="border:1px solid var(--line);border-radius:10px;padding:10px;margin-bottom:10px">'+inner+'</div>'}
  // On-device (free, offline)
  h+='<div class="sec">On-device (free · offline · unlimited)</div>';
  h+=pcard('<div style="display:flex;gap:8px;align-items:center"><b class="accent" style="flex:1">Local model</b><span style="font-size:11px;color:var(--mut)">token: local</span></div><div style="font-size:12px;color:var(--mut);margin-top:3px">'+(d.localModel?('<span style="color:#7dd08a">'+esc(d.localModel)+'</span> · runs on your machine, no quota used'):'<span style="color:#e0a55f">none installed</span> - run install.ps1 -Local (or install.sh --local)')+'</div>');
  // Subscription / CLI — Claude + other login-based CLI AIs.
  h+='<div class="sec">Subscription / CLI (no API key)</div>';
  var cl=d.claude||{};var clis=d.cli||[];
  // "active" CLI providers = usable right now. When exactly one is in use, show explicit
  // "login ok" text; when several, rely on the status DOT colour instead (less noise).
  var activeCli=[];if(cl.found&&!cl.expired)activeCli.push('claude');
  clis.forEach(function(c){if(c.installed&&c.loggedIn)activeCli.push(c.id)});
  var single=activeCli.length<=1;
  var clColor=cl.found?(cl.expired?C_BAD:C_OK):C_WARN;
  var clText=cl.found?(cl.expired?'login expired':'login ok'):'login unknown';
  h+=pcard('<div style="display:flex;gap:8px;align-items:center">'+dotHtml(clColor,clText)+'<b style="flex:1;color:'+clColor+'">Claude - your Pro/Max subscription</b>'+(single?'<span style="color:'+clColor+';font-size:12px">'+clText+'</span>':'')+'<span style="font-size:11px;color:var(--mut)">token: claude</span></div><div style="font-size:12px;color:var(--mut);margin-top:3px">Runs via Claude Code (<code>claude auth login</code>) on your subscription - no API key, flat rate. Models: '+esc(cl.primary||'')+' · fast '+esc(cl.fast||'')+' · smart '+esc(cl.smart||'')+' (change in Settings &#8594; Engine).</div>');
  clis.forEach(function(c){
    var color=!c.installed?C_OFF:(c.loggedIn?C_OK:C_WARN);
    var txt=!c.installed?'not installed':(c.loggedIn?'login ok':'not logged in');
    var inner='<div style="display:flex;gap:8px;align-items:center">'+dotHtml(color,txt)+'<b style="flex:1;color:'+color+'">'+esc(c.name)+'</b>'+(single?'<span style="color:'+color+';font-size:12px">'+txt+'</span>':'')+'</div>';
    inner+='<div style="font-size:12px;color:var(--mut);margin-top:3px">';
    if(!c.installed)inner+='Not installed. Click Install to add it (runs on the host). ';
    else if(!c.loggedIn)inner+='Installed. Log in once on the host: <code>'+esc(c.loginCmd)+'</code>. ';
    else inner+='Installed and logged in. ';
    inner+='<a href="'+esc(c.docs)+'" target="_blank" rel="noopener" style="color:var(--accent)">docs &#8599;</a></div>';
    if(!c.installed)inner+='<button class="instbtn" data-inst="'+esc(c.id)+'" style="margin-top:6px">Install</button>';
    inner+='<pre class="instout" id="instout_'+esc(c.id)+'" style="display:none;white-space:pre-wrap;font-size:11px;background:#0c0a07;border:1px solid var(--line);border-radius:8px;padding:8px;overflow:auto;max-height:200px;margin:6px 0 0"></pre>';
    h+=pcard(inner);
  });
  // Free / Paid API providers
  h+='<div class="sec">Free providers (API key · one per provider)</div>'+provs.filter(function(p){return p.kind==="free"}).map(provRow).join('');
  h+='<div class="sec">Paid providers (API key · billed to you)</div>'+provs.filter(function(p){return p.kind==="paid"}).map(provRow).join('');
  // Web search keys (move out of Settings - these are AI-service keys)
  var sp=d.searchProvider||'duckduckgo';
  h+='<div class="sec">Web search '+(sp&&sp!=='duckduckgo'?'('+esc(sp)+' active)':'(DuckDuckGo by default - no key needed)')+'</div>';
  (d.search||[]).forEach(function(s2){var sc=s2.set?C_OK:C_OFF;
    h+=pcard('<div style="display:flex;gap:8px;align-items:center">'+dotHtml(sc,s2.set?'key set':'no key')+'<b style="flex:1;color:'+sc+'">'+esc(s2.label)+'</b><span style="font-size:12px;color:'+sc+'">'+(s2.set?'key set':'no key')+'</span></div><a href="'+esc(s2.signup)+'" target="_blank" rel="noopener" style="color:var(--accent);font-size:12px">Get a key &#8599;</a><input id="prov_'+esc(s2.envKey)+'" type="password" autocomplete="new-password" value="'+(s2.set?KEYMASK:'')+'" placeholder="'+(s2.set?'configured - leave to keep':'paste API key')+'" style="margin-top:6px">');
  });
  el('provview').innerHTML=h;RAIL=d;renderRail();
  Array.prototype.forEach.call(el('provview').querySelectorAll('.preset'),function(a){a.onclick=function(e){e.preventDefault();el('prov_chain').value=a.getAttribute('data-c').split(',').join(', ')}});
  Array.prototype.forEach.call(el('provview').querySelectorAll('.instbtn'),function(b){b.onclick=function(){var id=b.getAttribute('data-inst');doInstall(id,'instout_'+id,b)}})}
function loadProviders(){fetch('/api/providers',{headers:hdrs()}).then(function(r){return r.ok?r.json():null}).then(function(d){if(d)renderProviders(d)})}
function saveProviders(){panelDirty=false;var creds={};Array.prototype.forEach.call(document.querySelectorAll('[id^="prov_"]'),function(n){if(n.id==='prov_chain')return;if(n.value&&n.value!==KEYMASK)creds[n.id.slice(5)]=n.value});
  fetch('/api/settings',{method:'POST',headers:hdrs(),body:JSON.stringify({live:{routeChain:el('prov_chain').value},credentials:creds})}).then(function(r){return r.json()}).then(function(s){
    if(s&&s.restartRequired){awaitingReload=true;el('provpanel').classList.remove('open');showToast('Saved. Applying and reconnecting...')}else{showToast('Saved.');loadProviders();loadRail();setTimeout(hideToast,2000)}}).catch(function(){})}
el('provbtn').onclick=function(){if(closePanels()===false)return;closeTools();loadProviders();el('provpanel').classList.add('open');pushAside(el('provpanel'))};
el('provclose').onclick=function(){clearPanels()};
el('provsave').onclick=saveProviders;
/* ---- local model ---- */
var LOCALPOLL=null;
function fmtGB(b){return b?(Math.round(b/1073741824*10)/10)+' GB':''}
function loadLocal(){fetch('/api/local',{headers:hdrs()}).then(function(r){return r.ok?r.json():null}).then(function(d){if(d)renderLocal(d);else{var v=el('localview');if(v)v.textContent='(unavailable)'}}).catch(function(){var v=el('localview');if(v)v.textContent='(unavailable)'})}
function postLocal(action,model,value){var body={action:action};if(model)body.model=model;if(value!==undefined)body.value=value;
  return fetch('/api/local',{method:'POST',headers:hdrs(),body:JSON.stringify(body)}).then(function(r){if(r.ok)return r.json();return r.json().then(function(e){throw e})}).then(function(d){renderLocal(d);return d}).catch(function(e){if(e&&e.error)showToast(e.error);setTimeout(loadLocal,300)})}
function renderLocal(d){var v=el('localview');if(!v)return;var h='';
  if(!d.ollamaInstalled){
    h+='<div style="border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:12px">';
    h+='<div style="color:#e0a55f;font-weight:600;margin-bottom:6px">Ollama is not installed</div>';
    h+='<div style="font-size:12px;color:var(--mut);margin-bottom:8px">Ollama runs the on-device model (the offline, no-quota fallback tier). Install it to use a local model.</div>';
    if(d.install&&d.install.running){h+='<div style="font-size:12px">Installing... this can take a few minutes.</div>'}
    else if(d.install&&d.install.error){h+='<div style="font-size:12px;color:#e07a5f">Install failed: '+esc(d.install.error)+'</div><button id="lc_install" style="margin-top:8px">Retry install</button>'}
    else{h+='<button id="lc_install">Install Ollama</button> <a href="https://ollama.com/download" target="_blank" style="font-size:12px;color:var(--mut);margin-left:8px">or download manually</a>'}
    h+='</div>';v.innerHTML=h;
    if(el('lc_install'))el('lc_install').onclick=function(){showToast('Installing Ollama...');postLocal('install-ollama');startLocalPoll()};
    if(d.install&&d.install.running)startLocalPoll();return;
  }
  if(!d.ollamaRunning){h+='<div style="font-size:12px;color:#e0a55f;margin-bottom:10px">Ollama is installed but not responding at '+esc(d.base)+'. Start it ("ollama serve"); models appear once it is up.</div>'}
  h+='<div class="sec">Active local model</div>';
  h+='<div style="font-size:13px;margin-bottom:8px">'+(d.active?('<b class="accent">'+esc(d.active)+'</b>'):'<span style="color:var(--mut)">none selected - pull one below, then Use it</span>')+'</div>';
  h+='<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:6px">';
  h+='<label style="font-size:12px;color:var(--mut)">Routing</label><select id="lc_routing" style="width:auto"><option value="off"'+(d.localRouting==='off'?' selected':'')+'>off (only when forced)</option><option value="auto"'+(d.localRouting==='auto'?' selected':'')+'>auto (last-resort tier)</option></select>';
  h+='</div>';
  var kaOpts=[['','model default'],['5m','5 min'],['15m','15 min'],['30m','30 min'],['1h','1 hour'],['-1','keep loaded'],['0','unload after']];
  h+='<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:4px">';
  h+='<label style="font-size:12px;color:var(--mut)">Context</label><input id="lc_ctx" type="number" min="0" step="512" value="'+(d.localContext||0)+'" style="width:80px" title="num_ctx; 0 = model default">';
  h+='<label style="font-size:12px;color:var(--mut)">Keep-alive</label><select id="lc_ka" style="width:auto">'+kaOpts.map(function(o){return '<option value="'+o[0]+'"'+((d.localKeepAlive||'')===o[0]?' selected':'')+'>'+o[1]+'</option>'}).join('')+'</select>';
  h+='<label style="font-size:12px;color:var(--mut)">Temp</label><input id="lc_temp" type="number" min="0" max="2" step="0.1" value="'+(d.localTemp===null||d.localTemp===undefined?'':d.localTemp)+'" placeholder="default" style="width:74px" title="sampling temperature; blank = model default">';
  h+='<button id="lc_apply" style="font-size:12px">Apply</button>';
  h+='</div>';
  h+='<div style="font-size:11px;color:var(--mut);margin-bottom:12px">Routing "auto" = local is the last-resort tier (free cloud first). Context 0 / Temp blank = model default. Keep-alive = how long Ollama keeps the model in VRAM.</div>';
  h+='<div class="sec">Installed models</div>';
  if(d.installed&&d.installed.length){h+=d.installed.map(function(m){var act=m.name===d.active;var ld=(d.loaded||{})[m.name];
    var meta=fmtGB(m.size)+(ld?(' \\u00b7 '+ld.gpuPct+'% GPU'):'');
    return '<div class="lc_irow"><div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--line)"><b style="flex:1'+(act?';color:#7dd08a':'')+'">'+esc(m.name)+(act?' (active)':'')+(ld?' \\u25cf':'')+'</b><span style="font-size:11px;color:var(--mut)">'+meta+'</span>'+(act?'':'<button class="lc_use" data-m="'+esc(m.name)+'" style="font-size:12px;padding:2px 8px">Use</button>')+'<button class="lc_test" data-m="'+esc(m.name)+'" style="font-size:12px;padding:2px 8px">Test</button>'+(act?'':'<button class="lc_del" data-m="'+esc(m.name)+'" style="font-size:12px;padding:2px 8px">Delete</button>')+'</div><div class="lc_tres" style="display:none;font-size:11px;color:var(--mut);padding:2px 0 6px"></div></div>'}).join('')}
  else{h+='<div style="color:var(--mut)">(none yet - pull one below)</div>'}
  h+='<div class="sec" style="margin-top:14px">Add a model (general-chat all-rounders, tool-capable)</div>';
  h+=(d.catalog||[]).map(function(c){var pull=(d.pulls||{})[c.id];var right;
    if(c.installed){right='<span style="font-size:11px;color:#7dd08a">installed</span>'}
    else if(pull&&!pull.done){right='<span style="font-size:11px;color:var(--accent)">'+esc(pull.status)+' '+(pull.pct||0)+'%</span>'}
    else if(pull&&pull.error){right='<button class="lc_pull" data-m="'+esc(c.id)+'" style="font-size:12px">Retry</button>'}
    else{right='<button class="lc_pull" data-m="'+esc(c.id)+'" style="font-size:12px">Pull</button>'}
    return '<div style="border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin-bottom:8px"><div style="display:flex;align-items:center;gap:8px"><b style="flex:1">'+esc(c.id)+'</b><span style="font-size:11px;color:var(--mut)">~'+c.need+' GB</span>'+right+'</div><div style="font-size:12px;color:var(--mut);margin-top:3px">'+esc(c.desc)+((pull&&pull.error)?(' <span style="color:#e07a5f">'+esc(pull.error)+'</span>'):'')+'</div></div>'}).join('');
  h+='<div style="display:flex;gap:6px;margin-top:6px"><input id="lc_custom" placeholder="other Ollama tag, e.g. phi3:mini" style="flex:1"><button id="lc_pullcustom" style="font-size:12px">Pull</button></div>';
  h+='<div style="font-size:11px;color:var(--mut);margin-top:4px">Browse the full library at <a href="https://ollama.com/library" target="_blank" style="color:var(--mut)">ollama.com/library</a>. Pull several and switch any time with Use.</div>';
  v.innerHTML=h;
  if(el('lc_routing'))el('lc_routing').onchange=function(){postLocal('routing',null,el('lc_routing').value).then(function(){loadRail()})};
  if(el('lc_apply'))el('lc_apply').onclick=function(){var ctx=Number(el('lc_ctx').value)||0;var ka=el('lc_ka').value;var tv=el('lc_temp').value;
    postLocal('context',null,ctx).then(function(){return postLocal('keepalive',null,ka)}).then(function(){return postLocal('temp',null,tv===''?'':Number(tv))}).then(function(){showToast('Local settings applied');setTimeout(hideToast,1300)})};
  Array.prototype.forEach.call(v.querySelectorAll('.lc_use'),function(b){b.onclick=function(){showToast('Switching to '+b.getAttribute('data-m')+'...');postLocal('use',b.getAttribute('data-m')).then(function(){loadRail();setTimeout(hideToast,1500)})}});
  Array.prototype.forEach.call(v.querySelectorAll('.lc_test'),function(b){b.onclick=function(){var m=b.getAttribute('data-m');var row=b.parentNode.parentNode;var out=row.querySelector('.lc_tres');b.disabled=true;b.textContent='testing...';if(out){out.style.display='block';out.textContent='running...'}
    fetch('/api/local',{method:'POST',headers:hdrs(),body:JSON.stringify({action:'test',model:m})}).then(function(r){return r.json()}).then(function(t){b.disabled=false;b.textContent='Test';if(out){out.textContent=t.ok?('\\u2713 '+(t.ms||0)+' ms: '+(t.reply||'(empty)')):('\\u2717 '+(t.error||'failed'));out.style.color=t.ok?'#7dd08a':'#e07a5f'}}).catch(function(){b.disabled=false;b.textContent='Test';if(out)out.textContent='(request failed)'})}});
  Array.prototype.forEach.call(v.querySelectorAll('.lc_del'),function(b){b.onclick=function(){if(confirm('Delete '+b.getAttribute('data-m')+' from disk?'))postLocal('delete',b.getAttribute('data-m'))}});
  Array.prototype.forEach.call(v.querySelectorAll('.lc_pull'),function(b){b.onclick=function(){postLocal('pull',b.getAttribute('data-m'));startLocalPoll()}});
  if(el('lc_pullcustom'))el('lc_pullcustom').onclick=function(){var t=(el('lc_custom').value||'').trim();if(t){postLocal('pull',t);startLocalPoll()}};
  var busy=(d.install&&d.install.running)||Object.keys(d.pulls||{}).some(function(k){return !d.pulls[k].done});
  if(busy)startLocalPoll();else stopLocalPoll();
}
function startLocalPoll(){if(LOCALPOLL)return;LOCALPOLL=setInterval(function(){if(!el('localpanel').classList.contains('open')){stopLocalPoll();return}loadLocal()},1500)}
function stopLocalPoll(){if(LOCALPOLL){clearInterval(LOCALPOLL);LOCALPOLL=null}}
el('localbtn').onclick=function(){if(closePanels()===false)return;closeTools();loadLocal();el('localpanel').classList.add('open');pushAside(el('localpanel'))};
if(el('helpbtn'))el('helpbtn').onclick=function(){closeTools();window.open('/help','_blank')};
el('localclose').onclick=function(){clearPanels();stopLocalPoll()};
/* ---- tabs ---- */
function ago(ts){if(!ts)return'';var s=Math.floor((Date.now()-ts)/1000);if(s<60)return s+'s ago';if(s<3600)return Math.floor(s/60)+'m ago';if(s<86400)return Math.floor(s/3600)+'h ago';return Math.floor(s/86400)+'d ago'}
function md(s){s=String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  function inl(t){t=t.replace(/\\*\\*([^*]+)\\*\\*/g,'<b>$1</b>').replace(/\\*([^*]+)\\*/g,'<i>$1</i>');return t.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)]+)\\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>')}
  var lines=s.split('\\n'),out=[],ul=false;
  for(var i=0;i<lines.length;i++){var ln=lines[i];
    if(/^\\s*-\\s+/.test(ln)){if(!ul){out.push('<ul>');ul=true}out.push('<li>'+inl(ln.replace(/^\\s*-\\s+/,''))+'</li>');continue}
    if(ul){out.push('</ul>');ul=false}
    if(/^###\\s+/.test(ln))out.push('<h4>'+inl(ln.replace(/^###\\s+/,''))+'</h4>');
    else if(/^##\\s+/.test(ln))out.push('<h3>'+inl(ln.replace(/^##\\s+/,''))+'</h3>');
    else if(/^#\\s+/.test(ln))out.push('<h2>'+inl(ln.replace(/^#\\s+/,''))+'</h2>');
    else if(ln.trim()==='')out.push('<br>');
    else out.push('<p>'+inl(ln)+'</p>')}
  if(ul)out.push('</ul>');return out.join('')}
function renderTabBar(){var h='<button class="tab'+(activeView==='chat'?' active':'')+'" data-v="chat">Chat</button>';
  tabsData.forEach(function(t){h+='<button class="tab'+(activeView===t.id?' active':'')+'" data-v="'+t.id+'">'+esc(t.title)+'</button>'});
  el('tabbar').innerHTML=h;
  Array.prototype.forEach.call(el('tabbar').querySelectorAll('.tab'),function(n){n.onclick=function(){switchView(n.getAttribute('data-v'))}});
  el('tabbar').style.display=tabsData.length?'flex':'none'}
function renderTabContent(){var t=tabsData.filter(function(x){return x.id===activeView})[0];if(!t){switchView('chat');return}
  el('tabinner').innerHTML='<div class="tabhead"><h2>'+esc(t.title)+'</h2><span class="when">'+(t.refreshSeconds?('auto every '+t.refreshSeconds+'s · '):'')+'updated '+ago(t.updatedAt)+'</span></div><div class="tabbody">'+(t.content?md(t.content):'<span style="color:var(--mut)">(empty)</span>')+'</div>'}
function switchView(v){activeView=v;
  if(v==='chat'){el('chatview').style.display='flex';el('tabview').classList.remove('show')}
  else{el('chatview').style.display='none';el('tabview').classList.add('show');renderTabContent()}
  renderTabBar()}
function fetchTabs(){fetch('/api/tabs',{headers:hdrs()}).then(function(r){return r.ok?r.json():null}).then(function(d){if(!d)return;tabsData=d;
  if(activeView!=='chat'&&!tabsData.some(function(t){return t.id===activeView}))activeView='chat';
  renderTabBar();if(activeView!=='chat')renderTabContent()}).catch(function(){})}
/* ---- settings ---- */
function inp(id,val,type){var ac=(type==='password')?'new-password':'off';return '<input id="s_'+id+'" name="zx_'+id+'" autocomplete="'+ac+'" value="'+esc(val)+'"'+(type?(' type="'+type+'"'):'')+'>'}
function sel(id,opts,c){var h='<select id="s_'+id+'">';opts.forEach(function(o){var label=o===''?'(default)':o;h+='<option value="'+esc(o)+'"'+(o===c?' selected':'')+'>'+label+'</option>'});return h+'</select>'}
function sec(title){return '<div class="sec">'+title+'</div>'}
function loadSettings(){fetch('/api/settings',{headers:hdrs()}).then(function(r){
    if(r.status===401){var t=prompt('Auth token required:');if(t){token=t;localStorage.zx_token=t;openWs();loadSettings()}return null}
    return r.json()}).then(function(s){if(!s)return;renderSettings(s)})}
function renderSettings(s){var L=s.live,m=s.meta,h='';
  h+=sec('Claude subscription (login)');
  h+='<div style="font-size:12px;color:var(--mut);margin-bottom:6px">Zamolxis answers on your Claude Pro/Max subscription. On macOS the usual <code>claude auth login</code> stores the token in the Keychain, which the background engine cannot read - so paste a token here instead. In a terminal run <code>claude setup-token</code>, copy the line that starts with <code>sk-ant-oat01-</code>, and paste it below. Applies immediately on Save - no restart, no file editing.</div>';
  h+=credInputs('claude');
  h+=sec('Agents');
  h+='<label class="chk" style="font-size:13px;display:block"><input type="checkbox" id="mirroragents"> Mirror agent messages into the active chat (on by default)</label>';
  h+='<label class="chk" style="font-size:13px;display:block"><input type="checkbox" id="stickyesc"> Sticky escalation: when a chat escalates to Claude, keep it on Claude until you set the route back to Auto (on by default)</label>';
  h+='<div style="font-size:11px;color:var(--mut);margin-top:2px">Create/run agents in the left rail (under Providers). Messages between agents and to you appear in the active chat when mirroring is on.</div>';
  h+='<label class="chk" style="font-size:13px;display:block;margin-top:6px"><input type="checkbox" id="s_live_agentRestore"'+(L.agentRestore!==false?' checked':'')+'> Restore agents to their last state on startup</label>';
  h+='<label class="chk" style="font-size:13px;display:block;margin-top:6px"><input type="checkbox" id="s_live_persistAgentCreated"'+(L.persistAgentCreated?' checked':'')+'> Keep agents that Zamolxis created itself after restart (off = they are temporary)</label>';
  h+='<div style="font-size:11px;color:var(--mut);margin-top:2px">On (default): stopped agents stay stopped, scheduled agents keep running after a restart. Off: all agents start paused until you resume them. (A per-agent setting at creation can override this.)</div>';
  h+=sec('Startup');
  h+='<label class="chk" style="font-size:13px;display:block"><input type="checkbox" id="autostart"> Start Zamolxis automatically when I log in</label>';
  h+='<div id="autostatus" style="font-size:11px;color:var(--mut);margin-top:2px"></div>';
  h+=sec('Updates');
  h+='<button type="button" id="checkupd">Check for updates</button> <span id="updres" style="font-size:12px;color:var(--mut)">checks GitHub for a newer version.</span>';
  h+=sec('Engine (applies on next message)');
  h+='<label>Agent name (shown everywhere)</label>'+inp('live_agentName',L.agentName);
  h+='<label>Model</label>'+sel('live_model',m.models,L.model);
  h+='<label>Fast model (auto-used for simple Claude turns; primary model handles complex ones)</label>'+sel('live_fastModel',m.models,L.fastModel);
  h+='<label>Smartest model (used when a local-model turn escalates because it could not cope)</label>'+sel('live_smartModel',m.models,L.smartModel);
  h+='<div style="font-size:11px;color:var(--mut);margin-top:2px">These three are the <b>Claude</b> tier\\'s models. On-device and free/paid providers each have their own fixed model — manage which ones run, and in what order, in the <b class="accent">Providers</b> panel.</div>';
  h+='<label>Timezone for "what time is it" (IANA, e.g. America/New_York; blank = host clock)</label>'+inp('live_timezone',L.timezone||'');
  h+='<div style="font-size:11px;color:var(--mut);margin-top:2px">Auto-detected from your browser. Agents report the time in this zone even if the server runs on UTC.</div>';
  if(L.localModel){h+='<label>Local model routing — '+esc(L.localModel)+' (on-device; answers simple turns without using the subscription)</label>'+sel('live_localRouting',['off','auto'],L.localRouting);
    h+='<div style="font-size:11px;color:var(--mut);margin-top:2px">auto = answer simple messages locally and escalate the rest to Claude · off = always use Claude</div>'}
  else{h+='<label>Local model</label><div style="font-size:12px;color:var(--mut)">none installed - run install.ps1 -Local (or install.sh --local) to add one</div>'}
  h+='<div style="font-size:11px;color:var(--mut);margin-top:4px">Web search: <span style="color:#7dd08a">enabled ('+esc(m.searchProvider||'duckduckgo')+')</span> - Claude and the local model can search'+(m.searchProvider==='duckduckgo'?' (keyless; add a Tavily/Brave key or ZAMOLXIS_SEARXNG_URL for higher quality)':'')+'</div>';
  h+='<label>Permission mode</label>'+sel('live_permissionMode',m.permissionModes,L.permissionMode);
  h+='<label>Default sandbox backend</label>'+sel('live_sandboxBackend',m.configuredBackends,L.sandboxBackend);
  h+='<label>Max turns per message</label>'+inp('live_maxTurns',L.maxTurns,'number');
  h+='<label>Max concurrent (restart)</label>'+inp('live_maxConcurrent',L.maxConcurrent,'number');
  h+='<label>System prompt append</label><textarea id="s_live_systemPromptAppend" rows="3">'+esc(L.systemPromptAppend)+'</textarea>';
  if(s.identity){h+=sec('Identity & memory (applies next message)');
    h+='<label class="chk"><input type="checkbox" id="s_live_lawsEnabled"'+(L.lawsEnabled?' checked':'')+'> Enforce safety laws (uncheck to A/B test speed &amp; behavior)</label>';
    h+='<label>⚖ LAWS.md - safety laws (HIGHEST priority; the agent obeys these over everything and cannot edit them)</label><textarea id="s_id_laws" rows="8">'+esc(s.identity.laws||'')+'</textarea>';
    h+='<div style="font-size:11px;color:var(--mut);margin:2px 0 6px">Adapted from Asimov\\'s Laws. Edit with care - blanking this removes the safety constraints. <button type="button" id="resetlaws" style="padding:2px 8px;font-size:11px">Reset to defaults</button></div>';
    h+='<label>SOUL.md - persona / voice (you own this; the agent will not rewrite it)</label><textarea id="s_id_soul" rows="4">'+esc(s.identity.soul)+'</textarea>';
    var uu=s.identity.userUsage||{pct:0,max:0};
    h+='<label>USER.md - your profile (agent-maintained, '+uu.pct+'% of '+uu.max+' chars; you can also edit)</label><textarea id="s_id_user" rows="4">'+esc(s.identity.user)+'</textarea>';
    h+='<div style="font-size:11px;color:var(--mut);margin-top:2px">Working memory &amp; learned facts live in the <b class="accent">Memory</b> panel (top bar).</div>';
  }
  // Channels grouped: each channel's enable toggle sits WITH its own settings/keys.
  h+=sec('Channels (restart to apply)');var running=s.running||[];
  function credInputs(group){return s.credentials.filter(function(f){return f.group===group}).map(function(f){var note=f.secret?(f.set?' (configured - leave to keep)':' (not set)'):'';return '<label>'+f.label+note+'</label>'+inp('cr_'+f.key,f.secret?(f.set?KEYMASK:''):f.value,f.secret?'password':'')}).join('')}
  m.channels.forEach(function(c){var on=s.channels[c];var live=running.indexOf(c)>=0?' <span style="color:#7dd08a">(live)</span>':(on?' <span style="color:#d08a5f">(enabled, not running)</span>':'');
    h+='<div style="border:1px solid var(--line);border-radius:10px;padding:10px;margin-bottom:8px">';
    h+='<label class="chk" style="margin:0"><input type="checkbox" id="s_ch_'+c+'"'+(on?' checked':'')+'> <b style="text-transform:capitalize">'+c+'</b>'+live+'</label>';
    if(c==='web'){h+='<label>Port</label>'+inp('web_port',s.web.port,'number')+'<label>Bind (127.0.0.1 = local; 0.0.0.0 = network, needs token)</label>'+inp('web_bind',s.web.bind)+'<label>Network access password '+(s.web.authTokenSet?'(set - blank keeps it)':'(not needed for local)')+'</label>'+inp('web_authToken','','password');}
    else{var ci=credInputs(c);if(ci)h+=ci;if(c==='whatsapp')h+='<div style="font-size:11px;color:var(--mut);margin-top:4px">Pairs by QR code on first run - no token.</div>';if(c==='cli')h+='<div style="font-size:11px;color:var(--mut);margin-top:4px">Always available in the terminal.</div>'}
    h+='</div>';});
  h+=sec('Sandbox docker / ssh (restart)');
  h+='<div id="dockerstat" style="font-size:12px;color:var(--mut);display:flex;align-items:center;gap:7px;margin:2px 0 6px">Docker: checking...</div>';
  h+='<button type="button" id="dockerinst" style="display:none;margin-bottom:6px">Install Docker</button>';
  h+='<pre class="instout" id="instout_docker" style="display:none;white-space:pre-wrap;font-size:11px;background:#0c0a07;border:1px solid var(--line);border-radius:8px;padding:8px;overflow:auto;max-height:200px;margin:0 0 8px"></pre>';
  h+='<label>Docker image</label>'+inp('sb_dockerImage',s.sandbox.dockerImage);
  h+='<label>Docker container</label>'+inp('sb_dockerContainer',s.sandbox.dockerContainer);
  h+='<label>SSH host</label>'+inp('sb_sshHost',s.sandbox.sshHost);
  h+='<label>SSH user</label>'+inp('sb_sshUser',s.sandbox.sshUser);
  h+='<label>SSH port</label>'+inp('sb_sshPort',s.sandbox.sshPort,'number');
  h+='<label>SSH identity file</label>'+inp('sb_sshIdentity',s.sandbox.sshIdentity);
  h+=sec('Portable setup pack (seed a new install)');
  h+='<div style="font-size:12px;color:var(--mut);margin-bottom:6px">Bundles <b>all your skills</b> into one file to seed a fresh install. Your credentials and API keys (e.g. the Home Assistant token) are <b>never</b> included — they stay on this machine. Persona/profile/teachings are opt-in below.</div>';
  h+='<label class="chk" style="margin:2px 0;font-size:13px"><input type="checkbox" id="pk_soul"> include persona (SOUL.md)</label>';
  h+='<label class="chk" style="margin:2px 0;font-size:13px"><input type="checkbox" id="pk_user"> include your profile (USER.md)</label>';
  h+='<label class="chk" style="margin:2px 0;font-size:13px"><input type="checkbox" id="pk_learn"> include learned facts (LEARNINGS.md)</label>';
  h+='<button type="button" id="packbtn" style="margin-top:6px">Create install pack</button>';
  h+=sec('Model usage');
  h+='<div id="usagebox" style="font-size:12px;color:var(--mut)">loading...</div>';
  h+=sec('Danger zone');
  h+='<div style="font-size:12px;color:var(--mut);margin-bottom:6px">Uninstall stops '+esc(AGENT_NAME)+', removes its auto-start service, and unlinks the global <code>zamolxis</code> command. Your data ('+esc(m.dataDir)+') is <b>kept</b> unless you tick the box below. The program folder is left in place for you to delete.</div>';
  h+='<label class="chk" style="margin:2px 0;font-size:13px;color:#e88"><input type="checkbox" id="un_purge"> also permanently delete my data (skills, memory, learned facts, and .env secrets)</label>';
  h+='<button type="button" id="uninstallbtn" style="margin-top:6px;border-color:#a44;color:#e88">Uninstall '+esc(AGENT_NAME)+'</button>';
  el('settings').innerHTML=h;el('ro').innerHTML='Data dir: '+m.dataDir+'<br>'+m.restartNote;fetchUsage();
  var pkb=el('packbtn');if(pkb)pkb.onclick=doPack;
  var ma=el('mirroragents');if(ma){ma.checked=(localStorage.zx_mirror!=='0');ma.onchange=function(){localStorage.zx_mirror=ma.checked?'1':'0'}}
  var se=el('stickyesc');if(se){se.checked=stickyOn();se.onchange=function(){localStorage.zx_stickyesc=se.checked?'1':'0'}}
  var asb=el('autostart');if(asb){fetch('/api/autostart',{headers:hdrs()}).then(function(r){return r.ok?r.json():null}).then(function(st){if(!st)return;asb.checked=!!st.enabled;if(!st.supported)asb.disabled=true;var ad=el('autostatus');if(ad)ad.textContent=st.note||''}).catch(function(){});
    asb.onchange=function(){var ad=el('autostatus');if(ad)ad.textContent='...';fetch('/api/autostart',{method:'POST',headers:hdrs(),body:JSON.stringify({enabled:asb.checked})}).then(function(r){return r.json()}).then(function(st){asb.checked=!!st.enabled;if(ad)ad.textContent=st.note||''}).catch(function(){if(ad)ad.textContent='Failed.'})}}
  var unb=el('uninstallbtn');if(unb)unb.onclick=doUninstall;
  var cub=el('checkupd');if(cub)cub.onclick=function(){var r=el('updres');cub.disabled=true;if(r)r.textContent='checking...';
    fetch('/api/checkupdate',{method:'POST',headers:hdrs()}).then(function(x){return x.ok?x.json():null}).then(function(u){cub.disabled=false;if(!r)return;
      if(!u||!u.isRepo){r.innerHTML='Can\\'t auto-update: no git checkout found, or git isn\\'t on the server\\'s PATH. Update manually in the install folder: git pull, npm run build, restart.';return}
      if(u.behind>0){r.innerHTML='<b style="color:var(--accent)">Update available: '+u.behind+' new.</b> ';var ub=document.createElement('button');ub.type='button';ub.textContent='Update now';ub.style.marginLeft='6px';ub.onclick=doUpdate;r.appendChild(ub);fetchStatus()}
      else{r.textContent='You are up to date (build matches GitHub).'}
    }).catch(function(){cub.disabled=false;if(r)r.textContent='check failed.'})};
  fetch('/api/install',{headers:hdrs()}).then(function(r){return r.ok?r.json():null}).then(function(d){var st=el('dockerstat');if(!st||!d)return;
    if(d.docker){st.innerHTML=dotHtml(C_OK,'installed')+'<span>Docker is installed.</span>'}
    else{st.innerHTML=dotHtml(C_OFF,'not installed')+'<span>Docker not found on PATH.</span>';var b=el('dockerinst');if(b){b.style.display='';b.onclick=function(){doInstall('docker','instout_docker',b)}}}}).catch(function(){});
  var rl=el('resetlaws');if(rl)rl.onclick=function(){if(!confirm('Restore the default safety laws?'))return;fetch('/api/settings',{method:'POST',headers:hdrs(),body:JSON.stringify({identity:{resetLaws:true}})}).then(function(r){return r.json()}).then(function(s){if(s&&s.identity)renderSettings(s);showToast('Safety laws reset to defaults.');setTimeout(hideToast,2500)})}}
function fmtNum(n){return (n||0).toLocaleString()}
function usageRows(models){var ks=Object.keys(models||{});if(!ks.length)return '<div style="color:var(--mut);margin:2px 0 4px">none yet</div>';
  return '<table style="width:100%;border-collapse:collapse;margin:4px 0 2px"><tr style="color:var(--accent)"><td>model</td><td style="text-align:right">tokens</td><td style="text-align:right">calls</td></tr>'+
    ks.map(function(k){var u=models[k];return '<tr><td>'+esc(k)+'</td><td style="text-align:right">'+fmtNum(u.total)+'</td><td style="text-align:right">'+u.calls+'</td></tr>'}).join('')+'</table>'}
function fetchUsage(){fetch('/api/usage',{headers:hdrs()}).then(function(r){return r.ok?r.json():null}).then(function(d){var box=el('usagebox');if(!box)return;
  if(!d){box.textContent='(usage tracking unavailable)';return}
  var h='';
  if(d.engine){h+='<div style="margin:2px 0 4px"><b class="accent">Subscription engine (Claude)</b> <span style="color:var(--mut)">- flat-rate, not billed per token</span></div>';
    h+='session: '+fmtNum(d.engine.session.totals.total)+' tok, '+d.engine.session.totals.calls+' turn(s)'+usageRows(d.engine.session.models);
    h+='all time: '+fmtNum(d.engine.total.totals.total)+' tok, '+d.engine.total.totals.calls+' turn(s)'+usageRows(d.engine.total.models)}
  h+='<div style="margin:12px 0 4px"><b class="accent">Paid models (metered)</b> <span style="color:var(--mut)">- billed to the provider</span></div>';
  h+='session: '+fmtNum(d.session.totals.total)+' tok, '+d.session.totals.calls+' call(s)'+usageRows(d.session.models);
  h+='all time: '+fmtNum(d.total.totals.total)+' tok, '+d.total.totals.calls+' call(s)'+usageRows(d.total.models);
  box.innerHTML=h}).catch(function(){})}
el('save').onclick=function(){
  panelDirty=false;
  var v=function(id){var n=el('s_'+id);return n?n.value:undefined};
  var ck=function(id){var n=el('s_'+id);return n?n.checked:undefined};
  var patch={live:{agentName:v('live_agentName'),model:v('live_model'),fastModel:v('live_fastModel'),smartModel:v('live_smartModel'),timezone:v('live_timezone'),localRouting:v('live_localRouting'),lawsEnabled:ck('live_lawsEnabled'),agentRestore:ck('live_agentRestore'),persistAgentCreated:ck('live_persistAgentCreated'),permissionMode:v('live_permissionMode'),sandboxBackend:v('live_sandboxBackend'),systemPromptAppend:v('live_systemPromptAppend'),maxTurns:Number(v('live_maxTurns')),maxConcurrent:Number(v('live_maxConcurrent'))},
    identity:{laws:v('id_laws'),soul:v('id_soul'),user:v('id_user')},channels:{},web:{port:Number(v('web_port')),bind:v('web_bind'),authToken:v('web_authToken')},
    sandbox:{dockerImage:v('sb_dockerImage'),dockerContainer:v('sb_dockerContainer'),sshHost:v('sb_sshHost'),sshUser:v('sb_sshUser'),sshPort:v('sb_sshPort'),sshIdentity:v('sb_sshIdentity')},credentials:{}};
  ['cli','telegram','discord','slack','whatsapp','signal','email','web'].forEach(function(c){var x=ck('ch_'+c);if(x!==undefined)patch.channels[c]=x});
  Array.prototype.forEach.call(document.querySelectorAll('[id^="s_cr_"]'),function(n){if(n.value!==KEYMASK)patch.credentials[n.id.slice(5)]=n.value});
  fetch('/api/settings',{method:'POST',headers:hdrs(),body:JSON.stringify(patch)}).then(function(r){return r.json()}).then(function(s){
    if(!s||!s.live)return;renderSettings(s);
    if(s.live.agentName){AGENT_NAME=s.live.agentName;BOT_LABEL=AGENT_NAME.toLowerCase();document.title=AGENT_NAME;var b=el('brand');if(b)b.textContent=AGENT_NAME;el('in').placeholder='Message '+AGENT_NAME+'...'}
    if(s.restartRequired){var np=String(s.web.port),cp=(location.port||'80');
      if(np!==cp){showToast('Settings saved. Zamolxis is moving to port '+np+'. Open http://'+location.hostname+':'+np+' once it restarts.');el('panel').classList.remove('open');return}
      awaitingReload=true;el('panel').classList.remove('open');showToast('Applying settings and restarting channels... reconnecting in a few seconds.')}
    else{showToast('Settings saved.');setStatus('settings saved');setTimeout(hideToast,2500)}})};
/* ---- live agent name + host clock + auth status ---- */
function applyName(n){if(!n||n===AGENT_NAME)return;AGENT_NAME=n;BOT_LABEL=n.toLowerCase();document.title=n;var b=el('brand');if(b)b.textContent=n;var i=el('in');if(i)i.placeholder='Message '+n+'...';
  /* relabel every existing bot bubble so no old name lingers anywhere on the page */
  Array.prototype.forEach.call(document.querySelectorAll('#loginner .who'),function(w){if(w.dataset.role==='bot')renderWho(w)})}
var srvAnchor=0,cliAnchor=0,clockTz=undefined;
function tickClock(){if(!srvAnchor)return;var now=new Date(srvAnchor+(Date.now()-cliAnchor));
  try{el('clock').textContent=now.toLocaleString([],{timeZone:clockTz,weekday:'short',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',second:'2-digit'})}
  catch(e){el('clock').textContent=now.toLocaleString()}}
function shortModel(m){return String(m==null?'':m).replace(/^claude-/,'').replace(/-(\d{6,8}|latest)$/,'')}
function renderModels(d){var box=el('models');if(!box)return;
  var avail=[];if(d.models){if(d.models.primary)avail.push({n:d.models.primary,local:false});if(d.models.fast&&d.models.fast!==d.models.primary)avail.push({n:d.models.fast,local:false});if(d.models.local)avail.push({n:d.models.local,local:true})}
  if(RAIL&&RAIL.providers)RAIL.providers.filter(function(p){return p.configured}).forEach(function(p){avail.push({n:p.model,local:false,prov:true,plabel:p.label})});
  var last=d.last||null;var usedId=last&&last.model?String(last.model):'';
  if(usedId!==LAST_USED){LAST_USED=usedId;if(RAIL)renderRail()}
  function isUsed(a){return usedId&&(usedId===a||usedId.indexOf(a)>=0)}
  var anyUsed=false;
  var h='<span style="color:var(--mut)">models:</span>';
  h+=avail.map(function(a){var u=isUsed(a.n);if(u)anyUsed=true;return '<span class="mchip'+(u?' used':'')+'" title="'+(a.prov?esc(a.plabel)+' provider ('+esc(a.n)+')':(a.local?'on-device model (no subscription used)':'subscription model'))+'">'+esc(a.prov?a.plabel:a.n)+(a.local?' ⚡':'')+'</span>'}).join('');
  if(usedId&&!anyUsed){h+='<span class="mchip used" title="model used for the last answer">'+esc(shortModel(usedId))+'</span>'}
  if(last){h+='<span class="tok" title="tokens used for the last answer">'+fmtNum(last.total)+' tok</span>';
    h+='<span style="color:var(--mut)" title="input / output tokens">('+fmtNum(last.input)+'→'+fmtNum(last.output)+')</span>'}
  box.innerHTML=h;
  var rt=el('route');if(rt)rt.style.display='';updateModelVis()}
function doRestart(){if(!confirm('Restart Zamolxis to load the new build? The page will reconnect in a few seconds.'))return;awaitingReload=true;showToast('Restarting Zamolxis...');var b=el('build');if(b){b.textContent='⟳ restarting...';b.onclick=null;b.style.cursor='default'}
  fetch('/api/restart',{method:'POST',headers:hdrs()}).catch(function(){});
  setTimeout(function(){location.reload()},7000);}
function doUpdate(){if(!confirm('Update Zamolxis now?\\n\\nThis will: git pull, reinstall dependencies, rebuild, then restart. It can take a minute or two - the page reconnects automatically once it is back.'))return;
  awaitingReload=true;var startedBefore=buildStarted;
  showToast('Updating: pull + install + build + restart. This can take a minute...');
  var b=el('build');if(b){b.textContent='⬆ updating...';b.onclick=null;b.style.cursor='default';b.style.textDecoration='none'}
  fetch('/api/update',{method:'POST',headers:hdrs()}).catch(function(){});
  setTimeout(function(){waitForServer(0,startedBefore)},8000);}
function waitForServer(tries,startedBefore){if(tries>90){showToast('Update is still running - reload the page manually once it finishes.');return}
  setTimeout(function(){fetch('/api/status',{headers:hdrs()}).then(function(r){return r&&r.ok?r.json():null}).then(function(d){
    if(d&&d.build&&d.build.started&&d.build.started!==startedBefore){showToast('Updated - reloading...');setTimeout(function(){location.reload()},900)}
    else{waitForServer(tries+1,startedBefore)}}).catch(function(){waitForServer(tries+1,startedBefore)})},4000);}
function fetchStatus(){fetch('/api/status',{headers:hdrs()}).then(function(r){return r.ok?r.json():null}).then(function(d){if(!d)return;
  LASTD=d;applyName(d.agentName);renderModels(d);srvAnchor=d.time;cliAnchor=Date.now();clockTz=d.tz;tickClock();
  var vr=el('version');if(vr&&d.version){var bn=String(d.version.build==null?0:d.version.build);while(bn.length<3)bn='0'+bn;vr.textContent='v'+d.version.pkg+' · build '+bn;vr.title=(d.version.commit?'commit '+d.version.commit:'')+' (build '+bn+')'}
  if(d.tempUntil){var ms=d.tempUntil-Date.now();if(ms>0&&ms<3600000)setTimeout(fetchStatus,ms+800)}
  if(d.build&&d.build.started)buildStarted=d.build.started;
  var b=el('build');if(b){var up=d.update;
    if(up&&up.isRepo&&up.behind>0){b.style.display='';b.textContent='⬆ update available ('+up.behind+' new) - click to update';b.title='A newer version is on GitHub (origin/'+esc(up.branch||'main')+', '+esc(up.remote||'')+'). Click to pull, reinstall, rebuild and restart.';b.style.cursor='pointer';b.style.textDecoration='underline';b.onclick=doUpdate}
    else if(d.build&&d.build.stale){b.style.display='';b.textContent='⟳ outdated build - click to restart';b.title='The running process predates the latest build. Click to restart Zamolxis and load it.';b.style.cursor='pointer';b.style.textDecoration='underline';b.onclick=doRestart}
    else{b.style.display='none';b.onclick=null}}
  var a=el('auth');if(!a)return;var au=d.auth||{};
  if(!au.found){a.className='warn';a.textContent='login: unknown';a.title='Could not read the Claude credentials file (it may be in an OS keychain).'}
  else if(au.expired){a.className='bad';a.textContent='login expired';a.title='Subscription login expired. On the host run: claude auth login  (older Claude Code used: claude login)  then restart Zamolxis.'}
  else{a.className='ok';a.textContent='login ok';var t=new Date(au.expiresAt);
    a.title='Subscription login is valid. The short-lived access token renews automatically (~'+t.toLocaleTimeString()+'); you only need to sign in again (run "claude auth login" on the host \\u2014 older Claude Code used "claude login") if this shows expired.'}
}).catch(function(){})}
setInterval(tickClock,1000);fetchStatus();setInterval(fetchStatus,30000);
// Agent messages (agent->agent / agent->user): poll and mirror into the active chat (default on).
var agentSince=Date.now();var AGENTLOG=[];
function mirrorOn(){return localStorage.zx_mirror!=='0'}
function pollAgentMsgs(){fetch('/api/agentmsgs?since='+agentSince,{headers:hdrs()}).then(function(r){return r.ok?r.json():[]}).then(function(ms){if(!ms||!ms.length)return;ms.forEach(function(m){if(m.ts>agentSince)agentSince=m.ts;
  AGENTLOG.push(m);if(AGENTLOG.length>500)AGENTLOG.shift();
  // Auto-add a chat thread for any agent that produces messages; announce its start once in Main.
  [m.from,m.to].forEach(function(nm){if(nm&&nm!=='user'&&nm!=='assistant'&&AGENTS.some(function(a){return a.name===nm})&&!threads.some(function(t){return t.id==='agent:'+nm})){threads.push({id:'agent:'+nm,label:'\\uD83E\\uDD16 '+nm,agent:nm});saveThreads();renderThreads();announceAgentInMain(nm)}});
  var lbl='\\uD83E\\uDD16 '+m.from+' \\u2192 '+m.to;
  // The agent's full output lives in ITS OWN chat (live-append when open); Main is NOT flooded.
  if(isAgentCid(cid)&&(m.from===agentNameOf(cid)||m.to===agentNameOf(cid))){add('bot',lbl,m.text)}
})}).catch(function(){})}
// One-time notice in the Main chat: "<agent> started" as a clickable link that opens its chat.
function announceAgentInMain(name){if(cid!=='main'||!mirrorOn())return;var note=add('bot','\\uD83E\\uDD16 '+name,name+' started \\u2014 click to open its chat.');if(note){note.style.cursor='pointer';note.style.textDecoration='underline';note.title='Open '+name+' chat';note.onclick=function(){openAgentChat(name);renderThreads()}}}
setInterval(pollAgentMsgs,4000);
function loadMemory(){fetch('/api/settings',{headers:hdrs()}).then(function(r){if(r.status===401)return null;return r.json()}).then(function(s){
    if(!s||!s.identity){el('memview').textContent='(memory unavailable)';return}
    var id=s.identity,mu=id.memoryUsage,h='';
    if(id.laws&&id.laws.trim()){h+='<div class="sec">⚖ Safety laws (LAWS.md - inviolable)</div><div style="white-space:pre-wrap;font-size:12px;color:var(--mut)">'+esc(id.laws)+'</div>'}
    if(id.user&&id.user.replace(/^#.*$/m,'').trim()){h+='<div class="sec">Your profile (USER.md - agent-maintained)</div><div style="white-space:pre-wrap;font-size:13px">'+esc(id.user)+'</div>'}
    h+='<div class="sec">Memory ('+mu.pct+'% of '+mu.max+' chars)</div>';
    h+=id.memory.length?('<div style="white-space:pre-wrap;font-size:13px">'+esc(id.memory.map(function(e){return '- '+e}).join('\\n'))+'</div>'):'<div style="color:var(--mut)">(empty - it fills in as you talk)</div>';
    if(id.learnings){var lu=id.learningsUsage||{pct:0,max:0};h+='<div class="sec">Learned facts ('+lu.pct+'% of '+lu.max+' chars - taught by the smart model on escalation)</div>';
      h+=id.learnings.length?('<div style="white-space:pre-wrap;font-size:13px">'+esc(id.learnings.map(function(e){return '- '+e}).join('\\n'))+'</div>'):'<div style="color:var(--mut)">(none yet - fills when the smart model rescues an escalation)</div>'}
    h+='<div id="bansec"></div>';
    el('memview').innerHTML=h;renderBans()})}
function renderBans(){var box=el('bansec');if(!box)return;fetch('/api/bans',{headers:hdrs()}).then(function(r){return r.ok?r.json():null}).then(function(d){if(!d){box.innerHTML='';return}CAPS=d.capabilities||CAPS;BANMODELS=d.models||BANMODELS;
  var h='<div class="sec">Skill bans (model \\u2014 skill)</div>';
  h+='<div style="font-size:12px;color:var(--mut);margin-bottom:6px">A banned model refuses that skill and routing prefers a non-banned model. The smartest model can never be banned. Added automatically when you escalate after the local model used a skill.</div>';
  if(d.bans&&d.bans.length){h+=d.bans.map(function(b){return '<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--line)"><b class="accent" style="min-width:84px">'+esc(b.model)+'</b><span style="flex:1">'+esc(b.skill)+'</span><button class="banx" data-m="'+esc(b.model)+'" data-s="'+esc(b.skill)+'" style="font-size:12px;padding:2px 8px">Unban</button></div>'}).join('')}
  else{h+='<div style="color:var(--mut)">(no bans)</div>'}
  h+='<div style="display:flex;gap:6px;margin-top:8px"><input id="ban_skill" list="ban_caps" placeholder="skill or tool" style="flex:1"><select id="ban_model" style="width:130px"></select><button id="ban_add" style="font-size:12px">Ban</button></div>';
  h+='<datalist id="ban_caps">'+(CAPS||[]).map(function(c){return '<option value="'+esc(c)+'"></option>'}).join('')+'</datalist>';
  box.innerHTML=h;
  var ms=el('ban_model');if(ms)ms.innerHTML=(BANMODELS||[]).map(function(m){return '<option value="'+esc(m)+'">'+esc(m)+'</option>'}).join('');
  [].slice.call(box.querySelectorAll('.banx')).forEach(function(x){x.onclick=function(){postBan('remove',x.getAttribute('data-m'),x.getAttribute('data-s'))}});
  var ba=el('ban_add');if(ba)ba.onclick=function(){var sk=(el('ban_skill').value||'').trim();var md=(el('ban_model').value||'').trim();if(!sk||!md){return}postBan('add',md,sk)}})}
function postBan(action,model,skill){fetch('/api/bans',{method:'POST',headers:hdrs(),body:JSON.stringify({action:action,model:model,skill:skill})}).then(function(r){return r.json()}).then(function(d){if(d&&d.ok===false&&d.reason)showToast(d.reason);renderBans()}).catch(function(){})}
['panelbody','provview'].forEach(function(id){var e=el(id);if(e)e.addEventListener('input',function(){panelDirty=true})});
renderThreads();openWs();fetchTabs();setInterval(fetchTabs,6000);loadRail();setInterval(loadRail,60000);loadBanVocab();
</script></body></html>`;
