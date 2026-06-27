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
  /** Stopped by the user: schedules suspended and manual/scheduled runs refused until resumed. */
  stopped?: boolean;
  /** Open agent: created WITHOUT fixed instructions — Run prompts for a task each time.
   *  Dedicated agents (open=false/undefined) Run their standing job with no prompt. */
  open?: boolean;
  /** Per-agent restart behavior, overriding the global agentRestore setting:
   *  true = always resume on startup, false = always start paused, undefined = follow global. */
  autostart?: boolean;
  /** Who created this agent: 'user' (via the web UI) or 'agent' (Zamolxis made it mid-job).
   *  Agent-created agents are purged on restart unless the persistAgentCreated setting is on. */
  createdBy?: 'user' | 'agent';
  /** The backend that produced this agent's most recent answer (e.g. "Cerebras (gpt-oss-120b)").
   *  Shown in the panel so a rotating tier like 'freecloud' reveals the actual model it used. */
  lastVia?: string;
  /** Short "what I do / how to use me / what to configure" blurb (shown in the agent app). */
  help?: string;
  /** Longer step-by-step guide shown in the agent app's "How this works" section. */
  guide?: string;
  /** Where this agent's result is delivered (scheduled or manual). 'chat' = the web/agent feed;
   *  'slack' posts to a Slack channel/DM; 'web' publishes the latest result at /<agent-name>.
   *  Default: chat only. */
  deliver?: { chat?: boolean; slack?: boolean; slackChannel?: string; web?: boolean };
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
    open?: boolean;
    autostart?: boolean;
    createdBy?: 'user' | 'agent';
    help?: string;
    guide?: string;
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
      open: typeof input.open === 'boolean' ? input.open : existing?.open,
      autostart: typeof input.autostart === 'boolean' ? input.autostart : existing?.autostart,
      createdBy: input.createdBy ?? existing?.createdBy ?? 'user',
      createdAt: existing?.createdAt ?? Date.now(),
      help: input.help ?? existing?.help,
      guide: input.guide ?? existing?.guide,
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

  /** Remove all agent-CREATED agents (createdBy='agent'). Called at startup when the user has NOT
   *  opted to persist them. Returns the names removed. */
  purgeAgentCreated(): string[] {
    const removed = this.agents.filter((a) => a.createdBy === 'agent').map((a) => a.name);
    if (removed.length) {
      this.agents = this.agents.filter((a) => a.createdBy !== 'agent');
      this.persist();
      logger.info({ removed }, 'purged agent-created agents (not persisted per setting)');
    }
    return removed;
  }

  /** Set where this agent sends its reply (the chat feed, a Slack channel, and/or a web page). */
  setDeliver(name: string, deliver: { chat?: boolean; slack?: boolean; slackChannel?: string; web?: boolean }): AgentDef | undefined {
    const a = this.get(name);
    if (!a) return undefined;
    a.deliver = {
      chat: deliver.chat !== false,
      slack: !!deliver.slack,
      slackChannel: typeof deliver.slackChannel === 'string' ? deliver.slackChannel.trim() : a.deliver?.slackChannel,
      web: !!deliver.web,
    };
    this.persist();
    logger.info({ name: a.name, deliver: a.deliver }, 'agent delivery updated');
    return a;
  }

  /** Set the short help blurb (used to back-fill pre-made agents created before `help` existed). */
  setHelp(name: string, help: string): void {
    const a = this.get(name);
    if (!a || !help) return;
    a.help = help;
    this.persist();
  }

  /** Set the step-by-step guide (used to back-fill / refresh pre-made agents on upgrade). */
  setGuide(name: string, guide: string): void {
    const a = this.get(name);
    if (!a || !guide) return;
    a.guide = guide;
    this.persist();
  }

  /** Record the backend that last answered for this agent (for the panel's model display). */
  setLastVia(name: string, via: string): void {
    const a = this.get(name);
    if (!a || !via || a.lastVia === via) return;
    a.lastVia = via;
    this.persist();
  }

  /** Stop (suspend) or resume an agent. Returns the stored def, or undefined if not found. */
  setStopped(name: string, stopped: boolean): AgentDef | undefined {
    const a = this.get(name);
    if (!a) return undefined;
    a.stopped = stopped;
    this.persist();
    logger.info({ name: a.name, stopped }, stopped ? 'agent stopped' : 'agent resumed');
    return a;
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
