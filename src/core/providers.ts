import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';

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
  baseUrl: string; // OpenAI-compatible base (we POST `${baseUrl}/chat/completions`)
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
}

export const PROVIDERS: ProviderDef[] = [
  // ── Free tiers (rotated; one key per provider) ──
  { id: 'google', label: 'Google AI Studio (Gemini)', kind: 'free', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', envKey: 'GOOGLE_AI_API_KEY', freeDaily: 1500, signup: 'https://aistudio.google.com/apikey', note: 'Frontier-class Gemini 2.5 Flash. ~1,500 req/day free. Handles images (vision).', strong: true, vision: true },
  { id: 'cerebras', label: 'Cerebras', kind: 'free', baseUrl: 'https://api.cerebras.ai/v1', model: 'gpt-oss-120b', envKey: 'CEREBRAS_API_KEY', freeDaily: 1400, signup: 'https://cloud.cerebras.ai/', note: 'Ultra-fast; very generous free throughput (gpt-oss-120b).', strong: true },
  { id: 'groq', label: 'Groq', kind: 'free', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', envKey: 'GROQ_API_KEY', freeDaily: 1000, signup: 'https://console.groq.com/keys', note: 'Fastest free option; tight per-minute limits.', strong: true },
  { id: 'openrouter', label: 'OpenRouter (free models)', kind: 'free', baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct:free', envKey: 'OPENROUTER_API_KEY', freeDaily: 200, signup: 'https://openrouter.ai/keys', note: 'Many :free models behind one key. ~200 req/day.', strong: true },
  { id: 'mistral', label: 'Mistral', kind: 'free', baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-small-latest', envKey: 'MISTRAL_API_KEY', freeDaily: 500, signup: 'https://console.mistral.ai/', note: 'Free Mistral Small for prototyping (not used for live-fact lookups).' },
  { id: 'nvidia', label: 'NVIDIA NIM', kind: 'free', baseUrl: 'https://integrate.api.nvidia.com/v1', model: 'meta/llama-3.3-70b-instruct', envKey: 'NVIDIA_API_KEY', freeDaily: 1000, signup: 'https://build.nvidia.com/', note: '100+ open models, free credits, no card. OpenAI-compatible.', strong: true },
  { id: 'sambanova', label: 'SambaNova', kind: 'free', baseUrl: 'https://api.sambanova.ai/v1', model: 'Meta-Llama-3.3-70B-Instruct', envKey: 'SAMBANOVA_API_KEY', freeDaily: 500, signup: 'https://cloud.sambanova.ai/', note: 'Very fast free tier (Llama 3.3 70B). OpenAI-compatible.', strong: true },
  // ── Paid (metered; used only if you add them to the routing order) ──
  { id: 'openai', label: 'OpenAI', kind: 'paid', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini', envKey: 'OPENAI_API_KEY', freeDaily: 1_000_000, signup: 'https://platform.openai.com/api-keys', note: 'Paid (gpt-5-mini by default — cheap + capable). Billed to your OpenAI account.' },
  { id: 'deepseek', label: 'DeepSeek', kind: 'paid', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', envKey: 'DEEPSEEK_API_KEY', freeDaily: 1_000_000, signup: 'https://platform.deepseek.com/', note: 'Paid but very cheap (deepseek-chat). Billed to your DeepSeek account.' },
  { id: 'perplexity', label: 'Perplexity (Sonar)', kind: 'paid', baseUrl: 'https://api.perplexity.ai', model: 'sonar', envKey: 'PERPLEXITY_API_KEY', freeDaily: 1_000_000, signup: 'https://www.perplexity.ai/settings/api', note: 'Search-grounded answers. NOT a free tier — pay per token + per-request search fees (trial credits + $5/mo for Pro). Added as paid so it is not auto-used.' },
];

export function providerById(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

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

export function recordProviderUse(id: string): void {
  rollover();
  state.used[id] = (state.used[id] ?? 0) + 1;
  persist();
}

/** Providers that have a key configured (env or injected from settings credentials). */
export function configuredProviders(): ProviderDef[] {
  return PROVIDERS.filter((p) => Boolean(process.env[p.envKey]));
}

/** Configured FREE providers with quota left today, ordered least-used first (rotation).
 *  With { strongOnly }, restrict to capable providers (for current/live FACT lookups) so a
 *  weak model like mistral-small never answers those — falls back to any free if none strong. */
export function freeProviderPool(opts?: { strongOnly?: boolean }): ProviderDef[] {
  rollover();
  let avail = configuredProviders().filter((p) => p.kind === 'free' && (state.used[p.id] ?? 0) < p.freeDaily);
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

/** Per-provider status for the web Providers panel. */
export function providerStatus(): Array<{ id: string; label: string; kind: string; model: string; signup: string; note: string; freeDaily: number; configured: boolean; used: number; envKey: string }> {
  rollover();
  return PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    kind: p.kind,
    model: p.model,
    signup: p.signup,
    note: p.note,
    freeDaily: p.freeDaily,
    configured: Boolean(process.env[p.envKey]),
    used: state.used[p.id] ?? 0,
    envKey: p.envKey,
  }));
}
