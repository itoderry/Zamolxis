#!/usr/bin/env node
// Zamolxis command-line interface.
//   zamolxis run                 run in the foreground (web UI + channels from .env; Ctrl+C to stop)
//   zamolxis start               start in the background (detached; survives closing the terminal)
//   zamolxis stop                stop the background instance
//   zamolxis restart             restart the background instance
//   zamolxis update              git pull + reinstall + rebuild + restart (git installs only)
//   zamolxis status              is it running?
//   zamolxis web                 foreground, web UI only
//   zamolxis cli                 foreground, interactive CLI only
//   zamolxis doctor              readiness check
//   zamolxis uninstall           stop + remove service + unlink command (--purge also deletes data)
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

// What did the installer add? It writes <dataDir>/install-manifest.json recording ONLY the
// things it installed (vs what was already on the machine), so uninstall reverses exactly that.
function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'install-manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}
function run(cmd, args) {
  try {
    return spawnSync(cmd, args, { stdio: 'inherit', windowsHide: true, shell: process.platform === 'win32' }).status === 0;
  } catch {
    return false;
  }
}
// Uninstall: stop the daemon, remove the auto-start service + global command, and reverse the
// prerequisites the INSTALLER added (per the manifest) - model, Ollama, Claude Code, Node, git -
// while leaving anything that was already on the machine. --purge also deletes the data dir.
// The program folder is left for the user to delete (a process can't reliably delete its own dir).
async function uninstallCmd() {
  const flags = new Set(extra.map((a) => a.toLowerCase()));
  const purge = flags.has('--purge') || flags.has('--data') || flags.has('--all');
  const assumeYes = flags.has('--yes') || flags.has('-y');
  const mf = readManifest();
  const inst = (mf && mf.installed) || {};
  const have = (k) => Boolean(inst[k]);

  if (!assumeYes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log('Uninstall will STOP Zamolxis and remove what the installer added:');
    console.log('  - auto-start service (if any) and the global `zamolxis` command');
    if (have('model')) console.log(`  - local model: ${inst.model}`);
    if (have('ollama')) console.log('  - Ollama');
    if (have('claudeCode')) console.log('  - Claude Code CLI');
    if (have('node')) console.log('  - Node.js');
    if (have('git')) console.log('  - git');
    if (!mf) console.log('  (no install manifest found - only the service + global command are treated as ours; Node/git/Ollama left in place)');
    if (purge) console.log(`It will ALSO PERMANENTLY DELETE your data (skills, memory, learned facts, .env secrets):\n  ${dataDir}`);
    else console.log(`Your data dir is KEPT:\n  ${dataDir}`);
    const ok = await askYN(rl, purge ? 'Proceed and DELETE ALL DATA?' : 'Proceed?');
    rl.close();
    if (!ok) {
      console.log('Uninstall cancelled.');
      return;
    }
  }

  await stop();

  // Auto-start service.
  if (process.platform === 'win32') {
    try {
      spawnSync('powershell', ['-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'service-uninstall.ps1')], { stdio: 'inherit' });
    } catch {}
  } else if (have('service')) {
    try {
      spawnSync('systemctl', ['--user', 'disable', '--now', 'zamolxis'], { stdio: 'ignore' });
    } catch {}
  }
  try {
    spawnSync(process.platform === 'win32' ? 'pm2.cmd' : 'pm2', ['delete', 'zamolxis'], { stdio: 'ignore', shell: process.platform === 'win32' });
  } catch {}

  // Global `zamolxis` command (no-op if never linked).
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['rm', '-g', 'zamolxis']);

  // Local model + Ollama (only if WE installed them).
  if (have('model')) {
    console.log(`Removing local model ${inst.model}...`);
    run('ollama', ['rm', String(inst.model)]);
  }
  if (have('ollama')) {
    console.log('Removing Ollama...');
    if (process.platform === 'win32') run('winget', ['uninstall', '-e', '--id', 'Ollama.Ollama', '--silent']);
    else {
      try {
        spawnSync('sh', ['-c', 'sudo systemctl disable --now ollama 2>/dev/null; sudo rm -f "$(command -v ollama)"; sudo rm -rf /usr/share/ollama'], { stdio: 'inherit' });
      } catch {}
    }
  }

  // Claude Code CLI (only if WE installed it).
  if (have('claudeCode')) {
    console.log('Removing Claude Code CLI...');
    run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['rm', '-g', '@anthropic-ai/claude-code']);
  }

  // Read the manifest BEFORE this, so purging the data dir is safe to do now.
  if (purge) {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
      console.log(`Deleted data dir: ${dataDir}`);
    } catch (e) {
      console.log(`Could not delete ${dataDir}: ${e.message}`);
    }
  } else {
    console.log(`Kept your data: ${dataDir}  (delete it yourself to remove skills/memory/.env).`);
  }

  // Node + git are the runtime this very process uses - don't pull them out from under it.
  // On Windows, schedule their removal AFTER this process exits (a detached PowerShell waits on
  // our PID). On macOS/Linux, removing system packages needs sudo, so just print the commands.
  const removeNode = have('node');
  const removeGit = have('git');
  if (removeNode || removeGit) {
    if (process.platform === 'win32') {
      let cmds = `Wait-Process -Id ${process.pid} -ErrorAction SilentlyContinue; `;
      if (removeNode) cmds += 'winget uninstall -e --id OpenJS.NodeJS.LTS --silent; ';
      if (removeGit) cmds += 'winget uninstall -e --id Git.Git --silent; ';
      try {
        spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', cmds], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        console.log(`Scheduled removal of ${[removeNode ? 'Node.js' : null, removeGit ? 'git' : null].filter(Boolean).join(' + ')} (runs after this process exits).`);
      } catch {}
    } else {
      console.log('\nThe installer also added these - remove them manually if you no longer need them:');
      if (removeNode) console.log('  - Node.js  (e.g. `brew uninstall node`, or your distro package manager)');
      if (removeGit) console.log('  - git      (e.g. `brew uninstall git`,  or your distro package manager)');
    }
  }

  console.log('\nZamolxis uninstalled.');
  console.log(`To finish, delete the program folder:\n  ${root}`);
}

