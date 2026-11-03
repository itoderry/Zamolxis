import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';
import { pushNotif } from './notifications.js';

/**
 * Free, OpenAI-compatible cloud LLM providers. The engine rotates across the ones
 * the user has configured a (free-tier) key for, skipping any that hit their daily
 * cap, to maximize free usage before touching the Claude subscription. Each is
 * OpenAI chat-completions compatible (same tool-call protocol as the local loop).
 */
export interface ProviderDef {
  id: string;
  label: string;
  kind: 'free' | 'paid';
  /** OpenAI-compatible base (we POST `${baseUrl}/chat/completions`). May hold `{ENV_NAME}`
   *  placeholders, resolved from process.env at call time (see providerBaseUrl). */
  baseUrl: string;
  /** Default model; the user can override it per provider (Settings -> Providers -> Model). */
  model: string;
  envKey: string;
  freeDaily: number; // approximate free requests/day (rotation + UI); paid = effectively unlimited
  signup: string;
  note: string;
  /** Capable enough (large/frontier + good tool use) to be trusted with current/live FACT
   *  lookups. Weaker free models (e.g. mistral-small) are excluded from those. */
  strong?: boolean;
  /** Accepts image inputs (multimodal) via the OpenAI-compatible image_url content block. */
  vision?: boolean;
  /** Works without a key (anonymous, rate-limited). Opt-in: without a key it counts as configured
   *  only once the user enabled keyless use (settings `keylessProviders`). The Authorization header
   *  is sent only when a key is set (the key just raises the limits). */
  keyOptional?: boolean;
  /** Further required values besides the key (e.g. an account id used in the base URL). */
  extraKeys?: Array<{ env: string; label: string; secret?: boolean }>;
  /** Known free models to try first when the configured one is retired or not on the user's plan
   *  (some providers leave their free models out of /models, e.g. Z.ai's GLM flash models). */
  fallbackModels?: string[];
}

