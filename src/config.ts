import 'dotenv/config';
import { z } from 'zod';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

/** Extra (read-only) skill roots: explicit via ZAMOLXIS_EXTRA_SKILLS_DIRS (`;`/`,`-separated),
 *  plus auto-detected Hermes installs. Scanned recursively for SKILL.md by the SkillsManager. */
function detectExtraSkillsDirs(dataDir: string): string[] {
  const dirs: string[] = [];
  const env = process.env.ZAMOLXIS_EXTRA_SKILLS_DIRS;
  if (env) for (const d of env.split(/[;,]/).map((s) => s.trim()).filter(Boolean)) dirs.push(d);
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  for (const c of [
    path.join(local, 'hermes', 'hermes-agent', 'skills'),
    path.join(local, 'hermes', 'hermes-agent', 'optional-skills'),
    path.join(home, '.hermeslite', 'skills'),
  ]) {
    try {
      if (fs.existsSync(c)) dirs.push(c);
    } catch {
      /* ignore */
    }
  }
  const own = path.resolve(path.join(dataDir, 'skills'));
  return [...new Set(dirs)].filter((d) => path.resolve(d) !== own);
}

/**
 * Zamolxis configuration.
 *
 * Loaded from environment variables (.env) with sane defaults. The agent is
 * SUBSCRIPTION-FUNDED: we never require ANTHROPIC_API_KEY for core operation.
 * Paid extras (image generation, non-Claude models) are gated behind their own
 * keys and degrade gracefully when absent.
 */

const bool = (v: string | undefined, dflt: boolean): boolean => {
  if (v === undefined) return dflt;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
};

const ConfigSchema = z.object({
  /** Root for all persisted state (sessions, per-user workspaces, sqlite, logs). */
  dataDir: z.string(),
  /** Per-user agent workspaces live under here; each gets a CLAUDE.md + .claude/. */
  workspacesDir: z.string(),
  /** Shared, auto-generated skills directory (SKILL.md folders). */
  skillsDir: z.string(),
  /** Extra (read-only) skill roots scanned recursively — e.g. a Hermes install's skills tree. */
  extraSkillsDirs: z.array(z.string()),

  /** The agent's display name — how it identifies itself and what the UIs show. */
  agentName: z.string(),
  /** Whether the inviolable LAWS block is injected into the system prompt. */
  lawsEnabled: z.boolean(),
  /** On startup, restore each agent to its last state (stopped agents stay stopped, scheduled
   *  agents keep their schedules). When false, all agents start paused until manually resumed.
   *  A per-agent `autostart` overrides this. */
  agentRestore: z.boolean(),

  /** Primary Claude model (alias 'opus'|'sonnet'|'haiku' or full id). Undefined = CLI default. */
  model: z.string().optional(),
  /** Cheaper model used by the router for simple/cheap turns. */
  fastModel: z.string().optional(),
  /** Strongest model — used when a local-model turn escalates because it couldn't cope. */
  smartModel: z.string().optional(),
  /** IANA timezone for "what time is it" (e.g. "America/New_York"). Defaults to the host's;
   *  auto-detected from the browser so agents report the USER's local time even on a UTC host. */
  timezone: z.string().optional(),
  /** Optional on-device model (OpenAI-compatible, e.g. Ollama) the agent can offload easy subtasks to. */
  localModel: z.object({ url: z.string(), model: z.string() }).optional(),
  /**
   * How aggressively to use the local model to spare the subscription:
   *  - 'off'  : never route whole turns locally (local stays an offload tool only)
   *  - 'auto' : answer simple turns with the local model directly, escalating to Claude when needed
   * A per-message route ('local'|'claude') can still override this.
   */
  localRouting: z.enum(['off', 'auto']),
  /**
   * Ordered routing chain — which backends to try, in order, before giving up.
   * Tokens: 'local' (on-device), 'freecloud' (rotate configured free providers),
   * a specific provider id (e.g. 'google','deepseek','openai'), or 'claude'
   * (subscription). Drop 'claude' to run only on local/free/paid. The user owns this.
   */
  routeChain: z.array(z.string()),

  /** Permission posture for the autonomous agent. */
  permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk']),
  /** Explicit auto-allow tool list (used with the canUseTool policy). */
  allowedTools: z.array(z.string()).optional(),
  /** Tools that are always denied regardless of policy. */
  disallowedTools: z.array(z.string()).optional(),

  /** Max concurrent agent turns across all channels (subscription backpressure). */
  maxConcurrent: z.number().int().positive(),
  /** Extra text appended to the Claude Code system prompt. */
  systemPromptAppend: z.string().optional(),
  /** Hard ceiling on conversation turns per inbound message. */
  maxTurns: z.number().int().positive(),
  /** Wall-clock timeout per inbound message; aborts a stuck turn so it can't jam the queue. */
  turnTimeoutMs: z.number().int().positive(),

  /** Command-execution sandbox backends. */
  sandbox: z.object({
    backend: z.enum(['local', 'docker', 'ssh', 'modal']),
    docker: z.object({ image: z.string(), container: z.string().optional() }).optional(),
    ssh: z
      .object({ host: z.string(), user: z.string(), port: z.number().optional(), identity: z.string().optional() })
      .optional(),
    modal: z.object({ runnerScript: z.string() }).optional(),
  }),

  /** Browser interface. */
  web: z.object({
    port: z.number().int().positive(),
    /** Bind address. 127.0.0.1 = local only; 0.0.0.0 = network (requires authToken). */
    bind: z.string(),
    authToken: z.string().optional(),
  }),

  /** Which channels to start. */
  channels: z.object({
    cli: z.boolean(),
    telegram: z.boolean(),
    discord: z.boolean(),
    slack: z.boolean(),
    whatsapp: z.boolean(),
    signal: z.boolean(),
    email: z.boolean(),
    web: z.boolean(),
  }),
});

