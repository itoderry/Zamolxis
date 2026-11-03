import { randomBytes } from 'node:crypto';
import type { ZamolxisConfig } from '../../config.js';
import { engineEnv, credentialsPresent, oauthExpiry } from '../auth.js';
import { freeProviderPool, providerById, providerConfigured, providerModel, type ProviderDef } from '../providers.js';
import { resolveClaudeModel } from '../claudeModels.js';

/**
 * Model backends for delegated Claude Code runs (both the SDK code runner and the headless CLI).
 *
 *  - claude: the user's subscription, exactly like the chat's Claude tier (engineEnv()).
 *  - local:  Ollama, which speaks the Anthropic Messages API at its root URL, so Claude Code
 *            talks to it directly through ANTHROPIC_BASE_URL.
 *  - free:   a free OpenAI-compatible provider, reached through Zamolxis's own Anthropic -> OpenAI
 *            translator (anthropicProxy.ts) mounted on the web channel at /anthropic/<providerId>.
 *
 * One env builder serves both paths so a backend behaves the same whichever runner uses it.
 */
export type CodeBackend = 'claude' | 'free' | 'local';
export type BackendPref = 'auto' | CodeBackend;

/** Per-process secret the translator requires (x-api-key or Bearer). Never persisted or shown. */
export const PROXY_SECRET = randomBytes(24).toString('hex');

/** Below this context window Claude Code's own system prompt + tool list barely fits. */
export const MIN_CODE_CONTEXT = 32_768;

export interface BackendStatus {
  id: CodeBackend;
  usable: boolean;
  /** Why it is not usable. */
  reason?: string;
  /** Model the backend would run. */
  model?: string;
  /** free: which provider would answer. */
  provider?: string;
  /** Non-fatal concern, e.g. a local model whose context is too small for Claude Code. */
  warning?: string;
  /** local: the model's context is known to be below MIN_CODE_CONTEXT (not "capable" for auto-pick). */
  lowContext?: boolean;
  /** local: models installed in Ollama (for the Settings picker). */
  installed?: string[];
}

export interface BackendEnv {
  backend: CodeBackend;
  /** Model name passed to Claude Code (undefined = its default, Claude backend only). */
  model?: string;
  env: NodeJS.ProcessEnv;
  /** Human label for replies and the runs ledger, e.g. "Claude (opus)", "Groq (llama-3.3-70b)". */
  label: string;
  providerId?: string;
}

/** Native Ollama root (the OpenAI-compat URL minus /v1), where its Anthropic API lives. */
export function ollamaRoot(config: ZamolxisConfig): string {
  const u = config.localModel?.url || process.env.ZAMOLXIS_LOCAL_MODEL_URL || 'http://localhost:11434/v1';
  return u.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
}

/** The Ollama model delegated runs use: the Code setting, else the chat's local model. */
export function codeLocalModel(config: ZamolxisConfig): string | undefined {
  return config.codeLocalModel || config.localModel?.model || undefined;
}

/** Is this a Claude model name (alias or id), as opposed to a routing token or another vendor's model? */
export function isClaudeModelName(m?: string): boolean {
  const x = (m || '').trim().toLowerCase();
  return !!x && (x === 'claude' || /opus|sonnet|haiku|fable/.test(x) || x.startsWith('claude'));
}

/** The Claude model delegated runs use on the subscription (override, primary model, else smartest). */
export function claudeCodeModel(config: ZamolxisConfig, override?: string): string | undefined {
  if (override && isClaudeModelName(override)) return override === 'claude' ? undefined : override;
  if (isClaudeModelName(config.model)) return config.model;
  if (isClaudeModelName(config.smartModel)) return config.smartModel;
  return undefined;
}

/** Base URL of the translator for a provider, or null when the web channel can't serve it on loopback. */
export function proxyBaseUrl(config: ZamolxisConfig, providerId: string): string | null {
  if (!config.channels.web) return null;
  const bind = (config.web.bind || '127.0.0.1').trim();
  let host: string;
  if (bind === '127.0.0.1' || bind === 'localhost' || bind === '0.0.0.0') host = '127.0.0.1';
  else if (bind === '::1' || bind === '::') host = '[::1]';
  else return null; // bound to a LAN address only: the loopback-only route is unreachable
  return `http://${host}:${config.web.port}/anthropic/${encodeURIComponent(providerId)}`;
}