export const PROVIDERS: ProviderDef[] = [
  // ── Free tiers (rotated; one key per provider) ──
  { id: 'google', label: 'Google AI Studio (Gemini)', kind: 'free', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', envKey: 'GOOGLE_AI_API_KEY', freeDaily: 1500, signup: 'https://aistudio.google.com/apikey', note: 'Frontier-class Gemini 2.5 Flash. ~1,500 req/day free. Handles images (vision).', strong: true, vision: true },
  { id: 'cerebras', label: 'Cerebras', kind: 'free', baseUrl: 'https://api.cerebras.ai/v1', model: 'gpt-oss-120b', envKey: 'CEREBRAS_API_KEY', freeDaily: 1400, signup: 'https://cloud.cerebras.ai/', note: 'Ultra-fast gpt-oss-120b. Free access is now trial credit and needs a card on file; a key without credit gets HTTP 402 (payment required).', strong: true },
  { id: 'groq', label: 'Groq', kind: 'free', baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', envKey: 'GROQ_API_KEY', freeDaily: 1000, signup: 'https://console.groq.com/keys', note: 'Fastest free option (gpt-oss-120b); tight per-minute limits.', strong: true },
  { id: 'openrouter', label: 'OpenRouter (free models)', kind: 'free', baseUrl: 'https://openrouter.ai/api/v1', model: 'nvidia/nemotron-3.5-super-vl:free', envKey: 'OPENROUTER_API_KEY', freeDaily: 200, signup: 'https://openrouter.ai/keys', note: 'Many :free models behind one key. ~200 req/day. The :free list changes often; if this one stops working, set another :free model under Model.', strong: true },
  { id: 'mistral', label: 'Mistral', kind: 'free', baseUrl: 'https://api.mistral.ai/v1', model: 'ministral-14b-latest', envKey: 'MISTRAL_API_KEY', freeDaily: 500, signup: 'https://console.mistral.ai/', note: 'Free Ministral 14B (30 req/min). Free limits are per model: on free plans Mistral Small/Medium can have a 0 req/min limit (every call 429). Not used for live-fact lookups.', fallbackModels: ['ministral-14b-latest', 'ministral-8b-latest', 'codestral-latest'] },
  { id: 'nvidia', label: 'NVIDIA NIM', kind: 'free', baseUrl: 'https://integrate.api.nvidia.com/v1', model: 'nvidia/nemotron-3-ultra-550b-a55b', envKey: 'NVIDIA_API_KEY', freeDaily: 1000, signup: 'https://build.nvidia.com/', note: '100+ open models, free credits, no card. OpenAI-compatible (Nemotron 3 Ultra by default).', strong: true },
  { id: 'sambanova', label: 'SambaNova', kind: 'free', baseUrl: 'https://api.sambanova.ai/v1', model: 'Meta-Llama-3.3-70B-Instruct', envKey: 'SAMBANOVA_API_KEY', freeDaily: 500, signup: 'https://cloud.sambanova.ai/', note: 'Very fast (Llama 3.3 70B). OpenAI-compatible. The free plan reportedly needs a payment method on file since Sept 2026.', strong: true },
  { id: 'ollama-cloud', label: 'Ollama Cloud (free tier)', kind: 'free', baseUrl: 'https://ollama.com/v1', model: 'gpt-oss:120b', envKey: 'OLLAMA_API_KEY', freeDaily: 1000, signup: 'https://ollama.com/settings/keys', note: 'Hosted big models (gpt-oss:120b) on Ollama\'s free cloud tier — no local GPU needed. Sign in at ollama.com, create an API key. OpenAI-compatible. Distinct from the local Ollama models tier.', strong: true },
  { id: 'ovh', label: 'OVHcloud AI Endpoints', kind: 'free', baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', model: 'gpt-oss-120b', envKey: 'OVH_AI_ENDPOINTS_ACCESS_TOKEN', freeDaily: 300, signup: 'https://endpoints.ai.cloud.ovh.net/', note: 'gpt-oss-120b in the EU. Can work WITHOUT a key once you turn on "Use without a key" (requests then go to OVHcloud anonymously, about 2 requests/min per IP per model); an optional access token raises the limits.', strong: true, keyOptional: true },
  { id: 'zai', label: 'Z.ai (GLM)', kind: 'free', baseUrl: 'https://api.z.ai/api/paas/v4', model: 'glm-4.7-flash', envKey: 'ZAI_API_KEY', freeDaily: 500, signup: 'https://z.ai/manage-apikey/apikey-list', note: 'GLM-4.7 Flash on the free tier (one request at a time; briefly "overloaded" at busy times, retried automatically). Other GLM models need a paid balance. OpenAI-compatible.', fallbackModels: ['glm-4.7-flash', 'glm-4.5-flash'] },
  { id: 'cloudflare', label: 'Cloudflare Workers AI', kind: 'free', baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1', model: '@cf/openai/gpt-oss-120b', envKey: 'CLOUDFLARE_API_TOKEN', freeDaily: 300, signup: 'https://dash.cloudflare.com/profile/api-tokens', note: '10,000 Neurons/day free (about 300k input tokens of gpt-oss-120b). Needs an API token with Workers AI permission plus your Account ID.', strong: true, extraKeys: [{ env: 'CLOUDFLARE_ACCOUNT_ID', label: 'Account ID', secret: false }] },
  // ── Paid (metered; used only if you add them to the routing order) ──
  { id: 'openai', label: 'OpenAI', kind: 'paid', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini', envKey: 'OPENAI_API_KEY', freeDaily: 1_000_000, signup: 'https://platform.openai.com/api-keys', note: 'Paid (gpt-5-mini by default — cheap + capable). Billed to your OpenAI account.' },
  { id: 'deepseek', label: 'DeepSeek', kind: 'paid', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', envKey: 'DEEPSEEK_API_KEY', freeDaily: 1_000_000, signup: 'https://platform.deepseek.com/', note: 'Paid but very cheap (deepseek-chat). Billed to your DeepSeek account.' },
  { id: 'perplexity', label: 'Perplexity (Sonar)', kind: 'paid', baseUrl: 'https://api.perplexity.ai', model: 'sonar', envKey: 'PERPLEXITY_API_KEY', freeDaily: 1_000_000, signup: 'https://www.perplexity.ai/settings/api', note: 'Search-grounded answers. NOT a free tier — pay per token + per-request search fees (trial credits + $5/mo for Pro). Added as paid so it is not auto-used.' },
];

export function providerById(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

// ── Endpoint, key and model resolution ──

/** The provider's base URL with `{ENV_NAME}` placeholders filled from process.env (no trailing
 *  slash), or null while a placeholder is unset (the provider is then not configured). */
export function providerBaseUrl(p: ProviderDef): string | null {
  let missing = false;
  const url = p.baseUrl.replace(/\{([A-Z0-9_]+)\}/g, (_m, name: string) => {
    const v = (process.env[name] || '').trim();
    if (!v) missing = true;
    return encodeURIComponent(v);
  });
  return missing ? null : url.replace(/\/+$/, '');
}

/** The provider's API key, if one is set. */
export function providerKey(p: ProviderDef): string | undefined {
  return (process.env[p.envKey] || '').trim() || undefined;
}

/** Authorization header for a provider call: only when a key exists (keyOptional providers
 *  are called anonymously without one). */
export function providerAuthHeaders(p: ProviderDef): Record<string, string> {
  const key = providerKey(p);
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/** keyOptional providers the user enabled for anonymous use (settings `keylessProviders`). */
let keylessOn = new Set<string>();

/** Apply the live list of keyOptional providers allowed to run without a key. */
export function setKeylessProviders(ids: string[] | undefined): void {
  keylessOn = new Set((ids ?? []).filter((id) => !!providerById(id)?.keyOptional));
}

export function getKeylessProviders(): string[] {
  return [...keylessOn];
}

/** Usable: base URL resolves, extra values set, and a key is present (or, for a keyOptional
 *  provider, keyless use was enabled by the user: requests then go out anonymously). */
export function providerConfigured(p: ProviderDef): boolean {
  if (!providerBaseUrl(p)) return false;
  if ((p.extraKeys ?? []).some((k) => !(process.env[k.env] || '').trim())) return false;
  return Boolean(providerKey(p)) || (!!p.keyOptional && keylessOn.has(p.id));
}

/** Ollama/OpenAI-style model names: letters, digits and . _ : / @ + - only. */
export const MODEL_NAME_RE = /^[\w.:/@+-]{1,200}$/;

let modelOverrides: Record<string, string> = {};
/** Providers whose override was picked by auto-correction, not by the user (settings
 *  `providerModelsAuto`, so this survives a restart). */
let autoPicked = new Set<string>();
/** Saves an auto-corrected model (registered by the settings store, which also records it as
 *  automatic). */
let modelPersister: ((id: string, model: string) => void) | null = null;
/** Models replaced by auto-correction, per provider: old name -> new name (so a running Claude
 *  Code worker that still asks for the old name gets the new one through the translator). */
const replacedModels = new Map<string, Map<string, string>>();

/** Apply the live per-provider model overrides (settings `providerModels`). */
export function setProviderModels(map: Record<string, string> | undefined): void {
  const next: Record<string, string> = {};
  for (const [id, m] of Object.entries(map ?? {})) {
    const v = typeof m === 'string' ? m.trim() : '';
    if (v && providerById(id) && MODEL_NAME_RE.test(v)) next[id] = v;
  }
  modelOverrides = next;
}

export function getProviderModels(): Record<string, string> {
  return { ...modelOverrides };
}

/** Apply the live list of providers whose model override was set automatically. */
export function setProviderModelsAuto(ids: string[] | undefined): void {
  autoPicked = new Set((ids ?? []).filter((id) => !!providerById(id)));
}

export function getProviderModelsAuto(): string[] {
  return [...autoPicked];
}

export function setProviderModelPersister(fn: ((id: string, model: string) => void) | null): void {
  modelPersister = fn;
}

/** The model a provider is called with: the user's (or auto-corrected) override, else the default. */
export function providerModel(p: ProviderDef): string {
  return modelOverrides[p.id] || p.model;
}

/** Map a model name a caller asked for to the current one if auto-correction replaced it. */
export function currentModelFor(id: string, requested: string): string {
  return replacedModels.get(id)?.get(requested) ?? requested;
}

// ── Daily usage ──

interface UsageState {
  date: string;
  used: Record<string, number>;
}
let file = '';
let state: UsageState = { date: '', used: {} };

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function rollover(): void {
  if (state.date !== today()) {
    state = { date: today(), used: {} };
    persist();
  }
}
function persist(): void {
  if (!file) return;
  try {
    fs.writeFileSync(file, JSON.stringify(state));
  } catch (err) {
    logger.warn({ err: String(err) }, 'providers usage persist failed');
  }
}

/** Call once at startup so daily usage survives restarts (within the same day). */
export function initProviders(dataDir: string): void {
  file = path.join(dataDir, 'providers.json');
  try {
    const f = JSON.parse(fs.readFileSync(file, 'utf8')) as UsageState;
    if (f && f.used) state = f;
  } catch {
    /* none yet */
  }
  rollover();
}

/** Count one SUCCESSFUL call toward the provider's daily quota (failed calls are not counted). */
export function recordProviderUse(id: string): void {
  rollover();
  state.used[id] = (state.used[id] ?? 0) + 1;
  persist();
}

// ── Health (in memory): a provider that keeps failing is cooled down instead of tried first ──

/** model-blocked: the model exists but is not on the user's plan (a paid model on a free key, or a
 *  0 requests/min limit), so another model may work. overloaded: the provider is briefly busy
 *  (seconds), so retry soon instead of benching it. */
export type FailureKind = 'model-gone' | 'model-blocked' | 'model-not-enabled' | 'key-invalid' | 'payment-required' | 'forbidden' | 'rate-limited' | 'overloaded' | 'failing';

/** Rate-limit headers of a response (lower-cased names), kept for classification. */
export type RateHeaders = Record<string, string>;
export function rateHeadersOf(h: Headers | undefined | null): RateHeaders {
  const o: RateHeaders = {};
  if (!h) return o;
  h.forEach((v, k) => {
    if (/ratelimit|retry-after/i.test(k)) o[k.toLowerCase()] = v;
  });
  return o;
}

interface Health {
  lastError?: string;
  lastStatus?: number;
  kind?: FailureKind;
  at?: number;
  cooldownUntil?: number;
}
const health = new Map<string, Health>();

export const HARD_COOLDOWN_MS = 6 * 60 * 60 * 1000;
export const RATE_COOLDOWN_MS = 2 * 60 * 1000;
/** A briefly overloaded provider (still failing after the quick retries) is skipped this long. */
export const OVERLOAD_COOLDOWN_MS = 15 * 1000;
/** Quick retries of an "overloaded" answer before giving up on this call (waits in ms). */
export const OVERLOAD_RETRY_DELAYS_MS = [3000, 6000];
const HARD_STATUSES = new Set([401, 402, 403, 404, 410]);

/** Wording providers use when the requested MODEL is gone (retired, renamed, no longer free). It
 *  must be about the model: error codes, "invalid/unknown model", or "model ... not found" in the
 *  same sentence. A bare "404 page not found" (wrong base URL, missing route) does not count. */
const GONE_WORDS = 'does not exist|not found|no longer (?:available|supported)|end of life|unavailable for free|decommissioned|deprecated|retired|not available';
const MODEL_GONE_RE = new RegExp(String.raw`model_not_found|model_decommissioned|model_deprecated|(?:invalid|unknown|no such)[ _]model|\bmodel\b(?:(?!\.\s)[^\n]){0,160}?(?:${GONE_WORDS})`, 'i');
/** NVIDIA: the model exists but is not enabled for this account (skip it, the provider is fine). */
const NOT_ENABLED_RE = /not found for account/i;
/** OpenRouter's privacy/guardrail 404 ("No endpoints found matching your data policy"): an
 *  account setting, not a retired model. */
const ACCOUNT_POLICY_RE = /data policy|guardrail|privacy/i;
/** The provider is busy for a moment (Z.ai code 1305 "The service may be temporarily overloaded,
 *  please try again later", and the usual "overloaded / high demand / at capacity" wordings). */
const OVERLOADED_RE = /["\s:]1305\b|overload|high demand|at capacity|server is busy|temporarily unavailable/i;
/** This model needs money the free key doesn't have, while other models on the key may be free
 *  (Z.ai code 1113 "Insufficient balance or no resource package. Please recharge."). Account-wide
 *  billing (HTTP 402, e.g. Cerebras) stays payment-required. */
const MODEL_PAID_RE = /["\s:]1113\b|insufficient balance|no resource package|please recharge|not (?:available|included) (?:on|in) (?:your|the) (?:free|current) (?:plan|tier)/i;
/** A per-model limit of zero (Mistral free plans report x-ratelimit-limit-req-minute: 0 for models
 *  they don't include): every call is refused, waiting won't help. */
function zeroLimit(h?: RateHeaders): boolean {
  if (!h) return false;
  return Object.entries(h).some(([k, v]) => /^x-ratelimit-limit-(req|requests|tokens)/.test(k) && v.trim() === '0');
}

/** Some providers echo a masked fragment of the key ("Incorrect API key provided: ab12cd*****ef34");
 *  keep even that out of the UI and logs. */
const redactKeyBits = (s: string): string => s.replace(/[\w-]{2,}\*{3,}[\w-]*/g, '[redacted]');

/** Short human text from a provider error body (JSON `error.message` / `message`, else raw). */
export function errorText(body: string): string {
  const raw = (body || '').trim();
  try {
    const j = JSON.parse(raw) as unknown;
    const o = (Array.isArray(j) ? j[0] : j) as Record<string, unknown> | undefined;
    const e = o?.error;
    const msg = typeof e === 'string' ? e : e && typeof e === 'object' ? (e as Record<string, unknown>).message : o?.message ?? o?.detail;
    if (typeof msg === 'string' && msg.trim()) return redactKeyBits(msg.trim()).slice(0, 300);
  } catch {
    /* not JSON */
  }
  return redactKeyBits(raw.replace(/\s+/g, ' ')).slice(0, 300);
}

/** Classify a failed provider call. Model-gone is distinct from key/billing problems: only it
 *  triggers auto-correction of the model. `model` (the name that was requested) also lets an
 *  error that names it count (OpenRouter: "No endpoints found for <model>"). */
export function classifyFailure(status: number, body = '', model?: string, headers?: RateHeaders): FailureKind {
  if (status === 401) return 'key-invalid';
  if (status === 402) return 'payment-required';
  if (status === 429 || status === 400 || status === 403) {
    if (zeroLimit(headers)) return 'model-blocked';
    if (MODEL_PAID_RE.test(body)) return 'model-blocked';
  }
  if (status === 503 || status === 529 || ((status === 429 || status === 500) && OVERLOADED_RE.test(body))) return 'overloaded';
  if (status === 429) return 'rate-limited';
  if (status === 403) return 'forbidden';
  if (status !== 400 && status !== 404 && status !== 410) return 'failing';
  if (NOT_ENABLED_RE.test(body)) return 'model-not-enabled';
  if (ACCOUNT_POLICY_RE.test(body)) return 'failing';
  if (MODEL_GONE_RE.test(body)) return 'model-gone';
  if (status !== 400 && model && body.includes(model) && /no endpoints found for|not found|no longer available/i.test(body)) return 'model-gone';
  return 'failing';
}

/** Record a failed call. Hard failures (401/402/403/404/410, a retired model, or a model not on
 *  the plan) cool the provider down for 6 hours (auto-correction clears it on success), a rate
 *  limit for 2 minutes, a brief overload for 15 seconds; other errors (5xx, network) are only
 *  recorded. */
export function markProviderFailure(id: string, status: number, body = '', reason?: string, model?: string, headers?: RateHeaders): FailureKind {
  const kind = status > 0 ? classifyFailure(status, body, model, headers) : 'failing';
  const now = Date.now();
  const h: Health = { ...(health.get(id) ?? {}), lastStatus: status, kind, at: now };
  const msg = errorText(body);
  const blockedNote = kind === 'model-blocked' ? (zeroLimit(headers) ? ' (this model has a 0 requests/min limit on your plan)' : ' (this model is not on your plan)') : '';
  h.lastError = reason ?? (status > 0 ? `HTTP ${status}${msg ? ': ' + msg.slice(0, 160) : ''}${blockedNote}` : msg || 'unreachable');
  if (kind === 'overloaded') h.cooldownUntil = now + OVERLOAD_COOLDOWN_MS;
  else if (HARD_STATUSES.has(status) || kind === 'model-gone' || kind === 'model-blocked') h.cooldownUntil = now + HARD_COOLDOWN_MS;
  else if (status === 429) h.cooldownUntil = now + RATE_COOLDOWN_MS;
  health.set(id, h);
  logger.warn({ provider: id, status, kind, cooldownUntil: h.cooldownUntil }, 'provider call failed');
  return kind;
}

/** Cool a provider down with a reason of our own (e.g. no working replacement model found). */
function coolDown(id: string, reason: string, kind: FailureKind = 'model-gone', ms = HARD_COOLDOWN_MS): void {
  const h: Health = { ...(health.get(id) ?? {}), lastError: reason, kind, at: Date.now(), cooldownUntil: Date.now() + ms };
  health.set(id, h);
}

/** A call worked: clear the failure state. */
export function markProviderOk(id: string): void {
  if (health.has(id)) health.delete(id);
}

/** Forget the failure state of providers that use this credential (a new key was saved). */
export function resetProviderHealthForEnv(envName: string): void {
  for (const p of PROVIDERS) if (p.envKey === envName || (p.extraKeys ?? []).some((k) => k.env === envName)) health.delete(p.id);
}

export function providerCoolingDown(id: string): boolean {
  const until = health.get(id)?.cooldownUntil;
  return !!until && until > Date.now();
}

export function providerHealth(id: string): Health | undefined {
  const h = health.get(id);
  return h ? { ...h } : undefined;
}

// ── Pools ──

/** Providers that are usable (key or keyless access, base URL resolvable). */
export function configuredProviders(): ProviderDef[] {
  return PROVIDERS.filter(providerConfigured);
}

/** Configured FREE providers with quota left today and not cooling down after failures, ordered
 *  least-used first (rotation). With { strongOnly }, restrict to capable providers (for
 *  current/live FACT lookups) so a weak model like mistral-small never answers those — falls back
 *  to any free if none strong. */
export function freeProviderPool(opts?: { strongOnly?: boolean }): ProviderDef[] {
  rollover();
  let avail = configuredProviders().filter((p) => p.kind === 'free' && (state.used[p.id] ?? 0) < p.freeDaily && !providerCoolingDown(p.id));
  if (opts?.strongOnly) {
    const strong = avail.filter((p) => p.strong);
    if (strong.length) avail = strong;
  }
  return avail.sort((a, b) => (state.used[a.id] ?? 0) / a.freeDaily - (state.used[b.id] ?? 0) / b.freeDaily);
}

/** The single best free provider to try next (least-used / strong-first). */
export function pickFreeProvider(opts?: { strongOnly?: boolean }): ProviderDef | null {
  return freeProviderPool(opts)[0] ?? null;
}

// ── Model probing + auto-correction of retired models ──

export interface ProbeResult {
  ok: boolean;
  tools: boolean;
  ms: number;
  status?: number;
  kind?: FailureKind;
  error?: string;
  body?: string;
  headers?: RateHeaders;
}

const PROBE_TIMEOUT_MS = 20_000;

type ChatCallResult = { status: number; body: string; data?: Record<string, unknown>; headers?: RateHeaders };

async function chatCallOnce(p: ProviderDef, base: string, payload: Record<string, unknown>, timeoutMs: number): Promise<ChatCallResult> {
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...providerAuthHeaders(p) },
      body: JSON.stringify({ stream: false, ...payload }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await r.text().catch(() => '');
    const headers = rateHeadersOf(r.headers);
    if (!r.ok) return { status: r.status, body, headers };
    try {
      return { status: r.status, body, data: JSON.parse(body) as Record<string, unknown>, headers };
    } catch {
      return { status: 502, body: 'non-JSON answer' };
    }
  } catch (err) {
    return { status: 0, body: String(err) };
  }
}

/** One probe call, retried a couple of times (3 s, 6 s) while the provider says it is briefly
 *  overloaded, so a busy moment doesn't read as a broken provider. */
async function chatCall(p: ProviderDef, base: string, payload: Record<string, unknown>, timeoutMs: number): Promise<ChatCallResult> {
  let r = await chatCallOnce(p, base, payload, timeoutMs);
  for (const wait of OVERLOAD_RETRY_DELAYS_MS) {
    if (r.data || classifyFailure(r.status, r.body, String(payload.model ?? ''), r.headers) !== 'overloaded') break;
    await new Promise((res) => setTimeout(res, wait));
    r = await chatCallOnce(p, base, payload, timeoutMs);
  }
  return r;
}

/** Two tiny calls against one model: a plain chat that must return text, then a tool-call test
 *  (one get_time(city) function, tool_choice auto) that must return a tool call. */
export async function probeModel(p: ProviderDef, model: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  const t0 = Date.now();
  const base = providerBaseUrl(p);
  if (!base) return { ok: false, tools: false, ms: 0, error: 'base URL is incomplete (a required value is missing)' };
  const fail = (status: number, body: string, headers?: RateHeaders): ProbeResult => ({ ok: false, tools: false, ms: Date.now() - t0, status, body, headers, kind: status > 0 ? classifyFailure(status, body, model, headers) : 'failing', error: status > 0 ? `HTTP ${status}: ${errorText(body).slice(0, 200)}` : errorText(body) || 'unreachable' });
  const a = await chatCall(p, base, { model, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] }, timeoutMs);
  if (!a.data) return fail(a.status, a.body, a.headers);
  type Msg = { content?: string; reasoning_content?: string; reasoning?: string; tool_calls?: unknown[] };
  const msgOf = (d: Record<string, unknown>): Msg | undefined => (d.choices as Array<{ message?: Msg }> | undefined)?.[0]?.message;
  const m1 = msgOf(a.data);
  const said = String(m1?.content || m1?.reasoning_content || m1?.reasoning || '').trim();
  if (!said) return { ok: false, tools: false, ms: Date.now() - t0, status: 200, kind: 'failing', error: 'answered with no text' };
  const b = await chatCall(
    p,
    base,
    {
      model,
      messages: [{ role: 'user', content: 'What time is it in Paris? Use the get_time tool.' }],
      tools: [{ type: 'function', function: { name: 'get_time', description: 'Current local time in a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }],
      tool_choice: 'auto',
    },
    timeoutMs,
  );
  if (!b.data) return { ...fail(b.status, b.body, b.headers), ok: true, tools: false };
  const calls = msgOf(b.data)?.tool_calls;
  return { ok: true, tools: Array.isArray(calls) && calls.length > 0, ms: Date.now() - t0 };
}

/** Not chat models: embeddings, guard/safety/moderation, speech, image generation, rerankers. */
const NON_CHAT_RE = /embed|guard|safety|moderat|\btts\b|-tts|whisper|speech|transcri|audio|orpheus|playai|kokoro|image-gen|imagen|dall-e|flux|stable-diffusion|sdxl|text-to-image|rerank|reward|retriev|ocr|parakeet|canary/i;

/** Rank a candidate replacement: strong general chat models first, small ones last. */
export function rankModel(id: string): number {
  const x = id.toLowerCase();
  let s = 40;
  const pats: Array<[RegExp, number]> = [
    [/gpt-oss-120b|gpt-oss:120b/, 100],
    [/nemotron-3-ultra/, 95],
    [/qwen3.*(235b|480b|coder|max|next|32b|30b|80b)/, 88],
    [/nemotron.*super/, 85],
    [/deepseek/, 82],
    [/kimi/, 82],
    [/glm/, 80],
    [/llama-?4/, 80],
    [/llama-?3\.3.*70b|llama-3\.3/, 75],
    [/gemma-?4.*31b/, 70],
    [/mistral-large|mistral-medium/, 70],
    [/gpt-oss-20b|gpt-oss:20b/, 50],
  ];
  for (const [re, v] of pats) if (re.test(x)) { s = v; break; }
  const size = /(\d+(?:\.\d+)?)b\b/.exec(x.replace(/a\d+b\b/g, ''));
  if (/(^|[-_/.:])(nano|mini|tiny|small|lite)([-_.:]|$)/.test(x) ||(size && Number(size[1]) <= 8)) s -= 40;
  // Fill-in-the-middle completion models can't chat; code specialists are a last resort for chat.
  if (/fim/.test(x)) s -= 60;
  else if (/codestral|mistral-code|-code-/.test(x)) s -= 10;
  return s;
}

/** Candidate replacement models from a provider's /models listing, best first. */
export function rankCandidates(p: ProviderDef, ids: string[], exclude: string[] = []): string[] {
  const ex = new Set(exclude);
  return [...new Set(ids)]
    .filter((id) => id && !ex.has(id) && MODEL_NAME_RE.test(id) && !NON_CHAT_RE.test(id))
    .filter((id) => p.id !== 'openrouter' || id.endsWith(':free'))
    .map((id, i) => ({ id, i, s: rankModel(id) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((c) => c.id);
}

async function listModels(p: ProviderDef, base: string): Promise<string[]> {
  try {
    const r = await fetch(`${base}/models`, { headers: providerAuthHeaders(p), signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!r.ok) return [];
    const d = (await r.json()) as unknown;
    const arr = Array.isArray(d) ? d : ((d as { data?: unknown[]; models?: unknown[] }).data ?? (d as { models?: unknown[] }).models ?? []);
    return (arr as Array<Record<string, unknown> | string>).map((m) => (typeof m === 'string' ? m : String(m.id ?? m.name ?? ''))).filter(Boolean);
  } catch {
    return [];
  }
}

const lastAutoCorrect = new Map<string, number>();
const autoCorrecting = new Map<string, Promise<{ model: string; previous: string } | null>>();
export const AUTO_CORRECT_EVERY_MS = 6 * 60 * 60 * 1000;
/** After a search cut short by a rate limit, another search may start this much later. */
const AUTO_CORRECT_RATE_RETRY_MS = 10 * 60 * 1000;
const MAX_CANDIDATES = 6;
/** Wall-clock budget for one search (a chat request may be waiting on it). */
const AUTO_CORRECT_BUDGET_MS = 90_000;

/** The provider's current model is gone: find a working replacement from its /models list
 *  (probe up to 6 ranked candidates: text + tool call), save it as the provider's model override,
 *  notify the user. Free providers only (on a paid one another model could cost more). At most
 *  once per provider per 6 hours (unless forced by a manual Re-check); concurrent callers share
 *  one run. `failedModel` = the model the failed call used: when it is not the provider's
 *  configured model (a caller asked for a specific one) the provider is left alone, and when it
 *  was replaced already the current replacement is returned. Returns null when nothing changed. */
export function autoCorrectModel(p: ProviderDef, opts?: { force?: boolean; failedModel?: string; why?: 'gone' | 'blocked' }): Promise<{ model: string; previous: string } | null> {
  const whyText = opts?.why === 'blocked' ? 'is not available on your plan' : 'is no longer available';
  const current = providerModel(p);
  if (opts?.failedModel && opts.failedModel !== current) {
    const now = currentModelFor(p.id, opts.failedModel);
    return Promise.resolve(now !== opts.failedModel && now === current ? { model: current, previous: opts.failedModel } : null);
  }
  if (p.kind !== 'free') {
    logger.warn({ provider: p.id, model: current }, 'paid provider model gone: not replaced automatically');
    return Promise.resolve(null);
  }
  const running = autoCorrecting.get(p.id);
  if (running) return running;
  const last = lastAutoCorrect.get(p.id);
  if (!opts?.force && last && Date.now() - last < AUTO_CORRECT_EVERY_MS) return Promise.resolve(null);
  lastAutoCorrect.set(p.id, Date.now());
  const run = (async () => {
    const t0 = Date.now();
    const previous = current;
    // "Replaced your choice" only for a model the user set, not for an earlier automatic pick
    // (remembered across restarts through settings providerModelsAuto).
    const userChoice = Boolean(modelOverrides[p.id]) && !autoPicked.has(p.id);
    const base = providerBaseUrl(p);
    if (!base) return null;
    const ids = await listModels(p, base);
    const tried = new Set([previous, ...(replacedModels.get(p.id)?.keys() ?? [])]);
    // Known free models first (some providers leave them out of /models), then the ranked list.
    const known = (p.fallbackModels ?? []).filter((m) => !tried.has(m) && MODEL_NAME_RE.test(m));
    const candidates = [...new Set([...known, ...rankCandidates(p, ids, [...tried, ...known])])].slice(0, MAX_CANDIDATES);
    logger.info({ provider: p.id, previous, why: opts?.why ?? 'gone', listed: ids.length, candidates }, 'provider model unusable: looking for a replacement');
    for (const c of candidates) {
      if (Date.now() - t0 > AUTO_CORRECT_BUDGET_MS) break;
      const r = await probeModel(p, c);
      if (r.ok && r.tools) {
        modelOverrides[p.id] = c;
        autoPicked.add(p.id);
        const map = replacedModels.get(p.id) ?? new Map<string, string>();
        for (const k of [...map.keys()]) map.set(k, c);
        map.set(previous, c);
        replacedModels.set(p.id, map);
        try {
          modelPersister?.(p.id, c);
        } catch (err) {
          logger.warn({ err: String(err) }, 'saving the replacement model failed');
        }
        markProviderOk(p.id);
        const msg = userChoice
          ? `${p.label}: your chosen model ${previous} ${whyText}; replaced your choice with ${c} (tested).`
          : `${p.label}: model ${previous} ${whyText}; switched to ${c} (tested).`;
        logger.info({ provider: p.id, previous, model: c }, msg);
        pushNotif('Provider model switched', msg, 'provider');
        return { model: c, previous };
      }
      // A key, billing or permission problem will not get better with another model: stop. A
      // candidate that is itself paid / not enabled / gone / still overloaded is just skipped.
      if (r.kind === 'key-invalid' || r.kind === 'payment-required' || r.kind === 'forbidden') break;
      // Rate-limited: stop probing (more calls only extend the limit); a new search may start later.
      if (r.kind === 'rate-limited') {
        lastAutoCorrect.set(p.id, Date.now() - AUTO_CORRECT_EVERY_MS + AUTO_CORRECT_RATE_RETRY_MS);
        coolDown(p.id, `model ${previous} retired; the search for a replacement hit the rate limit, retrying later`, 'rate-limited', AUTO_CORRECT_RATE_RETRY_MS);
        logger.warn({ provider: p.id, previous }, 'replacement search rate-limited');
        return null;
      }
    }
    coolDown(p.id, `model ${previous} ${whyText} and no working replacement was found; set another model under Model`, opts?.why === 'blocked' ? 'model-blocked' : 'model-gone');
    logger.warn({ provider: p.id, previous }, 'no working replacement model found');
    return null;
  })().finally(() => autoCorrecting.delete(p.id));
  autoCorrecting.set(p.id, run);
  return run;
}

export type ValidateStatus = 'ok' | 'model-fixed' | 'key-invalid' | 'payment-required' | 'rate-limited' | 'overloaded' | 'not-configured' | 'failing';
export interface ValidateResult {
  id: string;
  status: ValidateStatus;
  model: string;
  previousModel?: string;
  ms: number;
  tools: boolean;
  error?: string;
}

/** Re-check one provider (Settings -> Providers -> Re-check): probe its current model and, when
 *  the model is gone, auto-correct it (bypassing the 6-hour guard). */
export async function validateProvider(id: string): Promise<ValidateResult> {
  const p = providerById(id);
  if (!p) return { id, status: 'failing', model: '', ms: 0, tools: false, error: 'unknown provider' };
  const model = providerModel(p);
  if (!providerConfigured(p)) return { id, status: 'not-configured', model, ms: 0, tools: false, error: p.keyOptional ? 'not configured (add a key, or turn on "Use without a key")' : 'not configured (key or required value missing)' };
  const t0 = Date.now();
  const r = await probeModel(p, model);
  if (r.ok) {
    markProviderOk(p.id);
    // The tool-call half can fail on its own (still overloaded after the retries): say so instead
    // of claiming the model can't call tools.
    const toolNote = r.tools ? undefined : r.kind === 'overloaded' ? 'answers; tool check skipped (provider busy, try again)' : r.kind ? `answers; tool check failed (${r.error})` : 'answers, but made no tool call';
    return { id, status: 'ok', model, ms: r.ms, tools: r.tools, ...(toolNote ? { error: toolNote } : {}) };
  }
  const kind = r.status ? markProviderFailure(p.id, r.status, r.body ?? '', undefined, model, r.headers) : 'failing';
  if (kind === 'model-gone' || kind === 'model-blocked') {
    const why = kind === 'model-blocked' ? 'blocked' : 'gone';
    const fixed = await autoCorrectModel(p, { force: true, failedModel: model, why });
    if (fixed) return { id, status: 'model-fixed', model: fixed.model, previousModel: fixed.previous, ms: Date.now() - t0, tools: true };
    const h = health.get(p.id);
    const reason = p.kind !== 'free' ? `model ${model} ${why === 'blocked' ? 'is not available on your plan' : 'is no longer available'} (paid provider: not replaced automatically); set another model under Model` : h?.lastError || 'no working replacement found';
    return { id, status: h?.kind === 'rate-limited' ? 'rate-limited' : 'failing', model, ms: Date.now() - t0, tools: false, error: reason };
  }
  const status: ValidateStatus = kind === 'key-invalid' ? 'key-invalid' : kind === 'payment-required' ? 'payment-required' : kind === 'rate-limited' ? 'rate-limited' : kind === 'overloaded' ? 'overloaded' : 'failing';
  return { id, status, model, ms: r.ms, tools: false, error: r.error };
}

/** Re-check every configured provider (in parallel). */
export async function validateAllProviders(): Promise<ValidateResult[]> {
  return Promise.all(configuredProviders().map((p) => validateProvider(p.id)));
}

// ── Status for the UI ──

export interface ProviderStatusRow {
  id: string;
  label: string;
  kind: string;
  model: string;
  defaultModel: string;
  modelOverride: string;
  /** The override was picked by auto-correction (not typed by the user). */
  modelAuto: boolean;
  signup: string;
  note: string;
  freeDaily: number;
  configured: boolean;
  keySet: boolean;
  keyOptional: boolean;
  /** keyOptional only: the user allowed anonymous use without a key. */
  keylessEnabled: boolean;
  extraKeys: Array<{ env: string; label: string; secret: boolean; set: boolean; value: string }>;
  used: number;
  envKey: string;
  lastError?: string;
  failure?: FailureKind;
  cooldownUntil?: number;
}

/** Per-provider status for the web Providers panel. */
export function providerStatus(): ProviderStatusRow[] {
  rollover();
  return PROVIDERS.map((p) => {
    const h = health.get(p.id);
    const cooling = !!h?.cooldownUntil && h.cooldownUntil > Date.now();
    return {
      id: p.id,
      label: p.label,
      kind: p.kind,
      model: providerModel(p),
      defaultModel: p.model,
      modelOverride: modelOverrides[p.id] ?? '',
      modelAuto: !!modelOverrides[p.id] && autoPicked.has(p.id),
      signup: p.signup,
      note: p.note,
      freeDaily: p.freeDaily,
      configured: providerConfigured(p),
      keySet: Boolean(providerKey(p)),
      keyOptional: !!p.keyOptional,
      keylessEnabled: !!p.keyOptional && keylessOn.has(p.id),
      extraKeys: (p.extraKeys ?? []).map((k) => ({ env: k.env, label: k.label, secret: !!k.secret, set: Boolean((process.env[k.env] || '').trim()), value: k.secret ? '' : process.env[k.env] || '' })),
      used: state.used[p.id] ?? 0,
      envKey: p.envKey,
      ...(h?.lastError ? { lastError: h.lastError, failure: h.kind } : {}),
      ...(cooling ? { cooldownUntil: h!.cooldownUntil } : {}),
    };
  });
}
