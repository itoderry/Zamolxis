import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { logger } from '../../logger.js';
import type { BackendEnv } from './backends.js';
import type { DelegateRunResult } from './codeRunner.js';
import { reportsIncomplete } from './codeRunner.js';
import { resolveClaudeModel } from '../claudeModels.js';

/**
 * Path 3: the installed `claude` CLI run headless (`claude -p`), for jobs that do NOT need code:
 * research, analysis, writing. It gets read/research tools only (no Bash/Edit/Write) and runs in a
 * scratch folder unless an allowed project folder is given. The task always goes in through stdin,
 * never on the command line, so nothing in it can be read as a flag or shell syntax.
 */

export interface ClaudeBin {
  path: string;
  /** npm .cmd shims can only be started through the shell on Windows. */
  shell: boolean;
}

let CLAUDE: ClaudeBin | null | undefined;
let CLAUDE_AT = 0;

/** Locate the `claude` CLI even when the daemon's PATH is minimal (autostart, launchers):
 *  PATH lookup first, then the native installer location, then npm global shims. Cached (a miss
 *  only for a minute, so installing Claude Code while Zamolxis runs is picked up without a restart). */
export function resolveClaude(refresh = false): ClaudeBin | null {
  if (CLAUDE !== undefined && !refresh && (CLAUDE !== null || Date.now() - CLAUDE_AT < 60_000)) return CLAUDE;
  CLAUDE_AT = Date.now();
  const home = os.homedir();
  const cands: string[] = [];
  try {
    const w = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (w.status === 0) cands.push(...(w.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  } catch {
    /* where/which unavailable */
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    cands.push(path.join(home, '.local', 'bin', 'claude.exe'), path.join(appData, 'npm', 'claude.cmd'));
  } else {
    cands.push(path.join(home, '.local', 'bin', 'claude'), path.join(home, '.claude', 'local', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude', path.join(home, '.npm-global', 'bin', 'claude'));
  }
  // On Windows prefer a real .exe over a .cmd shim (no shell needed); skip extensionless sh shims.
  const usable = cands.filter((c) => {
    try {
      if (!fs.existsSync(c) || !fs.statSync(c).isFile()) return false;
    } catch {
      return false;
    }
    return process.platform !== 'win32' || /\.(exe|cmd|bat)$/i.test(c);
  });
  const pick = usable.find((c) => /\.exe$/i.test(c)) ?? usable[0];
  CLAUDE = pick ? { path: pick, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(pick) } : null;
  return CLAUDE;
}

let VERSION: { at: number; value: string | null } | undefined;
/** `claude --version` (cached for 10 minutes; null when the CLI is missing or broken). Async so the
 *  Settings poll never blocks the web server. */
export async function claudeVersion(): Promise<string | null> {
  if (VERSION && Date.now() - VERSION.at < 600_000) return VERSION.value;
  const bin = resolveClaude();
  const value = !bin
    ? null
    : await new Promise<string | null>((resolve) => {
        try {
          execFile(bin.shell ? `"${bin.path}"` : bin.path, ['--version'], { shell: bin.shell, windowsHide: true, timeout: 15_000 }, (err, stdout) =>
            resolve(err ? null : String(stdout).trim().split(/\r?\n/)[0] || null),
          );
        } catch {
          resolve(null);
        }
      });
  VERSION = { at: Date.now(), value };
  return value;
}

/** Read/research tools a non-code job may use, and the ones it must never get. */
export const CLI_ALLOWED_TOOLS = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'];
export const CLI_DENIED_TOOLS = ['Bash', 'PowerShell', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

export interface CliTaskOptions {
  task: string;
  /** Allowed project folder (read-only use), or undefined for a fresh scratch folder. */
  folder?: string;
  /** Where scratch folders go (removed after the run). */
  scratchRoot: string;
  backend: BackendEnv;
  maxTurns: number;
  timeoutMs: number;
  /** Laws block + worker role (written to a temp file and passed with --append-system-prompt-file). */
  append: string;
  abortController: AbortController;
  onProgress?: (line: string) => void;
  /** Extra tools to deny (Zamolxis policy denylist). */
  disallowedTools?: string[];
}

/** Quote an argument for cmd.exe when a .cmd shim forces shell:true. Only our own controlled
 *  arguments ever go through here (flags, numbers, tool lists, a model name, a temp-file path). */
function shellArg(a: string): string {
  if (/["%!^&|<>\r\n]/.test(a)) throw new Error(`unsafe argument for the shell: ${a.slice(0, 40)}`);
  return /^[A-Za-z0-9_\-.,:\\/=@]+$/.test(a) ? a : `"${a}"`;
}

/** Kill the CLI and everything it started (the shell wrapper on Windows has children). */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

/** Run one non-code task through `claude -p`. Never throws; failures come back as ok:false. */
export async function runCliTask(o: CliTaskOptions): Promise<DelegateRunResult> {
  const started = Date.now();
  const fail = (summary: string): DelegateRunResult => ({ ok: false, summary, filesChanged: [], costUsd: 0, backend: o.backend.backend, model: o.backend.model, durationMs: Date.now() - started, incomplete: true });
  const bin = resolveClaude();
  if (!bin) return fail('The claude CLI was not found. Install Claude Code (npm install -g @anthropic-ai/claude-code or the native installer) and log in with `claude auth login`.');
  if (o.backend.model && !/^[\w.:/@[\]-]+$/.test(o.backend.model)) return fail(`Refusing an unusual model name: ${o.backend.model}`);

  const runId = `${started.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const scratch = path.join(o.scratchRoot, runId);
  fs.mkdirSync(scratch, { recursive: true });
  const promptFile = path.join(scratch, '.append-system-prompt.md');
  fs.writeFileSync(promptFile, o.append);
  const cwd = o.folder ?? scratch;

  // --tools limits the BUILT-IN tool set to the read/research tools (so e.g. the Windows PowerShell
  // tool, Task subagents or anything the user's settings auto-allow are not even offered), and
  // --strict-mcp-config without --mcp-config drops the user's MCP servers, which may write files or
  // run commands. --disallowedTools stays as a second line of defence.
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--max-turns', String(Math.max(1, Math.floor(o.maxTurns))),
    '--tools', CLI_ALLOWED_TOOLS.join(','),
    '--strict-mcp-config',
    '--allowedTools', CLI_ALLOWED_TOOLS.join(','),
    '--disallowedTools', [...new Set([...CLI_DENIED_TOOLS, ...(o.disallowedTools ?? [])])].join(','),
    '--no-session-persistence',
    // Only the project's own settings: the user's plugins, hooks, auto-memory and env would add
    // tens of thousands of tokens to every run and could redirect it to another backend.
    '--setting-sources', 'project',
    '--append-system-prompt-file', promptFile,
  ];
  // Free/local backends authenticate through ANTHROPIC_AUTH_TOKEN, so the minimal mode (no hooks,
  // plugins, CLAUDE.md discovery or keychain reads) fits them. It can't be used on the Claude
  // backend: --bare skips the keychain, where the subscription login lives.
  if (o.backend.backend !== 'claude') args.push('--bare');
  const model = o.backend.backend === 'claude' ? resolveClaudeModel(o.backend.model) : o.backend.model;
  if (model) args.push('--model', model);

  let summary = '';
  let ok = false;
  let incomplete = false;
  let costUsd = 0;
  let modelUsage: DelegateRunResult['modelUsage'];
  let gotResult = false;
  let stderr = '';
  let lastProgress = 0;

  try {
    await new Promise<void>((resolve) => {
      let child: ReturnType<typeof spawn>;
      // A Zamolxis started from a Claude Code terminal inherits CLAUDECODE=1, which makes the CLI
      // refuse to start as a "nested session".
      const env: NodeJS.ProcessEnv = { ...o.backend.env };
      delete env.CLAUDECODE;
      try {
        child = bin.shell
          ? spawn(`"${bin.path}"`, args.map(shellArg), { cwd, env, shell: true, windowsHide: true })
          : spawn(bin.path, args, { cwd, env, shell: false, windowsHide: true });
      } catch (err) {
        summary = `Could not start the claude CLI: ${String(err)}`;
        resolve();
        return;
      }
      const stop = (): void => killTree(child.pid);
      const timer = setTimeout(() => {
        summary = summary || 'The run took too long and was stopped.';
        stop();
      }, o.timeoutMs);
      timer.unref?.();
      const onAbort = (): void => {
        summary = summary || 'The run was stopped.';
        stop();
      };
      o.abortController.signal.addEventListener('abort', onAbort, { once: true });
      if (o.abortController.signal.aborted) onAbort(); // stopped while it was queued

      let buf = '';
      const onLine = (line: string): void => {
        const s = line.trim();
        if (!s || s[0] !== '{') return;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(s) as Record<string, unknown>;
        } catch {
          return;
        }
        if (ev.type === 'assistant') {
          const content = (ev.message as { content?: unknown } | undefined)?.content;
          if (!Array.isArray(content) || !o.onProgress) return;
          for (const b of content) {
            const blk = b as { type?: string; name?: string; input?: Record<string, unknown> };
            if (blk?.type === 'tool_use' && blk.name && Date.now() - lastProgress > 2000) {
              lastProgress = Date.now();
              const inp = blk.input ?? {};
              const what = blk.name === 'WebSearch' ? `searching the web for ${String(inp.query ?? '').slice(0, 60)}` : blk.name === 'WebFetch' ? `fetching ${String(inp.url ?? '').slice(0, 80)}` : `using ${blk.name}`;
              o.onProgress(what);
            }
          }
        } else if (ev.type === 'result') {
          gotResult = true;
          costUsd = o.backend.backend === 'claude' ? Number(ev.total_cost_usd) || 0 : 0;
          modelUsage = ev.modelUsage as DelegateRunResult['modelUsage'];
          if (ev.subtype === 'success' && !ev.is_error) {
            summary = String(ev.result ?? '');
            ok = true;
            incomplete = reportsIncomplete(summary);
          } else {
            ok = false;
            incomplete = true;
            const errs = Array.isArray(ev.errors) ? (ev.errors as unknown[]).map(String).join('; ') : '';
            // A failed API call ends as subtype "success" with is_error set: label it an error.
            const kind = ev.subtype === 'success' ? 'error' : String(ev.subtype);
            summary = `(${kind})${ev.result ? ': ' + String(ev.result) : errs ? ': ' + errs : ''}`;
          }
        }
      };
      // setEncoding keeps a multi-byte character split across two chunks intact.
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (d: string) => {
        buf += d;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          onLine(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      });
      child.stderr?.on('data', (d: string) => {
        stderr = (stderr + d).slice(-4000);
      });
      child.on('error', (err) => {
        // A failed spawn may never emit 'close': finish here too (resolve is idempotent).
        summary = summary || `The claude CLI failed to start: ${String(err)}`;
        if (child.pid === undefined) {
          clearTimeout(timer);
          o.abortController.signal.removeEventListener('abort', onAbort);
          resolve();
        }
      });
      child.on('close', (code) => {
        if (buf) onLine(buf);
        clearTimeout(timer);
        o.abortController.signal.removeEventListener('abort', onAbort);
        if (!gotResult) {
          ok = false;
          incomplete = true;
          summary = summary || `The claude CLI exited (code ${code}) without a result.${stderr.trim() ? ' ' + stderr.trim().slice(-600) : ''}`;
        }
        resolve();
      });
      // The task goes in on stdin: no quoting, no length limit, nothing parsed as a flag.
      child.stdin?.on('error', () => { /* CLI exited early; reported on close */ });
      child.stdin?.end(o.task);
    });
  } catch (err) {
    logger.warn({ err: String(err) }, 'cli run failed');
    summary = summary || `The run failed: ${String(err)}`;
    ok = false;
  } finally {
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }

  return {
    ok,
    summary: summary || '(no answer)',
    filesChanged: [],
    costUsd,
    backend: o.backend.backend,
    model: o.backend.model,
    durationMs: Date.now() - started,
    incomplete,
    modelUsage,
  };
}
