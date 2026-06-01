import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
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
import { packSetup, type PackParts } from '../core/pack.js';
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
type UpdateState = { isRepo: boolean; behind: number; local: string; remote: string; branch: string; checkedAt: number };
let UPDATE: UpdateState = { isRepo: false, behind: 0, local: '', remote: '', branch: '', checkedAt: 0 };
let UPDATE_CHECKING = false;
async function refreshUpdate(): Promise<void> {
  if (UPDATE_CHECKING) return;
  UPDATE_CHECKING = true;
  const git = (args: string[], timeout = 8000) => pexec('git', args, { cwd: REPO_ROOT, timeout, windowsHide: true });
  try {
    await git(['rev-parse', '--is-inside-work-tree']);
    const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    try {
      await git(['fetch', '--quiet', 'origin'], 30000);
    } catch {
      /* offline or no remote: fall back to whatever refs we already have */
    }
    const local = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    let remote = '';
    let behind = 0;
    try {
      remote = (await git(['rev-parse', '@{u}'])).stdout.trim();
      behind = parseInt((await git(['rev-list', '--count', 'HEAD..@{u}'])).stdout.trim(), 10) || 0;
    } catch {
      /* current branch has no upstream configured */
    }
    UPDATE = { isRepo: true, behind, local: local.slice(0, 7), remote: remote.slice(0, 7), branch, checkedAt: Date.now() };
  } catch {
    UPDATE = { isRepo: false, behind: 0, local: '', remote: '', branch: '', checkedAt: Date.now() };
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
export class WebChannel implements Channel {
  readonly name = 'web';
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
        auth: exp
          ? { found: true, expiresAt: exp.expiresAt.getTime(), expired: exp.expired }
          : { found: false, expiresAt: null, expired: false },
        models: {
          primary: this.config.model || 'default',
          fast: this.config.fastModel || null,
          local: this.config.localModel?.model || null,
        },
        build: buildInfo(),
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
            found: Boolean(exp),
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
body{margin:0;font:15px/1.55 system-ui,Segoe UI,Roboto,sans-serif;color:var(--ink);height:100vh;display:flex;flex-direction:column;
  background:radial-gradient(1200px 700px at 50% -10%,#1a150d 0%,var(--bg) 60%) fixed;}
::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-thumb{background:#2c261c;border-radius:6px}::-webkit-scrollbar-thumb:hover{background:#3a3225}
header{display:flex;align-items:center;gap:10px;padding:11px 18px;border-bottom:1px solid var(--line);background:linear-gradient(#1a150d,#120f0a);flex-wrap:wrap}
#models{display:flex;gap:6px;align-items:center;font-size:11px;color:var(--mut);flex-wrap:wrap}
.mchip{padding:1px 7px;border:1px solid var(--line);border-radius:999px;color:var(--mut)}
.mchip.used{color:#1a150d;background:linear-gradient(135deg,var(--accent),#dcb964);border-color:var(--accent);font-weight:700}
#models .tok{color:var(--accent);font-variant-numeric:tabular-nums}
#emblem{width:26px;height:26px;flex:none;filter:drop-shadow(0 0 6px #cda34966)}
#brand{font-family:Georgia,'Times New Roman',serif;font-weight:700;letter-spacing:3px;font-size:18px;color:var(--accent);text-transform:uppercase}
#clock{margin-left:auto;font-variant-numeric:tabular-nums;font-size:12px;color:var(--mut);white-space:nowrap}
#auth{font-size:11px;padding:2px 9px;border-radius:999px;border:1px solid var(--line);color:var(--mut);cursor:default;white-space:nowrap}
#auth.ok{color:#7dd08a;border-color:#2f5a35}
#auth.warn{color:#e0a55f;border-color:#5a4326}
#auth.bad{color:#e88;border-color:#a44}
#build{font-size:11px;padding:2px 9px;border-radius:999px;border:1px solid #a44;color:#e88;white-space:nowrap;cursor:default}
#status{font-size:12px;color:var(--mut)}
button{background:var(--panel2);color:var(--ink);border:1px solid var(--line);border-radius:9px;padding:7px 12px;cursor:pointer;font:inherit;font-size:13px;transition:.15s}
button:hover{border-color:var(--accent);color:var(--accent)}
#tabbar{display:flex;gap:6px;align-items:center;padding:8px 18px;border-bottom:1px solid var(--line);background:#120f0a;overflow-x:auto}
.tab{padding:6px 14px;border-radius:999px;border:1px solid var(--line);background:transparent;color:var(--mut);cursor:pointer;font-size:13px;white-space:nowrap}
.tab:hover{color:var(--ink)}
.tab.active{color:#1a150d;background:linear-gradient(135deg,var(--accent),#dcb964);border-color:var(--accent);font-weight:600}
#main{flex:1;display:flex;overflow:hidden}
#provrail{width:158px;flex:none;border-right:1px solid var(--line);overflow:auto;padding:10px 8px;background:#120f0a}
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
/* Chats panel is an in-flow left column inside #maininner: opening it PUSHES the chat
   (and its message field) to the right instead of overlaying — never covers header, the
   providers rail, or the input. Animates width; content is a fixed-width inner so it
   doesn't reflow during the slide. */
#threadpanel{flex:none;width:0;height:100%;overflow:hidden;transition:width .2s;background:var(--panel)}
#threadpanel.open{width:290px;border-right:1px solid var(--line)}
#threadbody{width:290px;height:100%;overflow:auto;padding:18px;box-sizing:border-box}
#panel{right:0;width:420px;border-left:1px solid var(--line);transform:translateX(100%)}
#mempanel{right:0;width:420px;border-left:1px solid var(--line);transform:translateX(100%);z-index:16}
#skillpanel{right:0;width:460px;border-left:1px solid var(--line);transform:translateX(100%);z-index:16}
#provpanel{right:0;width:460px;border-left:1px solid var(--line);transform:translateX(100%);z-index:16}
#panel.open,#mempanel.open,#skillpanel.open,#provpanel.open{transform:none}
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
<header><svg id="emblem" viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="eg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e8c87a"/><stop offset="1" stop-color="#b8893f"/></linearGradient></defs><path d="M32 3 58 18 V46 L32 61 6 46 V18 Z" fill="#1a150d" stroke="url(#eg)" stroke-width="3" stroke-linejoin="round"/><path d="M22 22 H42 L24 40 H43" fill="none" stroke="url(#eg)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg><b id="brand">__AGENT_NAME__</b>
  <span id="models"></span>
  <span id="clock"></span><span id="build" title="" style="display:none"></span><span id="auth" title="">login ...</span><span id="status">connecting...</span>
  <button id="chats">Chats</button><button id="skillsbtn">Skills</button><button id="provbtn">Providers</button><button id="mem">Memory</button><button id="cog">Settings</button></header>
<div id="tabbar"></div>
<div id="main">
  <aside id="provrail"></aside>
  <div id="maininner">
  <div id="threadpanel"><div id="threadbody"><h3 style="margin-top:0">Chats</h3><button id="newchat" style="width:100%;margin-bottom:10px">+ New chat</button><div id="threadlist"></div></div></div>
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
function railItem(d,tok){var label=tok,color=C_OFF,title=tok;
  if(tok==='local'){label='Local';color=d.localModel?C_OK:C_OFF;title=d.localModel||'no on-device model'}
  else if(tok==='claude'){label='Claude';var c=d.claude||{};color=c.found?(c.expired?C_BAD:C_OK):C_WARN;title='subscription'}
  else if(tok==='freecloud'){label='Free cloud';var any=(d.providers||[]).some(function(p){return p.kind==='free'&&freeReady(p)});color=any?C_OK:C_BAD;title='rotates free providers'}
  else{var pp=(d.providers||[]).filter(function(p){return p.id===tok})[0];if(pp){label=pp.label;var lim=pp.freeDaily&&pp.used>=pp.freeDaily;color=!pp.configured?C_OFF:(lim?C_BAD:C_OK);title=pp.kind}}
  var used=tokMatch(tok,d);
  return '<div title="'+esc(title)+'" style="display:flex;align-items:center;gap:7px;padding:6px 7px;border-radius:7px;margin-bottom:4px;'+(used?'background:rgba(212,165,90,.14);border:1px solid var(--accent)':'border:1px solid transparent')+'">'+dotHtml(color,title)+'<span style="flex:1;color:'+color+';overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(label)+'</span>'+(used?'<span style="color:var(--accent);font-size:10px">last</span>':'')+'</div>'}
function renderRail(){var box=el('provrail');if(!box)return;var d=RAIL;if(!d){box.innerHTML='';return}
  var chain=d.routeChain||[];
  var h='<div style="color:var(--mut);text-transform:uppercase;font-size:10px;letter-spacing:.5px;margin:2px 4px 8px">Active chain</div>';
  if(!chain.length)h+='<div style="color:var(--mut);padding:4px 7px">none</div>';
  chain.forEach(function(tok){
    if(tok==='freecloud'){
      var fps=(d.providers||[]).filter(function(p){return p.kind==='free'&&p.configured});
      if(fps.length)fps.forEach(function(p){h+=railItem(d,p.id)});
      else h+=railItem(d,'freecloud'); // none configured yet — show placeholder so it's actionable
    } else h+=railItem(d,tok);
  });
  h+='<div id="raillink" style="color:var(--mut);font-size:10px;margin:9px 4px 4px;cursor:pointer">edit in Providers &#8594;</div>';
  box.innerHTML=h;var lk=el('raillink');if(lk)lk.onclick=function(){el('provbtn').click()}}
function loadRail(){fetch('/api/providers',{headers:hdrs()}).then(function(r){return r.ok?r.json():null}).then(function(d){if(d){RAIL=d;renderRail();rebuildRouteSelect();if(LASTD)renderModels(LASTD)}}).catch(function(){})}
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
if(!threads.length){threads=[{id:(localStorage.zx_cid||uuid()),label:'Chat 1'}]}
var cid=localStorage.zx_thread||threads[0].id;
if(!threads.some(function(t){return t.id===cid})){cid=threads[0].id}
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
  else{var s=w.dataset.secs,tok=w.dataset.tok,via=w.dataset.via;var x=BOT_LABEL+(t?' · '+t:'');if(s)x+=' · '+s+'s';if(tok)x+=' · '+tok+' tok';if(via)x+=' · via '+via;w.textContent=x}}
/* Human label for the model that produced an answer (from usage.last.model). */
function viaLabel(id){if(!id)return '';id=String(id);
  var m=id.match(/^(?:free|paid):([^:]+):/);if(m){var pp=(RAIL&&RAIL.providers||[]).filter(function(p){return p.id===m[1]})[0];return pp?pp.label:m[1]}
  if(id.indexOf('local:')===0)return 'Local';
  if(/claude|opus|sonnet|haiku/i.test(id))return 'Claude '+shortModel(id);
  return shortModel(id)}
function add(cls,who,text){var w=document.createElement('div');w.className='who';w.dataset.role=(cls==='user'?'you':'bot');w.dataset.ts=String(Date.now());renderWho(w);var m=document.createElement('div');m.className='msg '+cls;m.textContent=text;el('loginner').appendChild(w);el('loginner').appendChild(m);el('log').scrollTop=el('log').scrollHeight;m.whoEl=w;return m}
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
      fetch('/api/status',{headers:hdrs()}).then(function(r){return r.ok?r.json():null}).then(function(d){if(!d)return;renderModels(d);if(d.last&&w)setMeta(w,secs,d.last.total,viaLabel(d.last.model))}).catch(function(){})}
    else if(m.type==='status'){setStatus(m.text)}};
}
var routes={};try{routes=JSON.parse(localStorage.zx_routes||'{}')}catch(e){}
function curRoute(){return routes[cid]||'auto'}
function applyRoute(){var r=el('route');if(r)r.value=curRoute();updateModelVis()}
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
function loadThread(id){cid=id;saveThreads();applyRoute();applyModel();el('loginner').innerHTML='';cur=null;curStarted=false;var old=ws;openWs();if(old){try{old.close()}catch(e){}}renderThreads()}
function renderThreads(){var h='';threads.forEach(function(t){h+='<div class="thread'+(t.id===cid?' cur':'')+'" data-id="'+t.id+'"><span class="lbl">'+esc(t.label)+'</span><span class="del" data-del="'+t.id+'">delete</span></div>'});el('threadlist').innerHTML=h;
  Array.prototype.forEach.call(el('threadlist').querySelectorAll('.thread'),function(n){n.onclick=function(e){if(e.target.getAttribute('data-del'))return;loadThread(n.getAttribute('data-id'));el('threadpanel').classList.remove('open')}});
  Array.prototype.forEach.call(el('threadlist').querySelectorAll('[data-del]'),function(n){n.onclick=function(e){e.stopPropagation();deleteThread(n.getAttribute('data-del'))}})}
function newChat(){var id=uuid();threads.unshift({id:id,label:'New chat'});loadThread(id);el('threadpanel').classList.remove('open');switchView('chat')}
function deleteThread(id){fetch('/api/forget',{method:'POST',headers:hdrs(),body:JSON.stringify({cid:id})}).catch(function(){});
  threads=threads.filter(function(t){return t.id!==id});if(!threads.length){threads=[{id:uuid(),label:'Chat 1'}]}if(id===cid){loadThread(threads[0].id)}else{saveThreads();renderThreads()}}
var inHist=[];try{inHist=JSON.parse(localStorage.zx_inhist||'[]')}catch(e){}
var histPos=-1,histDraft='';
function pushHist(t){if(!t)return;if(inHist[inHist.length-1]!==t){inHist.push(t);if(inHist.length>100)inHist.shift();try{localStorage.zx_inhist=JSON.stringify(inHist)}catch(e){}}histPos=-1;histDraft=''}
var pending=[];var MAXUP=20*1024*1024;
function renameThreadFrom(t){if(!t)return;var th=threads.filter(function(x){return x.id===cid})[0];if(th&&(th.label==='New chat'||th.label==='Chat 1')){th.label=t.slice(0,32);saveThreads();renderThreads()}}
function sendMsg(){var t=el('in').value.trim();var files=pending.slice();if(!t&&!files.length)return;if(!ws||ws.readyState!==1){setStatus('not connected');return}
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
el('in').addEventListener('keydown',function(e){var n=el('in');
  if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMsg();return}
  // Shell-style history: Up at the very start of the field, Down at the very end.
  if(e.key==='ArrowUp'&&n.selectionStart===0&&n.selectionEnd===0&&inHist.length){
    if(histPos===-1){histDraft=n.value;histPos=inHist.length}
    if(histPos>0){histPos--;n.value=inHist[histPos];e.preventDefault();setTimeout(function(){n.selectionStart=n.selectionEnd=0},0)}
  } else if(e.key==='ArrowDown'&&n.selectionStart===n.value.length&&n.selectionEnd===n.value.length&&histPos!==-1){
    if(histPos<inHist.length-1){histPos++;n.value=inHist[histPos]}else{histPos=-1;n.value=histDraft}
    e.preventDefault();
  }});
el('chats').onclick=function(){renderThreads();el('threadpanel').classList.toggle('open')};
el('newchat').onclick=newChat;
el('cog').onclick=function(){el('panel').classList.add('open');loadSettings()};
el('close').onclick=function(){el('panel').classList.remove('open')};
el('mem').onclick=function(){loadMemory();el('mempanel').classList.add('open')};
el('memclose').onclick=function(){el('mempanel').classList.remove('open')};
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
el('skillsbtn').onclick=function(){loadSkills();el('skillpanel').classList.add('open')};
el('skillclose').onclick=function(){el('skillpanel').classList.remove('open')};
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
  h+=pcard('<div style="display:flex;gap:8px;align-items:center">'+dotHtml(clColor,clText)+'<b style="flex:1;color:'+clColor+'">Claude - your Pro/Max subscription</b>'+(single?'<span style="color:'+clColor+';font-size:12px">'+clText+'</span>':'')+'<span style="font-size:11px;color:var(--mut)">token: claude</span></div><div style="font-size:12px;color:var(--mut);margin-top:3px">Runs via Claude Code (<code>claude login</code>) on your subscription - no API key, flat rate. Models: '+esc(cl.primary||'')+' · fast '+esc(cl.fast||'')+' · smart '+esc(cl.smart||'')+' (change in Settings &#8594; Engine).</div>');
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
function saveProviders(){var creds={};Array.prototype.forEach.call(document.querySelectorAll('[id^="prov_"]'),function(n){if(n.id==='prov_chain')return;if(n.value&&n.value!==KEYMASK)creds[n.id.slice(5)]=n.value});
  fetch('/api/settings',{method:'POST',headers:hdrs(),body:JSON.stringify({live:{routeChain:el('prov_chain').value},credentials:creds})}).then(function(r){return r.json()}).then(function(s){
    if(s&&s.restartRequired){awaitingReload=true;el('provpanel').classList.remove('open');showToast('Saved. Applying and reconnecting...')}else{showToast('Saved.');loadProviders();loadRail();setTimeout(hideToast,2000)}}).catch(function(){})}
el('provbtn').onclick=function(){loadProviders();el('provpanel').classList.add('open')};
el('provclose').onclick=function(){el('provpanel').classList.remove('open')};
el('provsave').onclick=saveProviders;
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
  h+=sec('Engine (applies on next message)');
  h+='<label>Agent name (shown everywhere)</label>'+inp('live_agentName',L.agentName);
  h+='<label>Model</label>'+sel('live_model',m.models,L.model);
  h+='<label>Fast model (auto-used for simple Claude turns; primary model handles complex ones)</label>'+sel('live_fastModel',m.models,L.fastModel);
  h+='<label>Smartest model (used when a local-model turn escalates because it could not cope)</label>'+sel('live_smartModel',m.models,L.smartModel);
  h+='<div style="font-size:11px;color:var(--mut);margin-top:2px">These three are the <b>Claude</b> tier\\'s models. On-device and free/paid providers each have their own fixed model — manage which ones run, and in what order, in the <b class="accent">Providers</b> panel.</div>';
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
  var unb=el('uninstallbtn');if(unb)unb.onclick=doUninstall;
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
  var v=function(id){var n=el('s_'+id);return n?n.value:undefined};
  var ck=function(id){var n=el('s_'+id);return n?n.checked:undefined};
  var patch={live:{agentName:v('live_agentName'),model:v('live_model'),fastModel:v('live_fastModel'),smartModel:v('live_smartModel'),localRouting:v('live_localRouting'),lawsEnabled:ck('live_lawsEnabled'),permissionMode:v('live_permissionMode'),sandboxBackend:v('live_sandboxBackend'),systemPromptAppend:v('live_systemPromptAppend'),maxTurns:Number(v('live_maxTurns')),maxConcurrent:Number(v('live_maxConcurrent'))},
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
  if(d.tempUntil){var ms=d.tempUntil-Date.now();if(ms>0&&ms<3600000)setTimeout(fetchStatus,ms+800)}
  if(d.build&&d.build.started)buildStarted=d.build.started;
  var b=el('build');if(b){var up=d.update;
    if(up&&up.isRepo&&up.behind>0){b.style.display='';b.textContent='⬆ update available ('+up.behind+' new) - click to update';b.title='A newer version is on GitHub (origin/'+esc(up.branch||'main')+', '+esc(up.remote||'')+'). Click to pull, reinstall, rebuild and restart.';b.style.cursor='pointer';b.style.textDecoration='underline';b.onclick=doUpdate}
    else if(d.build&&d.build.stale){b.style.display='';b.textContent='⟳ outdated build - click to restart';b.title='The running process predates the latest build. Click to restart Zamolxis and load it.';b.style.cursor='pointer';b.style.textDecoration='underline';b.onclick=doRestart}
    else{b.style.display='none';b.onclick=null}}
  var a=el('auth');if(!a)return;var au=d.auth||{};
  if(!au.found){a.className='warn';a.textContent='login: unknown';a.title='Could not read the Claude credentials file (it may be in an OS keychain).'}
  else if(au.expired){a.className='bad';a.textContent='login expired';a.title='Subscription login expired. On the host run: claude login  then restart Zamolxis.'}
  else{a.className='ok';a.textContent='login ok';var t=new Date(au.expiresAt);
    a.title='Subscription login is valid. The short-lived access token renews automatically (~'+t.toLocaleTimeString()+'); you only need to run claude login again if this shows expired.'}
}).catch(function(){})}
setInterval(tickClock,1000);fetchStatus();setInterval(fetchStatus,30000);
function loadMemory(){fetch('/api/settings',{headers:hdrs()}).then(function(r){if(r.status===401)return null;return r.json()}).then(function(s){
    if(!s||!s.identity){el('memview').textContent='(memory unavailable)';return}
    var id=s.identity,mu=id.memoryUsage,h='';
    if(id.laws&&id.laws.trim()){h+='<div class="sec">⚖ Safety laws (LAWS.md - inviolable)</div><div style="white-space:pre-wrap;font-size:12px;color:var(--mut)">'+esc(id.laws)+'</div>'}
    if(id.user&&id.user.replace(/^#.*$/m,'').trim()){h+='<div class="sec">Your profile (USER.md - agent-maintained)</div><div style="white-space:pre-wrap;font-size:13px">'+esc(id.user)+'</div>'}
    h+='<div class="sec">Memory ('+mu.pct+'% of '+mu.max+' chars)</div>';
    h+=id.memory.length?('<div style="white-space:pre-wrap;font-size:13px">'+esc(id.memory.map(function(e){return '- '+e}).join('\\n'))+'</div>'):'<div style="color:var(--mut)">(empty - it fills in as you talk)</div>';
    if(id.learnings){var lu=id.learningsUsage||{pct:0,max:0};h+='<div class="sec">Learned facts ('+lu.pct+'% of '+lu.max+' chars - taught by the smart model on escalation)</div>';
      h+=id.learnings.length?('<div style="white-space:pre-wrap;font-size:13px">'+esc(id.learnings.map(function(e){return '- '+e}).join('\\n'))+'</div>'):'<div style="color:var(--mut)">(none yet - fills when the smart model rescues an escalation)</div>'}
    el('memview').innerHTML=h})}
renderThreads();openWs();fetchTabs();setInterval(fetchTabs,6000);loadRail();setInterval(loadRail,60000);
</script></body></html>`;