export type ZamolxisConfig = z.infer<typeof ConfigSchema>;

/** Parse `--channels=cli,telegram` from argv, overriding env if present. */
function channelsFromArgv(): Set<string> | null {
  const arg = process.argv.find((a) => a.startsWith('--channels='));
  if (!arg) return null;
  return new Set(
    arg
      .slice('--channels='.length)
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function loadConfig(): ZamolxisConfig {
  const dataDir = process.env.ZAMOLXIS_DATA_DIR
    ? path.resolve(process.env.ZAMOLXIS_DATA_DIR)
    : path.join(os.homedir(), '.zamolxis');

  const override = channelsFromArgv();
  const enabled = (name: string, envVar: string): boolean =>
    override ? override.has(name) : bool(process.env[envVar], false);

  const raw = {
    dataDir,
    workspacesDir: path.join(dataDir, 'workspaces'),
    skillsDir: path.join(dataDir, 'skills'),
    extraSkillsDirs: detectExtraSkillsDirs(dataDir),
    agentName: process.env.ZAMOLXIS_AGENT_NAME || 'Zamolxis',
    lawsEnabled: bool(process.env.ZAMOLXIS_LAWS_ENABLED, true),
    agentRestore: bool(process.env.ZAMOLXIS_AGENT_RESTORE, true),
    model: process.env.ZAMOLXIS_MODEL || undefined,
    fastModel: process.env.ZAMOLXIS_FAST_MODEL || 'haiku',
    smartModel: process.env.ZAMOLXIS_SMART_MODEL || 'opus',
    timezone: process.env.ZAMOLXIS_TZ || undefined,
    localModel: process.env.ZAMOLXIS_LOCAL_MODEL
      ? { url: process.env.ZAMOLXIS_LOCAL_MODEL_URL || 'http://localhost:11434/v1', model: process.env.ZAMOLXIS_LOCAL_MODEL }
      : undefined,
    // Default to 'auto' when a local model exists (the point of installing one is
    // to use the subscription less), else 'off'. Overridable via env / settings.
    localRouting:
      (process.env.ZAMOLXIS_LOCAL_ROUTING as 'off' | 'auto') ||
      (process.env.ZAMOLXIS_LOCAL_MODEL ? 'auto' : 'off'),
    // Free cloud first, on-device local LAST (it's the least reliable), Claude as the rescue tier.
    // The engine additionally orders any paid providers between free and local (free → paid → local).
    routeChain: process.env.ZAMOLXIS_ROUTE_CHAIN
      ? process.env.ZAMOLXIS_ROUTE_CHAIN.split(',').map((s) => s.trim()).filter(Boolean)
      : ['freecloud', 'local', 'claude'],
    permissionMode: (process.env.ZAMOLXIS_PERMISSION_MODE as ZamolxisConfig['permissionMode']) || 'acceptEdits',
    allowedTools: process.env.ZAMOLXIS_ALLOWED_TOOLS
      ? process.env.ZAMOLXIS_ALLOWED_TOOLS.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined,
    disallowedTools: process.env.ZAMOLXIS_DISALLOWED_TOOLS
      ? process.env.ZAMOLXIS_DISALLOWED_TOOLS.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined,
    maxConcurrent: Number(process.env.ZAMOLXIS_MAX_CONCURRENT ?? 2),
    systemPromptAppend: process.env.ZAMOLXIS_SYSTEM_APPEND || undefined,
    maxTurns: Number(process.env.ZAMOLXIS_MAX_TURNS ?? 40),
    turnTimeoutMs: Number(process.env.ZAMOLXIS_TURN_TIMEOUT_SECONDS ?? 300) * 1000,
    sandbox: {
      backend: (process.env.ZAMOLXIS_SANDBOX_BACKEND as 'local' | 'docker' | 'ssh' | 'modal') || 'local',
      docker: process.env.ZAMOLXIS_DOCKER_IMAGE
        ? { image: process.env.ZAMOLXIS_DOCKER_IMAGE, container: process.env.ZAMOLXIS_DOCKER_CONTAINER || undefined }
        : undefined,
      ssh:
        process.env.ZAMOLXIS_SSH_HOST && process.env.ZAMOLXIS_SSH_USER
          ? {
              host: process.env.ZAMOLXIS_SSH_HOST,
              user: process.env.ZAMOLXIS_SSH_USER,
              port: process.env.ZAMOLXIS_SSH_PORT ? Number(process.env.ZAMOLXIS_SSH_PORT) : undefined,
              identity: process.env.ZAMOLXIS_SSH_IDENTITY || undefined,
            }
          : undefined,
      modal: {
        runnerScript:
          process.env.ZAMOLXIS_MODAL_RUNNER || path.join(process.cwd(), 'src', 'sandbox', 'modal_runner.py'),
      },
    },
    web: {
      port: Number(process.env.ZAMOLXIS_WEB_PORT ?? 8787),
      bind: process.env.ZAMOLXIS_WEB_BIND || '127.0.0.1',
      authToken: process.env.ZAMOLXIS_WEB_AUTH_TOKEN || undefined,
    },
    channels: {
      // CLI defaults ON when no other channel is selected, so a bare run is usable.
      cli: override ? override.has('cli') : bool(process.env.ZAMOLXIS_CHANNEL_CLI, true),
      telegram: enabled('telegram', 'ZAMOLXIS_CHANNEL_TELEGRAM'),
      discord: enabled('discord', 'ZAMOLXIS_CHANNEL_DISCORD'),
      slack: enabled('slack', 'ZAMOLXIS_CHANNEL_SLACK'),
      whatsapp: enabled('whatsapp', 'ZAMOLXIS_CHANNEL_WHATSAPP'),
      signal: enabled('signal', 'ZAMOLXIS_CHANNEL_SIGNAL'),
      email: enabled('email', 'ZAMOLXIS_CHANNEL_EMAIL'),
      web: enabled('web', 'ZAMOLXIS_CHANNEL_WEB'),
    },
  } satisfies ZamolxisConfig;

  const config = ConfigSchema.parse(raw);
  applyPersistedSettings(config);

  // Materialize directories up-front.
  for (const dir of [config.dataDir, config.workspacesDir, config.skillsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return config;
}

/**
 * Overlay UI-managed settings (written by the web Settings panel) onto a config
 * object: applied both at startup and on a live reload. Credentials are injected
 * into process.env so freshly-constructed channel adapters pick them up. An
 * explicit `--channels=` argv still wins over persisted channel flags; `--web`
 * force-enables the web channel without restricting the others.
 */
export function applyPersistedSettings(config: ZamolxisConfig): void {
  const argvChannels = channelsFromArgv();
  try {
    const sp = path.join(config.dataDir, 'settings.json');
    if (fs.existsSync(sp)) {
      const s = JSON.parse(fs.readFileSync(sp, 'utf8')) as Record<string, any>;
      if (typeof s.agentName === 'string' && s.agentName.trim()) config.agentName = s.agentName.trim();
      if (typeof s.lawsEnabled === 'boolean') config.lawsEnabled = s.lawsEnabled;
      if (typeof s.agentRestore === 'boolean') config.agentRestore = s.agentRestore;
      if (typeof s.model === 'string') config.model = s.model || undefined;
      if (typeof s.fastModel === 'string') config.fastModel = s.fastModel || undefined;
      if (typeof s.smartModel === 'string') config.smartModel = s.smartModel || undefined;
      if (typeof s.timezone === 'string' && s.timezone) config.timezone = s.timezone;
      if (typeof s.permissionMode === 'string') config.permissionMode = s.permissionMode as ZamolxisConfig['permissionMode'];
      if (typeof s.maxTurns === 'number') config.maxTurns = s.maxTurns;
      if (typeof s.maxConcurrent === 'number') config.maxConcurrent = s.maxConcurrent;
      if (typeof s.systemPromptAppend === 'string') config.systemPromptAppend = s.systemPromptAppend || undefined;
      if (typeof s.sandboxBackend === 'string') config.sandbox.backend = s.sandboxBackend as ZamolxisConfig['sandbox']['backend'];
      if (s.localRouting === 'off' || s.localRouting === 'auto') config.localRouting = s.localRouting;
      if (Array.isArray(s.routeChain) && s.routeChain.length) config.routeChain = s.routeChain.filter((t: unknown) => typeof t === 'string');

      if (s.channels && argvChannels === null) {
        for (const k of Object.keys(config.channels) as Array<keyof typeof config.channels>) {
          if (typeof s.channels[k] === 'boolean') config.channels[k] = s.channels[k];
        }
      }
      if (s.web) {
        if (typeof s.web.port === 'number') config.web.port = s.web.port;
        if (typeof s.web.bind === 'string' && s.web.bind) config.web.bind = s.web.bind;
        if (typeof s.web.authToken === 'string' && s.web.authToken) config.web.authToken = s.web.authToken;
      }
      if (s.sandbox) {
        if (s.sandbox.dockerImage) config.sandbox.docker = { image: s.sandbox.dockerImage, container: s.sandbox.dockerContainer || undefined };
        if (s.sandbox.sshHost && s.sandbox.sshUser) {
          config.sandbox.ssh = {
            host: s.sandbox.sshHost,
            user: s.sandbox.sshUser,
            port: s.sandbox.sshPort ? Number(s.sandbox.sshPort) : undefined,
            identity: s.sandbox.sshIdentity || undefined,
          };
        }
      }
      if (s.credentials && typeof s.credentials === 'object') {
        for (const [k, v] of Object.entries(s.credentials)) {
          if (typeof v === 'string' && v) process.env[k] = v;
        }
      }
    }
  } catch {
    /* malformed settings.json — ignore, use env/defaults */
  }

  // `--web` (used by `npm run web`) force-enables the browser UI, keeping any
  // other channels configured via settings/env enabled too.
  if (process.argv.includes('--web')) config.channels.web = true;
}
