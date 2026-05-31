#!/usr/bin/env node
// Zamolxis command-line interface.
//   zamolxis run                 run in the foreground (web UI + channels from .env; Ctrl+C to stop)
//   zamolxis start               start in the background (detached; survives closing the terminal)
//   zamolxis stop                stop the background instance
//   zamolxis restart             restart the background instance
//   zamolxis status              is it running?
//   zamolxis web                 foreground, web UI only
//   zamolxis cli                 foreground, interactive CLI only
//   zamolxis doctor              readiness check
// Any extra args are passed through to the daemon, e.g.  zamolxis run --channels=telegram,web
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'dist', 'index.js');
const dataDir = process.env.ZAMOLXIS_DATA_DIR || path.join(os.homedir(), '.zamolxis');
const pidFile = path.join(dataDir, 'zamolxis.pid');
const logDir = path.join(dataDir, 'logs');
const logFile = path.join(logDir, 'zamolxis.log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}
function readPid() {
  try {
    return parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10) || 0;
  } catch {
    return 0;
  }
}
function ensureBuilt() {
  if (!fs.existsSync(entry)) {
    console.error(`Build missing: ${entry}\nRun:  npm run build`);
    process.exit(1);
  }
}
// The web port (from .env / env / default) — used to free the port reliably on stop/restart.
function webPort() {
  try {
    const m = /^\s*ZAMOLXIS_WEB_PORT=(\d+)/m.exec(fs.readFileSync(path.join(root, '.env'), 'utf8'));
    if (m) return parseInt(m[1], 10);
  } catch {}
  return parseInt(process.env.ZAMOLXIS_WEB_PORT || '8787', 10);
}
// PIDs currently LISTENING on a TCP port (cross-platform).
function pidsOnPort(port) {
  const pids = new Set();
  try {
    if (process.platform === 'win32') {
      const out = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' }).stdout || '';
      for (const line of out.split('\n')) {
        if (!/LISTENING/.test(line)) continue;
        if (!new RegExp(`[:.]${port}\\b`).test(line.split(/\s+/).filter(Boolean)[1] || '')) continue;
        const m = line.trim().match(/(\d+)\s*$/);
        if (m) pids.add(parseInt(m[1], 10));
      }
    } else {
      const out = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout || '';
      for (const l of out.split('\n')) { const n = parseInt(l.trim(), 10); if (n) pids.add(n); }
    }
  } catch {}
  return [...pids];
}
// Force-kill a process (and its child tree on Windows).
function killHard(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
  } catch {}
}
// Free the web port: kill any LISTENER on it that isn't us.
function freePort(port) {
  for (const p of pidsOnPort(port)) if (p !== process.pid) killHard(p);
}

