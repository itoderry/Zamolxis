import fs from 'node:fs';
import path from 'node:path';
import type { ZamolxisConfig } from '../config.js';
import type { SandboxManager, BackendName } from '../sandbox/backends.js';
import type { MemoryManager } from './memory.js';
import { searchProviderName } from './localTools.js';
import { logger } from '../logger.js';

const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk'] as const;
const SANDBOX_BACKENDS = ['local', 'docker', 'ssh', 'modal'] as const;

/** Curated model choices for the dropdowns. '' = let the CLI pick its default. */
const MODELS = [
  '',
  'opus',
  'sonnet',
  'haiku',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
];

const CHANNELS = ['cli', 'telegram', 'discord', 'slack', 'whatsapp', 'signal', 'email', 'web'] as const;

/** Channel credential fields. `secret: true` => write-only (never echoed back to the browser). */
const CRED_FIELDS: Array<{ key: string; label: string; group: string; secret: boolean }> = [
  { key: 'CLAUDE_CODE_OAUTH_TOKEN', label: 'Claude subscription token — paste from `claude setup-token` (required on macOS)', group: 'claude', secret: true },
  { key: 'TELEGRAM_BOT_TOKEN', label: 'Telegram bot token', group: 'telegram', secret: true },
  { key: 'TELEGRAM_ALLOWED_USERS', label: 'Telegram allowed usernames/ids (comma-sep, blank = all)', group: 'telegram', secret: false },
  { key: 'DISCORD_BOT_TOKEN', label: 'Discord bot token', group: 'discord', secret: true },
  { key: 'SLACK_BOT_TOKEN', label: 'Slack bot token (xoxb-)', group: 'slack', secret: true },
  { key: 'SLACK_APP_TOKEN', label: 'Slack app token (xapp-)', group: 'slack', secret: true },
  { key: 'SIGNAL_NUMBER', label: 'Signal number (+15551234567)', group: 'signal', secret: false },
  { key: 'SIGNAL_CLI_PATH', label: 'signal-cli path (blank = PATH)', group: 'signal', secret: false },
  { key: 'EMAIL_USER', label: 'Email user', group: 'email', secret: false },
  { key: 'EMAIL_PASSWORD', label: 'Email password', group: 'email', secret: true },
  { key: 'EMAIL_IMAP_HOST', label: 'IMAP host', group: 'email', secret: false },
  { key: 'EMAIL_IMAP_PORT', label: 'IMAP port', group: 'email', secret: false },
  { key: 'EMAIL_SMTP_HOST', label: 'SMTP host', group: 'email', secret: false },
  { key: 'EMAIL_SMTP_PORT', label: 'SMTP port', group: 'email', secret: false },
  { key: 'EMAIL_FROM', label: 'From address (blank = user)', group: 'email', secret: false },
  { key: 'OPENAI_API_KEY', label: 'OpenAI API key (image gen + router)', group: 'plugins', secret: true },
  { key: 'OPENROUTER_API_KEY', label: 'OpenRouter API key (router)', group: 'plugins', secret: true },
  { key: 'TAVILY_API_KEY', label: 'Tavily API key (lets the local model web_search)', group: 'search', secret: true },
  { key: 'BRAVE_API_KEY', label: 'Brave Search API key (lets the local model web_search)', group: 'search', secret: true },
  { key: 'GOOGLE_AI_API_KEY', label: 'Google AI Studio key (free Gemini cloud tier)', group: 'providers', secret: true },
  { key: 'CEREBRAS_API_KEY', label: 'Cerebras key (free fast cloud tier)', group: 'providers', secret: true },
  { key: 'GROQ_API_KEY', label: 'Groq key (free fast cloud tier)', group: 'providers', secret: true },
  { key: 'MISTRAL_API_KEY', label: 'Mistral key (free cloud tier)', group: 'providers', secret: true },
  { key: 'DEEPSEEK_API_KEY', label: 'DeepSeek key (paid, very cheap)', group: 'providers', secret: true },
];