/** Strong free providers that still have quota today, least-used first. */
export function strongFreeProviders(): ProviderDef[] {
  return freeProviderPool({ strongOnly: true }).filter((p) => p.strong);
}

/** Workers (which may run shell commands, possibly driven by a free or local model) must not see
 *  the keys Zamolxis holds for providers, channels and integrations. Strip anything that looks like
 *  a credential; each backend then adds back only what it needs. */
const SECRET_ENV = /(API_KEY|_TOKEN|_SECRET|PASSWORD|PASSWD|_PAT|APP_PASSWORD)$/i;
const KEEP_ENV = new Set(['CLAUDE_CODE_OAUTH_TOKEN']); // the subscription login, Claude backend only
function scrubbedEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!SECRET_ENV.test(k) || KEEP_ENV.has(k)) env[k] = v;
  return env;
}

/** Environment for a non-Claude backend: point Claude Code at another Anthropic-compatible URL and
 *  map every model slot (main, small/fast, haiku/sonnet/opus, subagents) to the same model so no
 *  background call silently goes to Anthropic. The subscription token and any API key are removed. */
function redirectedEnv(baseUrl: string, token: string, model: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = scrubbedEnv(process.env);
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  env.ANTHROPIC_BASE_URL = baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = token;
  env.ANTHROPIC_MODEL = model;
  env.ANTHROPIC_SMALL_FAST_MODEL = model;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
  env.CLAUDE_CODE_SUBAGENT_MODEL = model;
  // No telemetry, update checks or error reporting to Anthropic from a run that is meant to stay
  // on another backend (and, in Privacy Mode, on this machine).
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  env.DISABLE_TELEMETRY = '1';
  env.DISABLE_ERROR_REPORTING = '1';
  env.DISABLE_AUTOUPDATER = '1';
  return env;
}

/** Build the env + model for one run on a backend. Returns { error } when it can't. */
export function backendEnv(
  config: ZamolxisConfig,
  backend: CodeBackend,
  opts?: { model?: string; providerId?: string },
): BackendEnv | { error: string } {
  if (backend === 'claude') {
    if (config.privacyMode) return { error: 'Privacy Mode is on, so Claude cannot be used' };
    const model = claudeCodeModel(config, opts?.model);
    return { backend, model, env: scrubbedEnv(engineEnv()), label: `Claude (${resolveClaudeModel(model) || 'default'})` };
  }
  if (backend === 'local') {
    const model = (opts?.model && !isClaudeModelName(opts.model) ? opts.model : undefined) || codeLocalModel(config);
    if (!model) return { error: 'no local model is set (Settings -> Code, or the Local model app)' };
    return { backend, model, env: redirectedEnv(ollamaRoot(config), 'ollama', model), label: `Local (${model})` };
  }
  if (config.privacyMode) return { error: 'Privacy Mode is on, so cloud providers cannot be used' };
  const p = opts?.providerId ? providerById(opts.providerId) : strongFreeProviders()[0];
  if (!p) return { error: 'no strong free provider is configured with quota left today' };
  if (!providerConfigured(p)) return { error: `the ${p.label} key (or a required value such as an account id) is missing` };
  const base = proxyBaseUrl(config, p.id);
  if (!base) return { error: 'the free backend needs the web channel listening on a loopback address' };
  const model = opts?.model && !isClaudeModelName(opts.model) ? opts.model : providerModel(p);
  return { backend: 'free', model, env: redirectedEnv(base, PROXY_SECRET, model), label: `${p.label} (${model})`, providerId: p.id };
}