// One step of an update (git pull / npm install / npm run build). Output is appended to the
// daemon log so the detached process leaves a trace. Returns true on success (exit 0).
function updateStep(label, cmd, args) {
  fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(logFile, `\n[update] ${label}: ${cmd} ${args.join(' ')}\n`);
  const out = fs.openSync(logFile, 'a');
  const r = spawnSync(cmd, args, { cwd: root, stdio: ['ignore', out, out], windowsHide: true, shell: process.platform === 'win32' });
  fs.closeSync(out);
  return r.status === 0;
}
// Pull the latest from git, reinstall, rebuild, and restart. A failed pull or build ABORTS
// without restarting, so a broken update never takes down a working instance.
async function updateCmd() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(logFile, `\n[update] starting at ${new Date().toISOString()} (cwd ${root})\n`);
  if (!updateStep('git pull', 'git', ['pull', '--ff-only'])) {
    fs.appendFileSync(logFile, '[update] git pull --ff-only failed (diverged history or no network); aborting, NOT restarting.\n');
    console.error('Update aborted: `git pull --ff-only` failed (see log).');
    process.exit(1);
  }
  // --include=dev: a web-triggered update inherits the daemon's NODE_ENV=production, under which
  // npm omits devDependencies - which would prune `typescript`, so `npm run build` (tsc) then fails
  // with "tsc: command not found" and the update silently aborts. Forcing dev deps fixes it on every OS.
  if (!updateStep('npm install', npm, ['install', '--no-audit', '--no-fund', '--include=dev'])) {
    fs.appendFileSync(logFile, '[update] npm install failed; aborting, NOT restarting.\n');
    console.error('Update aborted: npm install failed (see log).');
    process.exit(1);
  }
  if (!updateStep('npm run build', npm, ['run', 'build'])) {
    fs.appendFileSync(logFile, '[update] build failed; aborting (NOT restarting on a broken build).\n');
    console.error('Update aborted: build failed (see log).');
    process.exit(1);
  }
  fs.appendFileSync(logFile, '[update] pull + install + build OK; restarting.\n');
  await stop();
  await sleep(600);
  start([]);
}

function usage() {
  console.log(`Zamolxis - self-hosted agent on your Claude subscription

Usage: zamolxis <command> [extra daemon args]   (alias: zam <command>)

  run        run in the foreground (web UI + channels; Ctrl+C to stop)
  start      start in the background (detached, survives terminal close)
  stop       stop the background instance
  restart    restart the background instance
  update     git pull + reinstall + rebuild + restart (if installed from git)
  status     show whether it is running
  web        foreground, web UI only
  cli        foreground, interactive CLI only
  doctor     readiness check (auth, build, channels, sandbox)
  pack       bundle this setup (all skills; asks about SOUL/USER/teachings) for a new install
  unpack     apply a pack file into this install:  zamolxis unpack <file.json>
  uninstall  stop + remove service + unlink command (add --purge to also delete your data)

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
  case 'update':
    await updateCmd();
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
  case 'uninstall':
    await uninstallCmd();
    break;
  default:
    usage();
    if (cmd && cmd !== 'help' && cmd !== '--help' && cmd !== '-h') process.exit(1);
}
