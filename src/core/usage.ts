import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';

/**
 * Token-usage accounting for the PAID (metered) models — the key-gated plugins
 * (`ask_external_model`, `generate_image`) that bill to OpenAI/OpenRouter rather
 * than the Claude subscription. Tracks two ledgers:
 *   - `total`   — cumulative, persisted to <dataDir>/usage.json across restarts
 *   - `session` — since this process started (in-memory)
 * Both are broken down per model so the UI can show exactly what was used.
 */
export interface ModelUsage {
  calls: number;
  prompt: number;
  completion: number;
  total: number;
  lastUsed: number;
}

interface UsageFile {
  /** Paid/metered plugins (ask_external_model, generate_image). */
  models: Record<string, ModelUsage>;
  /** Subscription engine (Claude) models — informational; not billed per token. */
  engine?: Record<string, ModelUsage>;
}

/** Summary of the most recent engine turn (which model answered + its tokens). */
export interface LastTurn {
  model: string;
  models: string[];
  input: number;
  output: number;
  total: number;
  costUsd: number;
  at: number;
}

export class UsageTracker {
  private readonly file: string;
  private persisted: UsageFile;
  private readonly sessionModels: Record<string, ModelUsage> = {};
  private readonly engineSession: Record<string, ModelUsage> = {};
  private lastTurn: LastTurn | null = null;
  private readonly startedAt = Date.now();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'usage.json');
    this.persisted = this.load();
    this.persisted.engine ??= {};
  }

  private load(): UsageFile {
    try {
      const f = JSON.parse(fs.readFileSync(this.file, 'utf8')) as UsageFile;
      if (f && typeof f === 'object' && f.models) return f;
    } catch {
      /* no file yet / unreadable */
    }
    return { models: {} };
  }

  private blank(): ModelUsage {
    return { calls: 0, prompt: 0, completion: 0, total: 0, lastUsed: 0 };
  }

  /** Record one billable call to `model` (e.g. "openai:gpt-4o"). */
  record(model: string, u: { prompt?: number; completion?: number; total?: number }): void {
    const prompt = Math.max(0, u.prompt ?? 0);
    const completion = Math.max(0, u.completion ?? 0);
    const total = Math.max(0, u.total ?? prompt + completion);
    const now = Date.now();
    for (const store of [this.persisted.models, this.sessionModels]) {
      const m = (store[model] ??= this.blank());
      m.calls += 1;
      m.prompt += prompt;
      m.completion += completion;
      m.total += total;
      m.lastUsed = now;
    }
    this.persist();
  }

  /**
   * Record one engine (Claude) turn from the SDK result's `modelUsage` map. Not
   * billed per token (flat subscription) but tracked so the UI can show which
   * model answered and how many tokens it used.
   */
  recordEngine(
    modelUsage: Record<string, { inputTokens?: number; outputTokens?: number; costUSD?: number }> | undefined,
    costUsd?: number,
  ): void {
    if (!modelUsage) return;
    const now = Date.now();
    let primary = '';
    let maxTot = -1;
    let sumIn = 0;
    let sumOut = 0;
    for (const [model, mu] of Object.entries(modelUsage)) {
      const inp = Math.max(0, mu.inputTokens ?? 0);
      const out = Math.max(0, mu.outputTokens ?? 0);
      sumIn += inp;
      sumOut += out;
      // The model that handled the real turn processes the big system prompt, so it
      // has the most TOTAL tokens — pick that as primary (max-output mislabels when
      // the SDK fires a tiny internal fast-model sub-call).
      if (inp + out > maxTot) {
        maxTot = inp + out;
        primary = model;
      }
      for (const store of [this.persisted.engine!, this.engineSession]) {
        const m = (store[model] ??= this.blank());
        m.calls += 1;
        m.prompt += inp;
        m.completion += out;
        m.total += inp + out;
        m.lastUsed = now;
      }
    }
    const keys = Object.keys(modelUsage);
    if (keys.length) {
      this.lastTurn = { model: primary || keys[0]!, models: keys, input: sumIn, output: sumOut, total: sumIn + sumOut, costUsd: costUsd ?? 0, at: now };
    }
    this.persist();
  }

  private agg(models: Record<string, ModelUsage>): ModelUsage {
    const t = this.blank();
    for (const m of Object.values(models)) {
      t.calls += m.calls;
      t.prompt += m.prompt;
      t.completion += m.completion;
      t.total += m.total;
      t.lastUsed = Math.max(t.lastUsed, m.lastUsed);
    }
    return t;
  }

  snapshot() {
    return {
      session: { since: this.startedAt, models: this.sessionModels, totals: this.agg(this.sessionModels) },
      total: { models: this.persisted.models, totals: this.agg(this.persisted.models) },
      engine: {
        session: { models: this.engineSession, totals: this.agg(this.engineSession) },
        total: { models: this.persisted.engine!, totals: this.agg(this.persisted.engine!) },
      },
      last: this.lastTurn,
    };
  }

  private persist(): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.persisted, null, 2));
    } catch (err) {
      logger.warn({ err: String(err) }, 'usage persist failed');
    }
  }
}