/** Context window info for an Ollama model (best-effort; fields undefined when unknown). */
async function ollamaContext(root: string, model: string): Promise<{ max?: number; numCtx?: number }> {
  try {
    const r = await fetch(root + '/api/show', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return {};
    const d = (await r.json()) as { model_info?: Record<string, unknown>; parameters?: string };
    let max: number | undefined;
    for (const [k, v] of Object.entries(d.model_info ?? {})) if (/\.context_length$/.test(k) && typeof v === 'number') max = v;
    const m = /(?:^|\n)\s*num_ctx\s+(\d+)/.exec(d.parameters ?? '');
    return { max, numCtx: m ? Number(m[1]) : undefined };
  } catch {
    return {};
  }
}

/** Probe the local backend: Ollama reachable, model installed, context big enough. */
async function localStatus(config: ZamolxisConfig): Promise<BackendStatus> {
  const model = codeLocalModel(config);
  const root = ollamaRoot(config);
  let installed: string[] = [];
  try {
    const r = await fetch(root + '/api/tags', { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return { id: 'local', usable: false, model, reason: `Ollama answered HTTP ${r.status} at ${root}` };
    const d = (await r.json()) as { models?: Array<{ name: string }> };
    installed = (d.models ?? []).map((m) => m.name);
  } catch {
    return { id: 'local', usable: false, model, reason: `Ollama is not reachable at ${root}` };
  }
  if (!model) return { id: 'local', usable: false, installed, reason: 'no local model is set' };
  const has = installed.some((n) => n === model || n === model + ':latest' || (!model.includes(':') && n.startsWith(model + ':')));
  if (!has) return { id: 'local', usable: false, model, installed, reason: `model "${model}" is not installed in Ollama` };
  const ctx = await ollamaContext(root, model);
  // Recent Ollama (0.40+) loads models with a large default context (131072 was observed for
  // hermes3:8b), so only warn when a SMALL limit is actually known: the model's maximum, its
  // num_ctx parameter, or an OLLAMA_CONTEXT_LENGTH set below the minimum.
  const envCtx = Number(process.env.OLLAMA_CONTEXT_LENGTH) || 0;
  let warning: string | undefined;
  const lowContext = !!((ctx.max && ctx.max < MIN_CODE_CONTEXT) || (ctx.numCtx && ctx.numCtx < MIN_CODE_CONTEXT));
  if (ctx.max && ctx.max < MIN_CODE_CONTEXT) warning = `${model} supports only ${ctx.max} tokens of context; Claude Code needs about ${MIN_CODE_CONTEXT}. Expect failures.`;
  else if (ctx.numCtx && ctx.numCtx < MIN_CODE_CONTEXT) warning = `${model} is set to num_ctx ${ctx.numCtx}; Claude Code needs about ${MIN_CODE_CONTEXT}. Raise it (e.g. OLLAMA_CONTEXT_LENGTH=${MIN_CODE_CONTEXT}).`;
  else if (!ctx.numCtx && envCtx && envCtx < MIN_CODE_CONTEXT) warning = `OLLAMA_CONTEXT_LENGTH is ${envCtx} here; Claude Code needs about ${MIN_CODE_CONTEXT}. If Ollama runs with it, raise it.`;
  return { id: 'local', usable: true, model, installed, warning, lowContext };
}

/** What is usable right now for delegated runs (credentials, Ollama + model, free provider, Privacy Mode). */
export async function availableBackends(config: ZamolxisConfig): Promise<BackendStatus[]> {
  const out: BackendStatus[] = [];
  if (config.privacyMode) out.push({ id: 'claude', usable: false, reason: 'Privacy Mode is on' });
  else if (!credentialsPresent()) out.push({ id: 'claude', usable: false, reason: 'Claude is not logged in (run claude auth login)' });
  else if (oauthExpiry()?.expired) out.push({ id: 'claude', usable: false, reason: 'the Claude login expired (run claude auth login)' });
  else out.push({ id: 'claude', usable: true, model: claudeCodeModel(config) || 'default' });

  if (config.privacyMode) out.push({ id: 'free', usable: false, reason: 'Privacy Mode is on' });
  else {
    const p = strongFreeProviders()[0];
    if (!p) out.push({ id: 'free', usable: false, reason: 'no strong free provider is configured with quota left today' });
    else if (!proxyBaseUrl(config, p.id)) out.push({ id: 'free', usable: false, provider: p.id, reason: 'needs the web channel listening on a loopback address' });
    else out.push({ id: 'free', usable: true, provider: p.id, model: providerModel(p), warning: 'Free models drive Claude Code less reliably than Claude; best for small jobs.' });
  }

  out.push(await localStatus(config));
  return out;
}