interface PersistedSettings {
  agentName?: string;
  model?: string;
  fastModel?: string;
  smartModel?: string;
  timezone?: string;
  permissionMode?: string;
  maxTurns?: number;
  maxConcurrent?: number;
  systemPromptAppend?: string;
  sandboxBackend?: string;
  localRouting?: 'off' | 'auto';
  localModel?: string;
  localContext?: number;
  localKeepAlive?: string;
  localTemp?: number;
  routeChain?: string[];
  lawsEnabled?: boolean;
  agentRestore?: boolean;
  channels?: Partial<Record<(typeof CHANNELS)[number], boolean>>;
  web?: { port?: number; bind?: string; authToken?: string };
  sandbox?: { dockerImage?: string; dockerContainer?: string; sshHost?: string; sshUser?: string; sshPort?: number; sshIdentity?: string };
  credentials?: Record<string, string>;
}

/**
 * Reads/writes ALL configurable settings for the web Settings panel.
 * - Engine fields (agent name, model, permission, etc.) apply LIVE (engine reads per-turn).
 * - Channels, credentials, web bind/port, sandbox docker/ssh need a RESTART/reload;
 *   they are persisted to settings.json and re-applied by loadConfig on boot.
 * - Secret fields are write-only: the browser sees only "set / not set".
 */
export class SettingsManager {
  private readonly file: string;
  private persisted: PersistedSettings;

  constructor(
    private readonly config: ZamolxisConfig,
    private readonly sandbox: SandboxManager,
    private readonly dataDir: string,
    /** Returns names of channels currently running (for the UI's "live" badge). */
    private readonly runningChannels?: () => string[],
    /** Curated memory store, so the panel can edit SOUL.md / USER.md and show MEMORY usage. */
    private readonly memory?: MemoryManager,
  ) {
    this.file = path.join(dataDir, 'settings.json');
    this.persisted = this.load();
  }

