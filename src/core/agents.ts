import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';

/**
 * A user-defined agent: a named "job" with a role/instructions, a chosen set of tools, and a
 * model/tier it runs on. Agents run on ANY tier (local / free cloud / a specific provider /
 * Claude / auto-route), can optionally escalate to the smartest model when stuck, and can be
 * scheduled. Definitions persist in <dataDir>/agents.json. (Phase 1: define / list / run.
 * Messaging between agents, scheduling, and elevation are layered on in later phases.)
 */
export interface AgentDef {
  /** Unique slug, e.g. "hn-summarizer". */
  name: string;
  /** Human label (defaults to name). */
  label?: string;
  /** The role / instructions: what this agent is and what job it does. */
  job: string;
  /** Allowed tool names (subset of the available tools). Empty = the standard default toolset. */
  tools: string[];
  /** Where it runs: 'auto' (routing chain) | 'local' | 'freecloud' | a provider id | 'claude'. */
  model: string;
  /** May it escalate to the smartest model when its tier can't cope? */
  canElevate: boolean;
  /** Optional schedule (Phase 3): cron (recurring) or at (one-shot ISO). */
  schedule?: { cron?: string; at?: string };
  createdAt: number;

  // ---- Planner/executor (Phase 4): the smartest model compiles the NL `job` into a literal,
  // executable plan that a cheaper "executor" model can follow without improvising. ----
  /** Compiled step-by-step instructions the executor follows verbatim (preferred over `job` at run time). */
  spec?: string;
  /** Skills the planner authored/attached for this agent (slugs in the skills store). */
  skills?: string[];
  /** Code tools the planner generated; the executor runs them via the sandbox by the `run` command. */
  codeTools?: { name: string; path: string; run: string }[];
  /** Planner's risk assessment of the job, surfaced to the user. */
  risk?: { level: 'low' | 'medium' | 'high'; note: string; recommendedModel?: string };
  /** When the plan was last compiled (ms epoch). */
  compiledAt?: number;
}

function slug(name: string): string {
  return (name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export class AgentStore {
  private readonly file: string;
  private agents: AgentDef[] = [];

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'agents.json');
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(raw)) this.agents = raw as AgentDef[];
    } catch {
      /* first run / no file */
    }
  }

  private persist(): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.agents, null, 2));
    } catch (err) {
      logger.warn({ err: String(err) }, 'failed to persist agents.json');
    }
  }

  list(): AgentDef[] {
    return this.agents.slice();
  }

  get(name: string): AgentDef | undefined {
    const s = slug(name);
    return this.agents.find((a) => a.name === s);
  }

  /** Create or update an agent. Returns the stored slug. */
  upsert(input: {
    name: string;
    job: string;
    tools?: string[];
    model?: string;
    canElevate?: boolean;
    label?: string;
    schedule?: { cron?: string; at?: string };
  }): string {
    const name = slug(input.name);
    if (!name) throw new Error('invalid agent name');
    if (!input.job || !input.job.trim()) throw new Error('agent needs a job/instructions');
    const existing = this.agents.find((a) => a.name === name);
    const def: AgentDef = {
      name,
      label: input.label?.trim() || existing?.label || input.name.trim(),
      job: input.job.trim(),
      tools: Array.isArray(input.tools) ? input.tools.filter((t) => typeof t === 'string') : (existing?.tools ?? []),
      model: (input.model || existing?.model || 'auto').trim(),
      canElevate: typeof input.canElevate === 'boolean' ? input.canElevate : (existing?.canElevate ?? true),
      schedule: input.schedule ?? existing?.schedule,
      createdAt: existing?.createdAt ?? Date.now(),
    };
    if (existing) Object.assign(existing, def);
    else this.agents.push(def);
    this.persist();
    logger.info({ name, model: def.model, tools: def.tools.length }, existing ? 'agent updated' : 'agent created');
    return name;
  }

  /** Attach a compiled plan (from the planner) to an existing agent. Preserves the original `job`. */
  attachPlan(
    name: string,
    plan: { spec?: string; skills?: string[]; codeTools?: AgentDef['codeTools']; risk?: AgentDef['risk']; model?: string },
  ): void {
    const a = this.get(name);
    if (!a) return;
    if (plan.spec) a.spec = plan.spec;
    if (plan.skills) a.skills = plan.skills;
    if (plan.codeTools) a.codeTools = plan.codeTools;
    if (plan.risk) a.risk = plan.risk;
    if (plan.model && plan.model.trim()) a.model = plan.model.trim();
    a.compiledAt = Date.now();
    this.persist();
    logger.info(
      { name: a.name, risk: a.risk?.level, skills: a.skills?.length ?? 0, codeTools: a.codeTools?.length ?? 0, model: a.model },
      'agent plan compiled',
    );
  }

  remove(name: string): boolean {
    const s = slug(name);
    const i = this.agents.findIndex((a) => a.name === s);
    if (i < 0) return false;
    this.agents.splice(i, 1);
    this.persist();
    logger.info({ name: s }, 'agent removed');
    return true;
  }
}