function runForeground(extra) {
  ensureBuilt();
  const child = spawn(process.execPath, ['--enable-source-maps', entry, ...extra], { cwd: root, stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
}

function start(extra) {
  const port = webPort();
  const existing = readPid();
  // Only treat it as "already running" if the tracked pid is actually the one serving the port.
  if (alive(existing) && pidsOnPort(port).includes(existing)) {
    console.log(`Zamolxis is already running (pid ${existing}).`);
    return;
  }
  // Clear any stale/zombie instance still holding the port so the new process can bind.
  freePort(port);
  ensureBuilt();
  fs.mkdirSync(logDir, { recursive: true });
  const out = fs.openSync(logFile, 'a');
  const args = ['--enable-source-maps', entry, ...(extra.length ? extra : ['--web'])];
  const child = spawn(process.execPath, args, {
    cwd: root,
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
    env: { ...process.env, NODE_ENV: 'production' },
  });
  fs.writeFileSync(pidFile, String(child.pid));
  child.unref();
  console.log(`Zamolxis started (pid ${child.pid}).\n  logs: ${logFile}`);
}

async function stop() {
  const pid = readPid();
  const port = webPort();
  if (pid && alive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
    for (let i = 0; i < 15 && alive(pid); i++) await sleep(200);
    if (alive(pid)) killHard(pid); // SIGTERM ignored / Windows — force-kill the tree
  }
  // Also free the web port: catches a zombie/untracked instance the pidfile doesn't know about
  // (this was the bug behind "restart didn't take effect" — old process kept the port).
  freePort(port);
  for (let i = 0; i < 15 && pidsOnPort(port).some((p) => p !== process.pid); i++) await sleep(200);
  try {
    fs.unlinkSync(pidFile);
  } catch {}
  const stuck = pidsOnPort(port).filter((p) => p !== process.pid);
  if (stuck.length) console.log(`Zamolxis stopped, but port ${port} is STILL held by pid(s) ${stuck.join(', ')} — kill manually.`);
  else console.log(`Zamolxis stopped${pid ? ` (pid ${pid})` : ''}; port ${port} free.`);
}

function status() {
  const pid = readPid();
  if (alive(pid)) console.log(`Zamolxis is RUNNING (pid ${pid}).\n  logs: ${logFile}`);
  else console.log('Zamolxis is STOPPED.');
}

function askYN(rl, q) {
  return new Promise((res) => rl.question(`${q} [y/N] `, (a) => res(/^y(es)?$/i.test(a.trim()))));
}
async function packCmd() {
  ensureBuilt();
  const { packSetup } = await import(path.join(root, 'dist', 'core', 'pack.js'));
  const skillsDir = path.join(dataDir, 'skills');
  const flags = new Set(extra.map((a) => a.toLowerCase()));
  const explicit = ['--soul', '--user', '--teachings', '--all', '--skills-only'].some((f) => flags.has(f));
  let soul = flags.has('--soul') || flags.has('--all');
  let user = flags.has('--user') || flags.has('--all');
  let teach = flags.has('--teachings') || flags.has('--all');
  if (!explicit) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log('Packing ALL skills. Also include in the pack (for seeding a new install)?');
    soul = await askYN(rl, '  - persona (SOUL.md)?');
    user = await askYN(rl, '  - your profile (USER.md)?');
    teach = await askYN(rl, '  - learned facts / teachings (LEARNINGS.md)?');
    rl.close();
  }
  const rd = (f) => {
    try {
      return fs.readFileSync(path.join(dataDir, f), 'utf8');
    } catch {
      return '';
    }
  };
  const parts = {};
  if (soul) parts.soul = rd('SOUL.md');
  if (user) parts.user = rd('USER.md');
  if (teach) parts.learnings = rd('LEARNINGS.md');
  const r = packSetup(skillsDir, path.join(dataDir, 'exports'), parts, new Date().toISOString());
  console.log(`\nPacked ${r.included.join(' + ')}\n  -> ${r.path}\n\nOn the new machine:  zamolxis unpack "${r.path}"`);
}
async function unpackCmd(file) {
  if (!file) {
    console.error('Usage: zamolxis unpack <pack-file.json>');
    process.exit(1);
  }
  ensureBuilt();
  const { unpackSetup } = await import(path.join(root, 'dist', 'core', 'pack.js'));
  fs.mkdirSync(dataDir, { recursive: true });
  const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
  const r = unpackSetup(path.join(dataDir, 'skills'), dataDir, bundle);
  console.log(`Applied ${r.applied.join(' + ')} into ${dataDir}`);
}

function usage() {
  console.log(`Zamolxis - self-hosted agent on your Claude subscription

Usage: zamolxis <command> [extra daemon args]

  run        run in the foreground (web UI + channels; Ctrl+C to stop)
  start      start in the background (detached, survives terminal close)
  stop       stop the background instance
  restart    restart the background instance
  status     show whether it is running
  web        foreground, web UI only
  cli        foreground, interactive CLI only
  doctor     readiness check (auth, build, channels, sandbox)
  pack       bundle this setup (all skills; asks about SOUL/USER/teachings) for a new install
  unpack     apply a pack file into this install:  zamolxis unpack <file.json>

Examples:
  zamolxis start
  zamolxis run --channels=telegram,web
  zamolxis stop`);
}

const cmd = process.argv[2];
const extra = process.argv.slice(3);
switch (cmd) {
  case 'run':
    runForeground(extra.length ? extra : ['--web']);
    break;
  case 'web':
    runForeground(['--web', ...extra]);
    break;
  case 'cli':
    runForeground(['--channels=cli', ...extra]);
    break;
  case 'doctor':
    runForeground(['--doctor']);
    break;
  case 'start':
    start(extra);
    break;
  case 'stop':
    await stop();
    break;
  case 'restart':
    await stop();
    await sleep(600);
    start(extra);
    break;
  case 'status':
    status();
    break;
  case 'pack':
    await packCmd();
    break;
  case 'unpack':
    await unpackCmd(extra[0]);
    break;
  default:
    usage();
    if (cmd && cmd !== 'help' && cmd !== '--help' && cmd !== '-h') process.exit(1);
}