  private load(): PersistedSettings {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as PersistedSettings;
    } catch {
      return {};
    }
  }

  snapshot() {
    const credSet = (key: string): boolean => Boolean(process.env[key] || this.persisted.credentials?.[key]);
    const credVal = (key: string, secret: boolean): string =>
      secret ? '' : process.env[key] ?? this.persisted.credentials?.[key] ?? '';

    return {
      live: {
        agentName: this.config.agentName,
        model: this.config.model ?? '',
        fastModel: this.config.fastModel ?? '',
        smartModel: this.config.smartModel ?? '',
        timezone: this.config.timezone ?? '',
        permissionMode: this.config.permissionMode,
        maxTurns: this.config.maxTurns,
        maxConcurrent: this.config.maxConcurrent,
        systemPromptAppend: this.config.systemPromptAppend ?? '',
        sandboxBackend: this.sandbox.defaultBackend,
        localModel: this.config.localModel?.model ?? '',
        localContext: this.config.localContext ?? 0,
        localKeepAlive: this.config.localKeepAlive ?? '',
        localTemp: this.config.localTemp ?? null,
        localRouting: this.config.localRouting,
        routeChain: this.config.routeChain,
        lawsEnabled: this.config.lawsEnabled,
        agentRestore: this.config.agentRestore,
      },
      // Restart-required sections reflect the PERSISTED intent overlaid on the live
      // config, so a saved change stays shown even before the reload takes effect.
      channels: { ...this.config.channels, ...(this.persisted.channels ?? {}) },
      web: {
        port: this.persisted.web?.port ?? this.config.web.port,
        bind: this.persisted.web?.bind ?? this.config.web.bind,
        authTokenSet: Boolean(this.persisted.web?.authToken || this.config.web.authToken),
      },
      sandbox: {
        dockerImage: this.persisted.sandbox?.dockerImage ?? this.config.sandbox.docker?.image ?? '',
        dockerContainer: this.persisted.sandbox?.dockerContainer ?? this.config.sandbox.docker?.container ?? '',
        sshHost: this.persisted.sandbox?.sshHost ?? this.config.sandbox.ssh?.host ?? '',
        sshUser: this.persisted.sandbox?.sshUser ?? this.config.sandbox.ssh?.user ?? '',
        sshPort: this.persisted.sandbox?.sshPort ?? this.config.sandbox.ssh?.port ?? '',
        sshIdentity: this.persisted.sandbox?.sshIdentity ?? this.config.sandbox.ssh?.identity ?? '',
      },
      credentials: CRED_FIELDS.map((f) => ({ ...f, set: credSet(f.key), value: credVal(f.key, f.secret) })),
      identity: this.memory
        ? {
            laws: this.memory.getLaws(),
            soul: this.memory.getSoul(),
            user: this.memory.getUser(),
            userUsage: this.memory.userUsage(),
            memory: this.memory.list(),
            memoryUsage: this.memory.usage(),
            learnings: this.memory.learningsList(),
            learningsUsage: this.memory.learningsUsage(),
          }
        : null,
      running: this.runningChannels?.() ?? [],
      meta: {
        models: MODELS,
        permissionModes: PERMISSION_MODES,
        sandboxBackends: SANDBOX_BACKENDS,
        configuredBackends: this.sandbox.listConfigured(),
        channels: CHANNELS,
        searchProvider: searchProviderName(),
        dataDir: this.dataDir,
        restartNote: 'Channels, credentials, web bind/port, sandbox docker/ssh and maxConcurrent take effect on the next restart/reload.',
      },
    };
  }

  /**
   * Apply + persist. Engine fields take effect live; channel/credential/web/
   * sandbox changes need a reload. Returns the new snapshot plus whether any
   * restart-required section actually changed (so the UI can trigger a reload).
   */
  update(patch: Record<string, unknown>): { snapshot: ReturnType<SettingsManager['snapshot']>; restartRequired: boolean } {
    const p = this.persisted;
    const restartSig = () => JSON.stringify({ channels: p.channels, web: p.web, sandbox: p.sandbox, credentials: p.credentials });
    const before = restartSig();

    // ── live engine fields ──
    const live = (patch.live ?? {}) as Record<string, unknown>;
    if (typeof live.agentName === 'string') {
      // Allow letters/digits/spaces/most punctuation; strip only chars that could
      // break HTML/JS when the name is rendered into the page.
      const name = live.agentName.replace(/[<>'"`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (name) {
        this.config.agentName = name;
        p.agentName = name;
      }
    }
    if (typeof live.model === 'string') { this.config.model = live.model.trim() || undefined; p.model = live.model.trim(); }
    if (typeof live.fastModel === 'string') { this.config.fastModel = live.fastModel.trim() || undefined; p.fastModel = live.fastModel.trim(); }
    if (typeof live.smartModel === 'string') { this.config.smartModel = live.smartModel.trim() || undefined; p.smartModel = live.smartModel.trim(); }
    if (typeof live.timezone === 'string') { this.config.timezone = live.timezone.trim() || undefined; p.timezone = live.timezone.trim(); }
    if (typeof live.permissionMode === 'string' && (PERMISSION_MODES as readonly string[]).includes(live.permissionMode)) {
      this.config.permissionMode = live.permissionMode as ZamolxisConfig['permissionMode'];
      p.permissionMode = live.permissionMode;
    }
    if (typeof live.maxTurns === 'number' && live.maxTurns > 0) { this.config.maxTurns = Math.floor(live.maxTurns); p.maxTurns = this.config.maxTurns; }
    if (typeof live.maxConcurrent === 'number' && live.maxConcurrent > 0) { this.config.maxConcurrent = Math.floor(live.maxConcurrent); p.maxConcurrent = this.config.maxConcurrent; }
    if (typeof live.systemPromptAppend === 'string') { this.config.systemPromptAppend = live.systemPromptAppend.trim() || undefined; p.systemPromptAppend = live.systemPromptAppend.trim(); }
    if (typeof live.sandboxBackend === 'string' && this.sandbox.setDefaultBackend(live.sandboxBackend as BackendName)) {
      this.config.sandbox.backend = live.sandboxBackend as BackendName;
      p.sandboxBackend = live.sandboxBackend;
    }
    if (live.localRouting === 'off' || live.localRouting === 'auto') {
      this.config.localRouting = live.localRouting;
      p.localRouting = live.localRouting;
    }
    // Local model selection — applies LIVE (the engine reads config.localModel per turn). Setting a
    // model also ENABLES the local tier even if none was configured at boot (keeps the URL or default).
    if (typeof live.localModel === 'string') {
      const m = live.localModel.trim();
      if (m) {
        const url = this.config.localModel?.url || process.env.ZAMOLXIS_LOCAL_MODEL_URL || 'http://localhost:11434/v1';
        this.config.localModel = { url, model: m };
        p.localModel = m;
      }
    }
    if (typeof live.localContext === 'number' && live.localContext >= 0) {
      this.config.localContext = live.localContext > 0 ? Math.floor(live.localContext) : undefined;
      p.localContext = this.config.localContext;
    }
    if (typeof live.localKeepAlive === 'string') {
      this.config.localKeepAlive = live.localKeepAlive.trim() || undefined;
      p.localKeepAlive = this.config.localKeepAlive;
    }
    if (typeof live.localTemp === 'number' && live.localTemp >= 0) {
      this.config.localTemp = live.localTemp;
      p.localTemp = live.localTemp;
    } else if (live.localTemp === null) {
      this.config.localTemp = undefined;
      p.localTemp = undefined;
    }
    if (live.routeChain !== undefined) {
      // Accept an array or a comma-separated string of tier tokens.
      const raw = Array.isArray(live.routeChain) ? live.routeChain : String(live.routeChain).split(',');
      const chain = raw.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
      if (chain.length) {
        this.config.routeChain = chain;
        p.routeChain = chain;
      }
    }
    if (typeof live.lawsEnabled === 'boolean') {
      this.config.lawsEnabled = live.lawsEnabled;
      p.lawsEnabled = live.lawsEnabled;
    }
    if (typeof live.agentRestore === 'boolean') {
      this.config.agentRestore = live.agentRestore;
      p.agentRestore = live.agentRestore;
    }

    // ── identity: curated SOUL.md / USER.md (live; written to their own files) ──
    if (patch.identity && typeof patch.identity === 'object' && this.memory) {
      const id = patch.identity as Record<string, unknown>;
      if (id.resetLaws === true) this.memory.resetLaws();
      else if (typeof id.laws === 'string') this.memory.setLaws(id.laws);
      if (typeof id.soul === 'string') this.memory.setSoul(id.soul);
      if (typeof id.user === 'string') this.memory.setUser(id.user);
    }

    // ── channels (restart) ──
    if (patch.channels && typeof patch.channels === 'object') {
      p.channels = p.channels ?? {};
      for (const c of CHANNELS) {
        const v = (patch.channels as Record<string, unknown>)[c];
        if (typeof v === 'boolean') p.channels[c] = v;
      }
    }

    // ── web (restart) ──
    if (patch.web && typeof patch.web === 'object') {
      const w = patch.web as Record<string, unknown>;
      p.web = p.web ?? {};
      if (typeof w.port === 'number' && w.port > 0) p.web.port = Math.floor(w.port);
      if (typeof w.bind === 'string') p.web.bind = w.bind.trim();
      if (typeof w.authToken === 'string' && w.authToken !== '') p.web.authToken = w.authToken; // write-only: blank = keep
    }

    // ── sandbox docker/ssh (restart) ──
    if (patch.sandbox && typeof patch.sandbox === 'object') {
      const s = patch.sandbox as Record<string, unknown>;
      p.sandbox = p.sandbox ?? {};
      for (const k of ['dockerImage', 'dockerContainer', 'sshHost', 'sshUser', 'sshIdentity'] as const) {
        if (typeof s[k] === 'string') (p.sandbox as Record<string, unknown>)[k] = (s[k] as string).trim();
      }
      if (s.sshPort !== undefined && s.sshPort !== '') p.sandbox.sshPort = Number(s.sshPort);
    }

    // ── credentials (restart). Secret blank = keep existing; non-secret blank = clear. ──
    if (patch.credentials && typeof patch.credentials === 'object') {
      p.credentials = p.credentials ?? {};
      const incoming = patch.credentials as Record<string, unknown>;
      for (const f of CRED_FIELDS) {
        if (!(f.key in incoming)) continue;
        const v = incoming[f.key];
        if (typeof v !== 'string') continue;
        if (f.secret && v === '') continue; // don't clobber a secret with a blank
        p.credentials[f.key] = v;
        // Apply to the live environment too, so it takes effect WITHOUT a restart. This matters
        // for CLAUDE_CODE_OAUTH_TOKEN especially: the engine reads process.env per turn, so the
        // subscription token works on the very next message (no .env editing, no restart).
        process.env[f.key] = v;
      }
    }

    this.persist();
    const restartRequired = restartSig() !== before;
    logger.info({ restartRequired }, 'settings updated via web');
    return { snapshot: this.snapshot(), restartRequired };
  }

  private persist(): void {
    fs.writeFileSync(this.file, JSON.stringify(this.persisted, null, 2));
  }
}
