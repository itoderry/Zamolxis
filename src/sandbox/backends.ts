import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { logger } from '../logger.js';

/**
 * Resolve the shell for the local backend. The agent writes POSIX shell, so we
 * prefer a real `bash` (git-bash on Windows) and only fall back to PowerShell.
 * Override with ZAMOLXIS_LOCAL_SHELL=<path-to-shell>.
 */
function resolveLocalShell(): [string, string] {
  const override = process.env.ZAMOLXIS_LOCAL_SHELL;
  if (override) return [override, process.platform === 'win32' && /powershell|pwsh/i.test(override) ? '-Command' : '-c'];
  if (process.platform !== 'win32') return ['/bin/sh', '-c'];
  for (const p of ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']) {
    if (fs.existsSync(p)) return [p, '-c'];
  }
  return ['powershell.exe', '-Command'];
}

export type BackendName = 'local' | 'docker' | 'ssh' | 'modal';

export interface ExecResult {
  backend: BackendName;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface SandboxConfig {
  /** Default backend used when a tool call doesn't specify one. */
  backend: BackendName;
  docker?: { image: string; container?: string };
  ssh?: { host: string; user: string; port?: number; identity?: string };
  /** Path to the Modal runner script shipped with Zamolxis. */
  modal?: { runnerScript: string };
}

/** Run a child process, capturing output with a hard wall-clock timeout. */
function runProcess(
  command: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number; input?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: opts.cwd, shell: false });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);

    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}${String(err)}`, exitCode: 127, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 0, timedOut });
    });
    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

export interface SandboxBackend {
  readonly name: BackendName;
  /** Whether this backend is usable right now (binary present, config set). */
  available(): Promise<boolean>;
  exec(command: string, opts: { cwd?: string; timeoutMs: number }): Promise<ExecResult>;
}

class LocalBackend implements SandboxBackend {
  readonly name = 'local' as const;
  private readonly shell = resolveLocalShell();
  async available(): Promise<boolean> {
    return true;
  }
  async exec(command: string, opts: { cwd?: string; timeoutMs: number }): Promise<ExecResult> {
    const [shell, flag] = this.shell;
    const r = await runProcess(shell, [flag, command], opts);
    return { backend: this.name, ...r };
  }
}

class DockerBackend implements SandboxBackend {
  readonly name = 'docker' as const;
  constructor(private readonly cfg: NonNullable<SandboxConfig['docker']>) {}
  async available(): Promise<boolean> {
    const r = await runProcess('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 8000 });
    return r.exitCode === 0;
  }
  async exec(command: string, opts: { timeoutMs: number }): Promise<ExecResult> {
    // Reuse a named container if configured, else a throwaway `docker run`.
    const args = this.cfg.container
      ? ['exec', this.cfg.container, 'sh', '-lc', command]
      : ['run', '--rm', this.cfg.image, 'sh', '-lc', command];
    const r = await runProcess('docker', args, { timeoutMs: opts.timeoutMs });
    return { backend: this.name, ...r };
  }
}

class SshBackend implements SandboxBackend {
  readonly name = 'ssh' as const;
  constructor(private readonly cfg: NonNullable<SandboxConfig['ssh']>) {}
  async available(): Promise<boolean> {
    return Boolean(this.cfg.host && this.cfg.user);
  }
  async exec(command: string, opts: { timeoutMs: number }): Promise<ExecResult> {
    const args: string[] = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];
    if (this.cfg.port) args.push('-p', String(this.cfg.port));
    if (this.cfg.identity) args.push('-i', this.cfg.identity);
    args.push(`${this.cfg.user}@${this.cfg.host}`, command);
    const r = await runProcess('ssh', args, { timeoutMs: opts.timeoutMs });
    return { backend: this.name, ...r };
  }
}

class ModalBackend implements SandboxBackend {
  readonly name = 'modal' as const;
  constructor(private readonly cfg: NonNullable<SandboxConfig['modal']>) {}
  async available(): Promise<boolean> {
    if (!process.env.MODAL_TOKEN_ID || !process.env.MODAL_TOKEN_SECRET) return false;
    const r = await runProcess('modal', ['--version'], { timeoutMs: 8000 });
    return r.exitCode === 0;
  }
  async exec(command: string, opts: { timeoutMs: number }): Promise<ExecResult> {
    // Runs the shipped Modal app, which executes the command in a Modal sandbox.
    const r = await runProcess('modal', ['run', this.cfg.runnerScript, '--cmd', command], {
      timeoutMs: opts.timeoutMs,
    });
    return { backend: this.name, ...r };
  }
}

/**
 * Holds the configured backends and routes `exec` to the right one. Backends
 * that aren't usable (no Docker, no SSH config, no Modal token) report via
 * `available()` and return a clear error from `exec` rather than crashing.
 */
export class SandboxManager {
  private readonly backends = new Map<BackendName, SandboxBackend>();
  private current: BackendName;

  constructor(private readonly cfg: SandboxConfig) {
    this.backends.set('local', new LocalBackend());
    if (cfg.docker) this.backends.set('docker', new DockerBackend(cfg.docker));
    if (cfg.ssh) this.backends.set('ssh', new SshBackend(cfg.ssh));
    if (cfg.modal) this.backends.set('modal', new ModalBackend(cfg.modal));
    this.current = cfg.backend;
  }

  get defaultBackend(): BackendName {
    return this.current;
  }

  /** Change the default backend at runtime (web Settings panel). No-op if not configured. */
  setDefaultBackend(name: BackendName): boolean {
    if (!this.backends.has(name)) return false;
    this.current = name;
    return true;
  }

  listConfigured(): BackendName[] {
    return [...this.backends.keys()];
  }

  async exec(command: string, backend: BackendName, timeoutMs: number, cwd?: string): Promise<ExecResult> {
    const be = this.backends.get(backend);
    if (!be) {
      return {
        backend,
        stdout: '',
        stderr: `Backend "${backend}" is not configured. Available: ${this.listConfigured().join(', ')}.`,
        exitCode: 1,
        timedOut: false,
      };
    }
    if (!(await be.available())) {
      return {
        backend,
        stdout: '',
        stderr: `Backend "${backend}" is configured but not available (missing binary, credentials, or daemon).`,
        exitCode: 1,
        timedOut: false,
      };
    }
    logger.info({ backend, cmd: command.slice(0, 120) }, 'sandbox exec');
    return be.exec(command, { cwd, timeoutMs });
  }
}
