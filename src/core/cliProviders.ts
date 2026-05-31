import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';
import { logger } from '../logger.js';

/**
 * Other AI tools that, like Claude Code, run via their OWN CLI on a subscription/login
 * (no API key in Zamolxis). We DETECT whether each is installed + logged in, and offer a
 * one-click install. Actual routing through them is wired incrementally; for now this
 * makes them visible and installable from the Providers panel.
 */
export interface CliProviderDef {
  id: string;
  name: string;
  /** Executable name to look up on PATH. */
  bin: string;
  /** npm package that provides the CLI (install target). */
  npm: string;
  /** Home-relative files that indicate the user has logged in (any present = logged in). */
  loginFiles: string[];
  /** Shell command the user runs once to log in. */
  loginCmd: string;
  docs: string;
}

export const CLI_PROVIDERS: CliProviderDef[] = [
  {
    id: 'gemini-cli',
    name: 'Gemini CLI (Google)',
    bin: 'gemini',
    npm: '@google/gemini-cli',
    loginFiles: ['.gemini/oauth_creds.json', '.gemini/google_accounts.json', '.gemini/settings.json'],
    loginCmd: 'gemini  (then choose "Login with Google")',
    docs: 'https://github.com/google-gemini/gemini-cli',
  },
  {
    id: 'codex-cli',
    name: 'Codex CLI (OpenAI / ChatGPT)',
    bin: 'codex',
    npm: '@openai/codex',
    loginFiles: ['.codex/auth.json'],
    loginCmd: 'codex login',
    docs: 'https://github.com/openai/codex',
  },
  {
    id: 'qwen-code',
    name: 'Qwen Code (Alibaba)',
    bin: 'qwen',
    npm: '@qwen-code/qwen-code',
    loginFiles: ['.qwen/oauth_creds.json', '.qwen/settings.json'],
    loginCmd: 'qwen  (then authenticate)',
    docs: 'https://github.com/QwenLM/qwen-code',
  },
];

/** Find an executable on PATH, cross-platform (handles .cmd/.exe/.bat on Windows). */
export function hasBin(bin: string): boolean {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const d of dirs) {
    for (const ext of exts) {
      try {
        if (fs.existsSync(path.join(d, bin + ext))) return true;
      } catch {
        /* ignore unreadable PATH dir */
      }
    }
  }
  return false;
}

function loggedIn(p: CliProviderDef): boolean {
  const home = os.homedir();
  return p.loginFiles.some((f) => {
    try {
      return fs.existsSync(path.join(home, f));
    } catch {
      return false;
    }
  });
}

export interface CliProviderStatus {
  id: string;
  name: string;
  installed: boolean;
  loggedIn: boolean;
  loginCmd: string;
  docs: string;
}

export function cliProviderStatus(): CliProviderStatus[] {
  return CLI_PROVIDERS.map((p) => {
    const installed = hasBin(p.bin);
    return { id: p.id, name: p.name, installed, loggedIn: installed && loggedIn(p), loginCmd: p.loginCmd, docs: p.docs };
  });
}

export function hasDocker(): boolean {
  return hasBin('docker');
}

/** The platform-appropriate install command for a CLI provider id or 'docker'. */
export function installCommand(target: string): string | null {
  if (target === 'docker') {
    if (process.platform === 'win32') return 'winget install -e --id Docker.DockerDesktop --accept-source-agreements --accept-package-agreements';
    if (process.platform === 'darwin') return 'brew install --cask docker';
    return 'curl -fsSL https://get.docker.com | sh';
  }
  const p = CLI_PROVIDERS.find((x) => x.id === target);
  if (p) return `npm install -g ${p.npm}`;
  return null;
}

/** Run an install command (auto-run, per user choice). Streams nothing; returns combined output. */
export function runInstall(target: string): Promise<{ ok: boolean; command: string; output: string }> {
  const cmd = installCommand(target);
  if (!cmd) return Promise.resolve({ ok: false, command: '', output: `Unknown install target "${target}".` });
  logger.info({ target, cmd }, 'running install command');
  return new Promise((resolve) => {
    exec(cmd, { timeout: 15 * 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const output = `$ ${cmd}\n\n${(stdout || '').toString()}${(stderr || '').toString()}`.trim();
      if (err) logger.warn({ target, err: String(err) }, 'install command failed');
      resolve({ ok: !err, command: cmd, output: output || (err ? String(err) : '(no output)') });
    });
  });
}
