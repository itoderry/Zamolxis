import fs from 'node:fs';
import path from 'node:path';
import {
  query,
  type Options,
  type PermissionResult,
  type McpServerConfig,
  type AgentDefinition,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { ZamolxisConfig } from '../config.js';
import { logger } from '../logger.js';
import { SessionStore } from './session.js';
import { Throttle } from './throttle.js';
import { engineEnv } from './auth.js';
import type { MemoryManager } from './memory.js';
import type { SessionIndex } from './sessionIndex.js';
import type { UsageTracker } from './usage.js';
import type { SkillsManager } from '../skills/manager.js';
import { buildLocalTools, localSearchAvailable, type LocalToolset } from './localTools.js';
import { effectiveName } from './displayName.js';
import { pickFreeProvider, freeProviderPool, providerById, recordProviderUse, type ProviderDef } from './providers.js';
import type { AgentStore } from './agents.js';

export interface RunRequest {
  /** Stable per-conversation key, e.g. "telegram:12345". */
  conversationKey: string;
  /** The user's message text. */
  text: string;
  /** Human-friendly name for the requester, woven into the prompt context. */
  displayName?: string;
  /** Optional per-turn model override (router decides). */
  model?: string;
  /** Originating channel id and chat id, so tools can deliver back here. */
  channel?: string;
  chatId?: string;
  /** Streamed assistant text chunks, for channels that support live typing. */
  onProgress?: (chunk: string) => void;
  /** Routing override: 'local' forces on-device, 'claude' forces the subscription, 'freecloud'
   *  rotates free providers, a provider id forces that provider, 'auto'/undefined follows config. */
  route?: string;
  /** Internal: this turn is a user-driven escalation (so prompt the smart model to teach the local one). */
  escalated?: boolean;
  /** Agent run: the agent's role/instructions, prepended to the system prompt. */
  agentJob?: string;
  /** Agent run: restrict the tool-using tiers to only these tool names ([] / undefined = all). */
  agentTools?: string[];
  /** Agent run: allow falling back to Claude (smartest) even on a fixed tier / chain without it. */
  elevate?: boolean;
}

/** Builds per-turn in-process MCP servers, closing over the live conversation context. */
export type McpServerBuilder = (ctx: {
  conversationKey: string;
  channel: string;
  chatId: string;
}) => Record<string, McpServerConfig>;

export interface RunResult {
  reply: string;
  sessionId: string;
  costUsd: number;
  isError: boolean;
  errorKind?: string;
  /** Which backend produced this answer (e.g. "Groq (llama-3.3-70b-versatile)", "Claude (opus)", "Local"). */
  via?: string;
}

export interface EngineDeps {
  config: ZamolxisConfig;
  sessions: SessionStore;
  throttle: Throttle;
  /** Curated SOUL/USER/MEMORY injected into every turn's system prompt. */
  memory: MemoryManager;
  /** Full-text session archive; turns are recorded here for search_history. */
  sessionIndex?: SessionIndex;
  /** Token accounting — records which engine model answered each turn. */
  usage?: UsageTracker;
  /** Saved skills — surfaced to the local model so it can follow/defer on known procedures. */
  skills?: SkillsManager;
  /** In-process MCP servers (custom tools): schedule, delegate, image-gen, etc. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Programmatic subagents available via the Task tool. */
  agents?: Record<string, AgentDefinition>;
  /** User-defined agents (named jobs that run on any tier). */
  agentStore?: AgentStore;
  /** Sink for agent messages (to other agents or the user) - delivered to channels + logged. */
  onAgentMessage?: (msg: { from: string; to: string; text: string; ts: number }) => void;
  /** Schedule a named agent on a cron (deterministic). Late-bound to the scheduler. */
  scheduleAgent?: (name: string, cron: string, task?: string) => void;
  /** How many schedules currently exist for an agent. Late-bound to the scheduler. */
  countAgentSchedules?: (name: string) => number;
  /** Suspend (enabled=false) or resume (true) ALL schedules for an agent. Returns the count affected. */
  setAgentSchedulesEnabled?: (name: string, enabled: boolean) => number;
}

function buildPersona(name: string): string {
  return `You are ${name}, a self-hosted personal agent that lives on the user's own machine and talks to them across messaging channels. You are persistent: you remember context across conversations via files in your workspace, you can write new skills for yourself, schedule recurring work, delegate to subagents, and use the shell and the web. Be concise and direct in chat. When a task spans multiple steps, just do it — only ask the user when a choice is genuinely theirs to make. Your name is ${name}; refer to yourself as ${name}. As you learn durable facts about the user (their name, timezone, preferences, recurring projects, environment), record them in your user profile with the \`memory\` tool using scope="profile"; use the default scope for your own working notes. Keep entries concise and consolidate or remove stale ones when near full. Use \`search_history\` to recall things discussed in past conversations.`;
}

const AUTH_EXPIRED_MSG =
  'My Claude subscription login has expired or is invalid. On the host machine, run `claude login`, then restart Zamolxis.';

// Loop guard for agent->agent messaging: at most this many agent-triggered runs in flight at once.
let AGENT_HOPS = 0;
const MAX_AGENT_HOPS = 6;

function sanitizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

/** Levenshtein edit distance (tiny strings only). */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i]![0] = i;
  for (let j = 0; j <= n; j++) d[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[m]![n]!;
}

/** Did the local model ask to hand off? It was told to reply "ESCALATE", but small models rarely
 *  comply exactly — they wrap it ("**ESCALATE**", "<ESCALATE>"), add a reason ("ESCALATE: needs
 *  web"), bury it in a sentence ("I need to ESCALATE this"), OR MISSPELL it ("ESCOALATE",
 *  "ESCOLATE"). We treat any ALL-CAPS standalone token that is ESCALATE or a near miss (ESC-
 *  prefix, edit distance <= 2) as a hand-off — case-SENSITIVE caps, so ordinary lowercase prose
 *  that merely mentions escalating stays a normal answer. An empty reply also escalates. */
function wantsEscalate(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t) return true;
  for (const w of t.split(/[^A-Za-z]+/)) {
    if (w.length >= 5 && w.length <= 12 && w === w.toUpperCase() && w.startsWith('ESC')) {
      if (w === 'ESCALATE' || editDistance(w, 'ESCALATE') <= 2) return true;
    }
  }
  // Whole reply is basically just "escalate" (any case), possibly wrapped in punctuation/markdown/quotes.
  if (/^[\s>*_`"'[(<:.\-]*escalate[\s>*_`"'\])>:.!\-]*$/i.test(t)) return true;
  return false;
}

/** Local reply that "punts" — gives an excuse or asks the user to do the agent's
 *  job (find IDs, create groups, check their setup) instead of doing it. The user
 *  wants these handed to the smart model, not shown as excuses. */
function looksLikePunt(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t) return false;
  return (
    /\bcould you (please )?(check|create|confirm|provide|verify|tell me|let me know)\b/i.test(t) ||
    /\bplease (check|create|provide|set ?up|confirm|verify)\b/i.test(t) ||
    /\bdoes\b[^.?!]{0,60}\bexist\b/i.test(t) ||
    /\b(in the meantime|ensure (we|you) have the correct|you (can|could) (create|use)|i (couldn'?t|could not|was unable to|am unable to|don'?t have enough) (find|locate|determine|complete|access))\b/i.test(t) ||
    // Refusals that claim no access/ability — a small model should hand off, not punt.
    /\bi (can'?t|cannot|am unable to|do not have|don'?t have)\b[^.?!]{0,40}\b(access|see|read|view|open|reach)\b/i.test(t) ||
    /\bi (don'?t|do not) have (access to|the ability to)\b/i.test(t) ||
    /\blet'?s (ensure|create|use|make sure)\b/i.test(t)
  );
}

/** The user's message likely reveals a durable personal fact worth saving to the profile. */
function mentionsSelf(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t || t.length > 1500) return false;
  return /\b(i'?m|i am|i like|i prefer|i'?d prefer|i hate|i don'?t like|my name|call me|i live|i'?m from|i'?m based|i work|i use|i usually|i always|i never|remember (that|this|i)|note that|for (future|next time)|keep in mind|my (timezone|time zone|email|birthday|phone|job|role|setup|stack|preference))\b/i.test(t);
}

/**
 * Does the request need CURRENT, real-world facts (scores, news, weather, prices, "who
 * won", "latest", "yesterday/two nights ago")? The tiny on-device model fabricates these
 * even with search, so route them past 'local' to a stronger tier that searches reliably.
 */
function needsCurrentInfo(text: string): boolean {
  const t = (text ?? '').toLowerCase();
  if (!t) return false;
  const recency =
    /\b(today|tonight|yesterday|last night|this (morning|afternoon|evening|week|weekend|month|season)|right now|currently|at the moment|latest|most recent|recent(ly)?|so far|as of|up to date|the other (night|day)|(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|couple( of)?|few)\s+(night|day|week|hour)s?\s+ago)\b/;
  const live =
    /\b(final score|who won|who is winning|standings|playoff|fixture|kickoff|box ?score|weather|forecast|temperature|stock price|share price|stock market|exchange rate|currency rate|headlines?|breaking news|the news|schedule|scores?)\b/;
  return recency.test(t) || live.test(t);
}

/** A reply that is ITSELF a leaked tool/function/skill call (not prose) — small models sometimes
 *  emit `skillname {json}` or `<function…>` as their final answer. Treat it as a failure so we
 *  escalate (or replace it) instead of dumping raw JSON on the user. */
function looksLikeLeakedCall(text: string): boolean {
  const s = (text ?? '').trim();
  if (!s || s.length > 600) return false; // real prose isn't a bare call
  if (/<\/?(?:function|tool_call|tool|\|?python_tag\|?)\b/i.test(s)) return true;
  if (/^[a-z0-9_.-]{2,48}\s*\{[\s\S]*\}\s*$/i.test(s)) return true; // `name {json}` (skill/tool name)
  if (/^\{[\s\S]*"(?:url|query|parameters|arguments|name|tool)"\s*:[\s\S]*\}\s*$/i.test(s)) return true; // bare JSON call
  return false;
}

const LOCAL_TOOL_NAMES = ['http_get', 'web_search'];
/**
 * Small models sometimes emit a tool call as plain TEXT in `content` (e.g.
 * `{"name":"http_get","parameters":{...}}`) instead of the structured tool_calls
 * field. Detect that so we can execute it rather than dumping JSON on the user.
 */
function extractLeakedToolCall(content: string): { name: string; args: Record<string, unknown> } | null {
  if (!content) return null;
  const finish = (name: string, rawArgs: unknown): { name: string; args: Record<string, unknown> } | null => {
    if (!LOCAL_TOOL_NAMES.includes(name)) return null;
    let args: unknown = rawArgs ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    return { name, args: args && typeof args === 'object' ? (args as Record<string, unknown>) : {} };
  };
  // (A) Bare JSON object: {"name":"web_search","parameters":{...}} (also "arguments"/"args").
  //     Also covers <tool_call>{"name":...}</tool_call> since we match the inner JSON.
  const j = content.match(/\{[\s\S]*?"name"\s*:\s*"(?:http_get|web_search)"[\s\S]*\}/);
  if (j) {
    try {
      const obj = JSON.parse(j[0]) as Record<string, unknown>;
      const r = finish(String(obj.name), obj.parameters ?? obj.arguments ?? obj.args ?? {});
      if (r) return r;
    } catch {
      /* malformed — fall through to the tag form */
    }
  }
  // (B) Llama/Groq "tag" form emitted as TEXT, e.g.
  //     <function=web_search>{...}</function>  ·  <function\web_search {"query":"..."}</function>
  //     <tool_call> web_search {...} </tool_call>  ·  <|python_tag|>web_search{...}
  const tag = content.match(/<\|?(?:function|tool_call|tool|python_tag)\|?[^A-Za-z0-9_]*\b(http_get|web_search)\b[\s\S]*?(\{[\s\S]*?\})/i);
  if (tag) return finish(tag[1]!, tag[2]);
  return null;
}

export class Engine {
  /** Set after construction (scheduler/skills depend on the engine, so this breaks the cycle). */
  public buildMcpServers?: McpServerBuilder;

  constructor(private readonly deps: EngineDeps) {}

  /** Ensure a per-conversation workspace exists with a CLAUDE.md and shared skills. */
  private ensureWorkspace(conversationKey: string, displayName?: string): string {
    const dir = path.join(this.deps.config.workspacesDir, sanitizeKey(conversationKey));
    fs.mkdirSync(dir, { recursive: true });

    const claudeMd = path.join(dir, 'CLAUDE.md');
    if (!fs.existsSync(claudeMd)) {
      fs.writeFileSync(
        claudeMd,
        `# Zamolxis workspace\n\nThis directory is your persistent workspace for the conversation with ${displayName ?? conversationKey}.\n\n- Use \`memory.md\` in this folder to record durable facts about this user and ongoing work.\n- Files you create here persist across restarts.\n- Shared, reusable skills live under \`.claude/skills/\`.\n`,
      );
    }

    // Expose the shared, auto-generated skills dir into this workspace via a junction
    // (works on Windows without admin for directories; symlink elsewhere).
    const dotClaude = path.join(dir, '.claude');
    fs.mkdirSync(dotClaude, { recursive: true });
    const skillsLink = path.join(dotClaude, 'skills');
    if (!fs.existsSync(skillsLink)) {
      try {
        fs.symlinkSync(this.deps.config.skillsDir, skillsLink, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (err) {
        logger.warn({ err: String(err) }, 'could not link shared skills into workspace');
      }
    }
    return dir;
  }

  /** Permission policy: never blocks (this is an unattended daemon). Honors denylist. */
  private readonly canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> => {
    const denied = this.deps.config.disallowedTools ?? [];
    if (denied.includes(toolName)) {
      return { behavior: 'deny', message: `Tool ${toolName} is disabled by Zamolxis policy.` };
    }
    return { behavior: 'allow', updatedInput: input };
  };

  /** Per-conversation serialization tail: chains same-key runs so they can't race. */
  private readonly tails = new Map<string, Promise<unknown>>();
  /** Last turn per conversation (in-memory) so "wrong"/"escalate" can redo it on the smart model. */
  private readonly lastByKey = new Map<string, { text: string; reply: string }>();
  /** In-flight Claude turns keyed by conversationKey, so an agent's run can be aborted by Stop. */
  private readonly inFlight = new Map<string, AbortController>();

  /** A short user message that rejects the previous answer and asks to escalate. */
  private isEscalationTrigger(text: string): boolean {
    const t = (text ?? '').trim().toLowerCase();
    if (!t || t.length > 40) return false;
    return /^(escalate( this| it)?|wrong|that'?s wrong|that is wrong|incorrect|that'?s incorrect|not right|that'?s not right|no,? ?(that'?s )?(wrong|incorrect)|nope,? ?wrong|redo|try again|do it again|use claude|ask claude|bigger model)[.!]*$/i.test(t);
  }

  /** Run a named user-defined agent against a task, on its configured tier with only its tools.
   *  Runs in its own conversation context ("agent:<name>") so it doesn't pollute a user chat. */
  async runAgent(name: string, task?: string): Promise<RunResult & { agent?: string }> {
    const def = this.deps.agentStore?.get(name);
    if (!def) return { reply: `No agent named "${name}".`, sessionId: '', costUsd: 0, isError: true, agent: name };
    if (def.stopped) return { reply: `Agent "${def.name}" is stopped — resume it to run.`, sessionId: '', costUsd: 0, isError: true, agent: def.name };
    // The executor follows the planner-compiled spec verbatim (falls back to the raw job if not compiled).
    let agentJob = def.spec && def.spec.trim() ? def.spec : def.job;
    // Hybrid planning: when handed a specific task that differs from the standing job, the smart model
    // re-plans THAT task into literal steps before the cheap executor runs it.
    if (task && task.trim() && task.trim() !== def.job.trim()) {
      const adhoc = await this.replanTask(def, task).catch(() => undefined);
      if (adhoc) agentJob = adhoc;
    }
    // Tell the executor about any generated code tools and exactly how to invoke them.
    if (def.codeTools && def.codeTools.length) {
      agentJob += '\n\nGENERATED TOOLS (invoke via the sandbox_exec tool):\n' + def.codeTools.map((t) => `- ${t.name}: run \`${t.run}\``).join('\n');
    }
    // Authoritative current time from the host clock — so time-sensitive agents (e.g. "tell me the
    // time every minute") report the REAL time instead of hallucinating one. Computed fresh per run.
    agentJob = `CURRENT DATE/TIME = ${this.nowString()}\nThis is the ONLY correct current time. It OVERRIDES any other date/time you may have been given or trained on. If the user asks the time, answer with exactly this value (this timezone) — never convert it, guess, or use a different timezone.\n\n${agentJob}`;
    const route = def.model && def.model !== 'auto' ? def.model : undefined;
    const r = await this.run({
      conversationKey: `agent:${def.name}`,
      channel: 'agent',
      chatId: def.name,
      text: (task && task.trim()) || `Do your job now.`,
      route,
      agentJob,
      agentTools: def.tools,
      elevate: def.canElevate,
    });
    return { ...r, agent: def.name };
  }

  /** Stop (suspend) or resume an agent: toggles its `stopped` flag, suspends/resumes ALL its
   *  schedules (whoever created them, however), and aborts any in-flight run. */
  async stopAgent(name: string, stop = true): Promise<{ ok: boolean; suspended: number; stopped: boolean }> {
    const def = this.deps.agentStore?.setStopped(name, stop);
    if (!def) return { ok: false, suspended: 0, stopped: false };
    const suspended = this.deps.setAgentSchedulesEnabled?.(def.name, !stop) ?? 0;
    if (stop) {
      try {
        this.inFlight.get(`agent:${def.name}`)?.abort();
      } catch {
        /* best-effort */
      }
    }
    logger.info({ name: def.name, stop, suspended }, 'agent stop/resume');
    return { ok: true, suspended, stopped: stop };
  }

  /** Convert a plain-language schedule ("every 5 minutes", "weekdays at 9am") to a cron expression
   *  using the smart model. Returns { cron } or { cron: undefined } if it isn't a recurring schedule. */
  async nlToCron(text: string): Promise<{ cron?: string; note: string }> {
    const t = (text || '').trim();
    if (!t) return { note: 'empty' };
    const system =
      'Convert a plain-language schedule into a SINGLE standard 5-field cron expression (minute hour day-of-month month day-of-week). ' +
      'Output ONLY one JSON object: {"cron": string|null, "note": string}. cron is the expression (e.g. "*/5 * * * *" = every 5 minutes, "0 9 * * 1-5" = 9am weekdays); note is a short human-readable confirmation. ' +
      'If the text is not a recurring/timed schedule, output {"cron": null, "note": "why"}.';
    const raw = await this.oneShotClaude(system, `Schedule: ${t}\n\nJSON:`, this.deps.config.smartModel || this.deps.config.model);
    const o = this.parseJsonObject(raw);
    const cron = o && typeof o.cron === 'string' && o.cron.trim() ? o.cron.trim() : undefined;
    return { cron, note: o && typeof o.note === 'string' ? o.note : '' };
  }

  /** Current date/time as a string in the user's configured timezone (config.timezone), so agents
   *  report LOCAL time even when the daemon's host clock is on UTC. Falls back to the host clock. */
  private nowString(): string {
    const tz = this.deps.config.timezone;
    if (tz) {
      try {
        return (
          new Date().toLocaleString('en-US', {
            timeZone: tz,
            weekday: 'short',
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            timeZoneName: 'short',
          }) + ` (${tz})`
        );
      } catch {
        /* invalid timezone — fall through to host clock */
      }
    }
    return new Date().toString();
  }

  /** Tiers an agent executor can plausibly run on right now (for the planner to choose from). */
  private availableTiers(): string[] {
    const tiers: string[] = [];
    if (this.deps.config.localModel) tiers.push('local');
    try {
      if (freeProviderPool().length) tiers.push('freecloud');
    } catch {
      /* ignore */
    }
    tiers.push('claude');
    return tiers;
  }

  private parseJsonObject(s: string): Record<string, unknown> | null {
    if (!s) return null;
    const t = s.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const i = t.indexOf('{');
    const j = t.lastIndexOf('}');
    if (i < 0 || j <= i) return null;
    try {
      return JSON.parse(t.slice(i, j + 1)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /**
   * PLANNER: the smartest model compiles an agent's natural-language `job` into a literal,
   * executable plan that a cheaper executor model can follow without improvising — including
   * authoring any missing reference skills and generating runnable code tools — plus a risk
   * assessment and the recommended executor tier. Returns a summary for the UI.
   */
  async compileAgent(name: string): Promise<{
    ok: boolean;
    spec?: string;
    executor?: string;
    skills?: string[];
    codeTools?: { name: string; path: string; run: string }[];
    risk?: { level: 'low' | 'medium' | 'high'; note: string; recommendedModel?: string };
    schedule?: { cron: string; task?: string; humanReadable?: string };
    note?: string;
  }> {
    const store = this.deps.agentStore;
    const def = store?.get(name);
    if (!store || !def) return { ok: false, note: 'no such agent' };
    const tiers = this.availableTiers();
    const toolNames = buildLocalTools().names.join(', ');
    const skillIndex = (this.deps.skills?.detailsAll() ?? [])
      .slice(0, 40)
      .map((s) => `- ${s.name}: ${(s.description || '').slice(0, 90)}`)
      .join('\n');
    const system =
      'You are the PLANNER for an autonomous agent system. A user described an agent\'s job in plain language. Compile it into a precise, LITERAL plan that a SMALL, less-capable "executor" model can follow WITHOUT improvising or guessing. ' +
      'Return ONLY one JSON object (no prose, no code fences) of shape: ' +
      '{"spec": string, "tools": string[], "skills": [{"name":string,"description":string,"body":string}], "codeTools": [{"name":string,"language":"bash"|"python"|"node","description":string,"code":string}], "executor": string, "risk": {"level":"low"|"medium"|"high","note":string,"recommendedModel":string}, "schedule": {"cron":string,"task":string,"humanReadable":string}|null}. ' +
      'Rules: spec = numbered, literal steps; name the EXACT tools to call and with what inputs; leave nothing implicit. ' +
      'Choose "tools" ONLY from AVAILABLE TOOLS. Prefer existing AVAILABLE SKILLS; author a NEW skill (markdown knowledge/instructions) only when a needed capability is missing (max 3). ' +
      'Generate a codeTool (a runnable script) ONLY when tools+skills cannot do the job (max 2); if you do, the spec MUST instruct running it via the sandbox_exec tool and "tools" MUST include sandbox_exec. ' +
      'Assess risk: destructive, ambiguous, security-sensitive, or beyond-a-small-model jobs are medium/high — set recommendedModel to a stronger tier (up to "claude"). ' +
      '"executor" = the CHEAPEST tier that can reliably run the spec; low risk -> cheapest available, higher risk -> stronger. "executor" and "recommendedModel" MUST be one of the AVAILABLE TIERS tokens. ' +
      'SCHEDULE: if the STORY says the job should run repeatedly or at a time ("every minute", "each morning at 8", "hourly", "weekdays at 9"), set "schedule" to a 5-field cron expression + the task to run each time + a humanReadable phrase; otherwise schedule = null. ' +
      'The executor is ALWAYS given the authoritative current date/time at run time, so it can answer "what time is it" type jobs from that value — your spec can rely on it and must NOT tell the executor to guess the time.';
    const prompt =
      `AGENT NAME: ${def.name}\nUSER'S JOB DESCRIPTION:\n${def.job}\n\n` +
      `AVAILABLE TOOLS: ${toolNames}\n\nAVAILABLE SKILLS:\n${skillIndex || '(none)'}\n\nAVAILABLE TIERS: ${tiers.join(', ')}\n\n` +
      'Compile the plan now. Output ONLY the JSON object.';
    const raw = await this.oneShotClaude(system, prompt, this.deps.config.smartModel || this.deps.config.model);
    const plan = this.parseJsonObject(raw);
    if (!plan) {
      // Planner failed — leave the agent runnable on its raw job, flag medium risk so the user knows.
      const risk = { level: 'medium' as const, note: 'Planner could not compile a structured plan; running on the raw job.', recommendedModel: 'claude' };
      store.attachPlan(def.name, { risk });
      // Even if compilation failed, honor a cadence stated in the job so recurring still works.
      const scheduled = await this.ensureScheduleFromJob(def);
      return { ok: false, risk, schedule: scheduled, note: 'planner returned unparseable output' };
    }
    const applied = this.applyPlan(def.name, plan);
    const validTiers = new Set([...tiers, 'auto']);
    const rawRisk = (plan.risk ?? {}) as { level?: string; note?: string; recommendedModel?: string };
    const level: 'low' | 'medium' | 'high' = rawRisk.level === 'low' || rawRisk.level === 'high' ? rawRisk.level : rawRisk.level === 'medium' ? 'medium' : 'medium';
    const recommendedModel = typeof rawRisk.recommendedModel === 'string' && validTiers.has(rawRisk.recommendedModel) ? rawRisk.recommendedModel : 'claude';
    const risk = { level, note: String(rawRisk.note || '').slice(0, 300), recommendedModel };
    // Executor: planner's pick if valid; otherwise risk-appropriate default. High risk never runs cheaper than recommended.
    let executor = typeof plan.executor === 'string' && validTiers.has(plan.executor) ? plan.executor : level === 'high' ? recommendedModel : tiers[0] || 'claude';
    if (level === 'high') executor = recommendedModel; // high-risk jobs run on the recommended (stronger) tier by default
    const spec = typeof plan.spec === 'string' ? plan.spec.trim() : '';
    // Respect an explicitly pinned tier; only auto-assign the executor when the user left it on 'auto'.
    const keepModel = !!def.model && def.model !== 'auto';
    const finalExecutor = keepModel ? def.model : executor;
    store.attachPlan(def.name, { spec: spec || undefined, skills: applied.skills, codeTools: applied.codeTools, risk, model: keepModel ? undefined : executor });
    // If the STORY implied a recurring schedule, set it up deterministically — but only when the
    // agent has none yet, so re-compiles and any manually-added schedules aren't duplicated/clobbered.
    let scheduled: { cron: string; task?: string; humanReadable?: string } | undefined;
    const sched = (plan.schedule ?? null) as { cron?: string; task?: string; humanReadable?: string } | null;
    if (sched && typeof sched.cron === 'string' && sched.cron.trim() && (this.deps.countAgentSchedules?.(def.name) ?? 0) === 0) {
      this.deps.scheduleAgent?.(def.name, sched.cron.trim(), sched.task);
      scheduled = { cron: sched.cron.trim(), task: sched.task, humanReadable: sched.humanReadable };
      logger.info({ name: def.name, cron: scheduled.cron }, 'planner auto-scheduled agent from story');
    }
    // Deterministic fallback: the planner sometimes omits the schedule even when the story clearly
    // states a cadence ("every minute"). Catch that so recurring agents reliably get a real cron.
    if (!scheduled) scheduled = await this.ensureScheduleFromJob(def);
    return { ok: true, spec: spec || undefined, executor: finalExecutor, skills: applied.skills, codeTools: applied.codeTools, risk, schedule: scheduled };
  }

  /** ANALYZE: the smartest model reviews what the agent has actually produced (recent runs) against
   *  its job and rewrites the execution spec to make future results better. */
  async analyzeAgent(name: string): Promise<{ ok: boolean; assessment?: string; changed?: boolean; note?: string }> {
    const store = this.deps.agentStore;
    const def = store?.get(name);
    if (!store || !def) return { ok: false, note: 'no such agent' };
    const recent = (this.deps.sessionIndex?.recent(`agent:${def.name}`, 12) ?? [])
      .map((t) => `[${t.role}] ${String(t.text).slice(0, 500)}`)
      .join('\n');
    const system =
      'You IMPROVE a focused agent. Given its JOB, its current EXECUTION SPEC (the literal instructions a small executor model follows), and a sample of its RECENT OUTPUTS, judge whether the outputs actually satisfy the job. Then rewrite the SPEC so future results are better — clearer, more literal, and fixing whatever caused weak or wrong outputs. Assume the executor is a small model that needs explicit, unambiguous steps. ' +
      'Return ONLY one JSON object: {"assessment": string (2-4 sentences: what works, what is wrong), "improvedSpec": string (the FULL revised spec), "changed": boolean (true only if you actually improved it)}.';
    const prompt =
      `JOB:\n${def.job}\n\nCURRENT SPEC:\n${def.spec || '(none — it runs on the raw job)'}\n\nRECENT OUTPUTS (newest first):\n${recent || '(no runs recorded yet)'}\n\nJSON:`;
    const raw = await this.oneShotClaude(system, prompt, this.deps.config.smartModel || this.deps.config.model);
    const o = this.parseJsonObject(raw);
    if (!o) return { ok: false, note: 'analyzer returned unparseable output' };
    const improved = typeof o.improvedSpec === 'string' ? o.improvedSpec.trim() : '';
    const changed = !!o.changed && improved.length > 10 && improved !== (def.spec || '').trim();
    if (changed) store.attachPlan(def.name, { spec: improved });
    logger.info({ name: def.name, changed }, 'agent analyzed');
    return { ok: true, assessment: typeof o.assessment === 'string' ? o.assessment : '', changed };
  }

  /** Deterministic schedule extraction: if the job text states a cadence and the agent has no
   *  schedule yet, convert that cadence to a cron and create the job. Backstop for planner variance. */
  private async ensureScheduleFromJob(def: { name: string; job: string }): Promise<{ cron: string; humanReadable?: string } | undefined> {
    if ((this.deps.countAgentSchedules?.(def.name) ?? 0) > 0) return undefined;
    if (!/\b(every|each|hourly|daily|weekly|minute|minutes|hour|hours|morning|evening|night|noon|midnight|weekday|weekdays|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(def.job)) return undefined;
    const r = await this.nlToCron(def.job).catch(() => ({ cron: undefined as string | undefined, note: '' }));
    if (!r.cron) return undefined;
    this.deps.scheduleAgent?.(def.name, r.cron, undefined);
    logger.info({ name: def.name, cron: r.cron }, 'schedule extracted from job text (deterministic fallback)');
    return { cron: r.cron, humanReadable: r.note };
  }

  /** Author the planner's new skills + write its generated code tools to disk. */
  private applyPlan(
    agentName: string,
    plan: Record<string, unknown>,
  ): { skills: string[]; codeTools: { name: string; path: string; run: string }[] } {
    const slugish = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'tool';
    const skills: string[] = [];
    const skillSpecs = Array.isArray(plan.skills) ? (plan.skills as Array<{ name?: string; description?: string; body?: string }>).slice(0, 3) : [];
    for (const s of skillSpecs) {
      if (!s || !s.name || !s.body || !this.deps.skills) continue;
      try {
        skills.push(this.deps.skills.write(String(s.name), String(s.description || ''), String(s.body)));
      } catch (err) {
        logger.warn({ err: String(err) }, 'planner skill authoring failed');
      }
    }
    const codeTools: { name: string; path: string; run: string }[] = [];
    const toolSpecs = Array.isArray(plan.codeTools) ? (plan.codeTools as Array<{ name?: string; language?: string; code?: string }>).slice(0, 2) : [];
    for (const t of toolSpecs) {
      if (!t || !t.name || !t.code) continue;
      try {
        const lang = t.language === 'python' ? 'python' : t.language === 'node' ? 'node' : 'bash';
        const ext = lang === 'python' ? 'py' : lang === 'node' ? 'js' : 'sh';
        const runner = lang === 'python' ? 'python' : lang === 'node' ? 'node' : 'bash';
        const dir = path.join(this.deps.config.dataDir, 'agent-tools', agentName);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${slugish(String(t.name))}.${ext}`);
        fs.writeFileSync(file, String(t.code));
        codeTools.push({ name: String(t.name), path: file, run: `${runner} "${file}"` });
      } catch (err) {
        logger.warn({ err: String(err) }, 'planner code-tool generation failed');
      }
    }
    return { skills, codeTools };
  }

  /** Hybrid re-plan: turn a specific run-time task into literal steps (lighter than a full compile). */
  private async replanTask(def: { job: string; spec?: string; tools?: string[] }, task: string): Promise<string | undefined> {
    const system =
      'You are the planner for a focused agent. Turn the NEW TASK into literal, numbered step-by-step instructions a small executor model can follow without improvising. Use the agent\'s standing job and compiled spec as context, and name exact tools. Output ONLY the instructions — no preamble, no JSON.';
    const prompt =
      `AGENT JOB:\n${def.job}\n\nCOMPILED SPEC:\n${def.spec || '(none)'}\n\nALLOWED TOOLS: ${def.tools && def.tools.length ? def.tools.join(', ') : '(default toolset)'}\n\nNEW TASK FOR THIS RUN:\n${task}\n\nInstructions:`;
    const out = await this.oneShotClaude(system, prompt, this.deps.config.smartModel || this.deps.config.model);
    return out && out.trim().length > 5 ? out.trim() : undefined;
  }

  /** Deliver a message from an agent (or the assistant) to the user or another agent. To the user:
   *  surfaced to the UI/CLI via onAgentMessage. To an agent: bounded follow-up run (loop guard). */
  async sendAgentMessage(from: string, to: string, text: string): Promise<string> {
    const t = (text || '').trim();
    if (!t) return 'Nothing to send (empty message).';
    const ts = Date.now();
    if (/^user$/i.test(to)) {
      this.deps.onAgentMessage?.({ from, to: 'user', text: t, ts });
      return 'Delivered to the user.';
    }
    const target = this.deps.agentStore?.get(to);
    if (!target) return `No agent named "${to}" (use "user" to message the user).`;
    this.deps.onAgentMessage?.({ from, to: target.name, text: t, ts }); // surface inter-agent traffic too
    if (AGENT_HOPS >= MAX_AGENT_HOPS) return `Loop guard: too many agent hops in flight, not running ${target.name}.`;
    AGENT_HOPS++;
    void this.runAgent(target.name, `Message from ${from}: ${t}`)
      .then((r) => this.deps.onAgentMessage?.({ from: target.name, to: from, text: r.reply, ts: Date.now() }))
      .catch((err) => logger.warn({ err: String(err) }, 'agent-to-agent run failed'))
      .finally(() => { AGENT_HOPS = Math.max(0, AGENT_HOPS - 1); });
    return `Sent to agent "${target.name}"; it will act on it.`;
  }

  async run(req: RunRequest): Promise<RunResult> {
    const key = req.conversationKey;
    const { config } = this.deps;

    // User-driven escalation: if the user rejects the previous answer with a short
    // "wrong" / "escalate" / "try again", redo the ORIGINAL request on the smart model.
    const prev = this.lastByKey.get(key);
    let effReq = req;
    let originalText = req.text;
    if (prev && this.isEscalationTrigger(req.text)) {
      originalText = prev.text;
      effReq = {
        ...req,
        route: 'claude',
        escalated: true,
        model: config.smartModel || config.model,
        text:
          `The user replied "${req.text.trim()}" — they were NOT satisfied with the previous answer and want you, the more capable model, to handle it correctly.\n\n` +
          `Their original request was:\n"${prev.text}"\n\nThe earlier (rejected) answer was:\n"${prev.reply.slice(0, 1500)}"\n\nCarry out the original request properly now.`,
      };
      logger.info({ key }, 'user-requested escalation — redoing the previous request on the smart model');
    }

    const prior = this.tails.get(key) ?? Promise.resolve();
    // Wait for the previous turn IN THIS CONVERSATION to finish (so resuming the
    // same session can't overlap), then run through the global throttle. Different
    // conversations have independent tails, so they still run concurrently.
    const result = prior
      .catch(() => {})
      .then(() => this.deps.throttle.run(() => this.runInner(effReq)));
    // Remember this turn (keyed to the ORIGINAL request text) so a follow-up
    // "wrong"/"escalate" re-targets the same request.
    void result.then(
      (r) => {
        if (r && !r.isError && r.reply) this.lastByKey.set(key, { text: originalText, reply: r.reply });
      },
      () => {},
    );
    const tail = result.then(
      () => {},
      () => {},
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** Capabilities the offline local model lacks entirely (no http_get can supply them). */
  private hardClaudeOnly(text: string): boolean {
    return /\b(schedul|remind|cron|run|exec|execute|command|shell|bash|terminal|\bfile\b|folder|directory|install|deploy|email|e-?mail|send|post|tweet|publish|upload|create (a )?(skill|tab|dashboard)|\bskill\b|dashboard|\btab\b|remember|memori[sz]e|forget|note that|\bcode\b|script|compile|\bgit\b)\b/i.test(text);
  }

  /** Signals that the turn needs the web or live/current information. */
  private needsExternal(text: string): boolean {
    return /\b(internet|online|\bweb\b|browse|http|url|fetch|download|connect|crawl|scrape|search|google|look ?up|find (out|the|me)|\bnow\b|today|tonight|tomorrow|yesterday|current|currently|latest|recent|live|real[- ]?time|up[- ]?to[- ]?date|news|headline|score|standings|weather|forecast|\bprice\b|stock|market|who won|when (is|was|does|did|will)|how much|home ?assistant|\bapi\b)\b/i.test(text);
  }

  /** Trivial = short, offline-answerable, no external or hard-capability need. */
  private looksSimple(text: string): boolean {
    const t = text.trim();
    if (!t || t.length > 280) return false;
    if (t.includes('```')) return false;
    return !this.hardClaudeOnly(t) && !this.needsExternal(t);
  }

  /**
   * Answer a turn with the on-device model (no subscription used), running a bounded
   * TOOL-USE loop: the local model can call http_get / web_search; WE execute those
   * and feed results back. This is what lets the offline model reach the internet —
   * it requests a fetch, our code performs it. It must report only real tool output
   * and never fabricate. In auto-mode it may still emit "<ESCALATE>"; any hard
   * failure also escalates. Usage is recorded (summed across rounds) as "local:<model>".
   */
  /** Shared assistant system prompt + tools for the tool-using models (local & free cloud). */
  private buildAssistant(allowEscalate: boolean, query = '', agent?: { job?: string; tools?: string[] }): { system: string; tools: LocalToolset } {
    const { config } = this.deps;
    let tools = buildLocalTools();
    // Agent tool restriction: expose ONLY the tools this agent is allowed to use.
    if (agent?.tools && agent.tools.length) {
      const allow = new Set(agent.tools);
      const defs = tools.defs.filter((d) => allow.has((d as { function?: { name?: string } }).function?.name ?? ''));
      const names = tools.names.filter((n) => allow.has(n));
      const baseExec = tools.exec;
      tools = { names, defs, exec: (name: string, args: Record<string, unknown>) => (allow.has(name) ? baseExec(name, args) : Promise.resolve('That tool is not available to this agent.')) };
    }
    const hasSearch = tools.names.includes('web_search');
    const noSearchNote =
      'You do NOT have web search. Only http_get a SPECIFIC URL you were given or that a skill provides. Do NOT fetch search engines (google.com, bing.com) or guess/invent URLs. If you do not have the exact URL for what is asked, say you cannot look it up and that web search can be enabled by adding a Tavily or Brave API key in Settings.';
    const toolsLine = `You have TOOLS that fetch REAL data — call them; report ONLY what a tool actually returns; NEVER fabricate results, sources, errors, or actions; and NEVER show raw tool-call JSON to the user (either call the tool, or answer in plain language). Tools: ${tools.names.join(', ')}. http_get(url, headers?) fetches a SPECIFIC URL — public JSON APIs or your local network such as Home Assistant. read_url(url) fetches a web PAGE and returns its READABLE TEXT (HTML stripped) — use it to actually read an article/page (e.g. one web_search returned), instead of http_get on a web page. ${hasSearch ? 'web_search(query) searches the web — ALWAYS use web_search to find information, then read_url the best result; do NOT http_get a search engine like google.com or bing.com.' : noSearchNote} You have no other abilities (no files, no shell, no scheduling, no memory writes).`;
    const safety =
      'Be honest and concise. Refuse ONLY genuinely harmful or illegal requests — do NOT refuse ordinary, harmless questions (sports scores, general facts, casual chat).';
    const escalateRule = allowEscalate
      ? 'IMPORTANT — how to give up: if you cannot fully and confidently DO the request yourself right now (you are unsure, do not know the answer, need info you cannot fetch, need files/shell/scheduling/skills/multi-step reasoning, or a tool call failed), reply with EXACTLY the single word ESCALATE and nothing else. NEVER instead: make excuses, apologize, ask the user to find IDs or create groups or check their setup, or ask a clarifying question and stop — that is forbidden. If you would otherwise ask the user to do part of the work, reply ESCALATE so the smartest Claude model takes over and does it.'
      : 'If you cannot complete the request with your tools, say briefly and honestly that you cannot — do not pretend or guess.';
    // Only the skills RELEVANT to this request (so a large external library — e.g. Hermes —
    // doesn't flood the prompt). Falls back to a capped list when there's no query.
    const skills = query ? (this.deps.skills?.relevant(query, 8) ?? []) : (this.deps.skills?.list() ?? []).slice(0, 8);
    const skillsHint = skills.length
      ? `Relevant skills — these are PROCEDURES to follow, NOT tools to call. To use one, just DO what its description says using your real tools (http_get / web_search) or plain reasoning. Your ONLY callable tools are ${tools.names.join(', ')} — NEVER reply with a skill's name, and never emit a function/tool call as text.\n${skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')}`
      : undefined;
    // Keep context LEAN: a small model loses tool results in a big prompt (then fabricates).
    const profile = this.deps.memory.getUser().replace(/^#.*$/m, '').trim();
    const profileHint = profile ? `About the user:\n${profile}` : undefined;
    const persona = `You are ${effectiveName(config.agentName)}, the user's personal assistant. Be concise.`;
    const nowLine = `Right now it is ${this.nowString()}. This is the authoritative current time — if asked the time, report exactly this; also use it to judge whether a dated event is in the PAST or upcoming — never describe a past event as if it is still to come (e.g. do not offer tickets/odds for a game that already happened).`;
    const searchSynth = hasSearch
      ? "When you web_search: pick the most AUTHORITATIVE on-topic result (official, league, ESPN, or encyclopedia pages over ticket/betting/preview pages) and ANSWER THE USER'S ACTUAL QUESTION directly in 1-2 sentences with the specific fact. Do NOT paste ticket prices, betting odds, moneylines, streaming/\"watch\" options, or other details the user didn't ask for. If the top result is a betting/preview page, look for the answer in another result instead of dumping it."
      : undefined;
    const learned = query ? this.deps.memory.relevantLearningsBlock(query) : this.deps.memory.learningsBlock();
    // An agent's job leads the prompt so the model stays on its specific task.
    const agentRole = agent?.job ? `YOU ARE A FOCUSED AGENT. YOUR JOB:\n${agent.job}\nDo exactly this job using only your available tools; do not drift off-task.` : undefined;
    const system = [agentRole, toolsLine, searchSynth, safety, escalateRule, persona, nowLine, profileHint, learned, skillsHint, config.systemPromptAppend]
      .filter(Boolean)
      .join('\n\n');
    return { system, tools };
  }

  /** OpenAI-compatible tool-use loop (local Ollama or a free cloud provider). */
  private async toolLoop(o: { url: string; model: string; apiKey?: string; system: string; userText: string; tools: LocalToolset; history?: Array<{ role: string; content: string }> }): Promise<{
    failed: boolean;
    exhausted: boolean;
    finalText: string;
    inTok: number;
    outTok: number;
    searched: boolean;
  }> {
    // System, then the prior conversation (so a model that didn't answer earlier turns still
    // knows what was discussed), then this turn's user message.
    const messages: Array<Record<string, unknown>> = [
      { role: 'system', content: o.system },
      ...(o.history ?? []),
      { role: 'user', content: o.userText },
    ];
    const MAX_STEPS = 5;
    let inTok = 0;
    let outTok = 0;
    let finalText = '';
    let exhausted = false;
    let searched = false; // did the model actually fetch real data (web_search/http_get)?
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), this.deps.config.turnTimeoutMs);
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (o.apiKey) headers.Authorization = `Bearer ${o.apiKey}`;
        const res = await fetch(o.url, {
          method: 'POST',
          signal: ac.signal,
          headers,
          body: JSON.stringify({ model: o.model, stream: false, messages, tools: o.tools.defs }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          logger.warn({ status: res.status, url: o.url, model: o.model, body: body.slice(0, 400) }, 'tool-model HTTP error');
          return { failed: true, exhausted: false, finalText: '', inTok, outTok, searched };
        }
        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        inTok += data.usage?.prompt_tokens ?? 0;
        outTok += data.usage?.completion_tokens ?? 0;
        const m = data.choices?.[0]?.message;
        let calls = m?.tool_calls ?? [];
        if (!calls.length) {
          const leaked = extractLeakedToolCall(m?.content ?? '');
          if (leaked) calls = [{ id: `call_${step}_0`, function: { name: leaked.name, arguments: JSON.stringify(leaked.args) } }];
        }
        if (calls.length && step >= MAX_STEPS - 1) {
          exhausted = true;
          break;
        }
        if (calls.length) {
          const normCalls = calls.map((tc, i) => ({
            id: tc.id || `call_${step}_${i}`,
            type: 'function' as const,
            function: { name: tc.function?.name ?? '', arguments: tc.function?.arguments || '{}' },
          }));
          messages.push({ role: 'assistant', content: m?.content ?? '', tool_calls: normCalls });
          for (const tc of normCalls) {
            if (tc.function.name === 'web_search' || tc.function.name === 'http_get') searched = true;
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(tc.function.arguments || '{}');
            } catch {
              /* malformed args */
            }
            const out = await o.tools.exec(tc.function.name, args);
            messages.push({ role: 'tool', tool_call_id: tc.id, content: out.slice(0, 8000) });
          }
          continue;
        }
        finalText = (m?.content ?? '').trim();
        break;
      }
    } catch (err) {
      clearTimeout(timeout);
      logger.warn({ err: String(err), url: o.url }, 'tool-model turn failed');
      return { failed: true, exhausted: false, finalText: '', inTok, outTok, searched };
    } finally {
      clearTimeout(timeout);
    }
    return { failed: false, exhausted, finalText, inTok, outTok, searched };
  }

  /** Decide hand-off vs answer from a tool-loop outcome (shared by local & cloud). */
  private finishAssistantTurn(req: RunRequest, allowEscalate: boolean, r: { failed: boolean; exhausted: boolean; finalText: string; searched?: boolean }, isLocal = false): { escalate: boolean; result?: RunResult } {
    if (r.failed) return { escalate: true };
    let finalText = r.finalText;
    if (extractLeakedToolCall(finalText) || looksLikeLeakedCall(finalText)) {
      if (allowEscalate) return { escalate: true };
      finalText = 'I could not complete that with the tools I have here.';
    }
    // Anti-fabrication, LOCAL ONLY: the tiny on-device model answering a current/live
    // question without searching is almost certainly made up. Capable cloud providers
    // (e.g. Groq 70B) are trusted to answer — forcing them to escalate would needlessly
    // push live facts onto Claude and defeat the free-provider tier.
    if (isLocal && allowEscalate && needsCurrentInfo(req.text) && !r.searched) return { escalate: true };
    if (allowEscalate && (r.exhausted || wantsEscalate(finalText) || looksLikePunt(finalText))) return { escalate: true };
    const reply = finalText || '(no reply)';
    const now = Date.now();
    this.deps.sessionIndex?.record(req.conversationKey, 'user', req.text, now);
    this.deps.sessionIndex?.record(req.conversationKey, 'assistant', reply, now);
    return { escalate: false, result: { reply, sessionId: '', costUsd: 0, isError: false } };
  }

  /** Prior turns of THIS conversation as OpenAI-style messages, so a model that didn't answer
   *  earlier turns still has the thread. Capped (turns + per-message chars) to fit small local
   *  context windows. Roles are normalized to user/assistant. The current turn isn't recorded yet. */
  private recentHistory(conversationKey: string, maxTurns = 8, maxChars = 1500): Array<{ role: string; content: string }> {
    const turns = this.deps.sessionIndex?.recent(conversationKey, maxTurns) ?? [];
    return turns
      .filter((t) => t.text && t.text.trim())
      .map((t) => ({ role: t.role === 'assistant' ? 'assistant' : 'user', content: t.text.slice(0, maxChars) }));
  }

  /** Answer with the on-device model via the shared tool loop (no subscription used). */
  private async answerLocal(req: RunRequest, allowEscalate: boolean): Promise<{ escalate: boolean; result?: RunResult }> {
    const lm = this.deps.config.localModel!;
    const { system, tools } = this.buildAssistant(allowEscalate, req.text, { job: req.agentJob, tools: req.agentTools });
    const history = this.recentHistory(req.conversationKey);
    const r = await this.toolLoop({ url: `${lm.url}/chat/completions`, model: lm.model, system, userText: req.text, tools, history });
    if (!r.failed) this.deps.usage?.recordEngine({ [`local:${lm.model}`]: { inputTokens: r.inTok, outputTokens: r.outTok, costUSD: 0 } }, 0);
    const out = this.finishAssistantTurn(req, allowEscalate, r, /* isLocal */ true);
    if (out.result) out.result.via = `Local (${lm.model})`;
    return out;
  }

  /** Answer with a specific cloud provider (free or paid) via the shared tool loop. */
  private async answerProvider(req: RunRequest, p: ProviderDef, allowEscalate: boolean): Promise<{ escalate: boolean; result?: RunResult }> {
    const key = process.env[p.envKey];
    if (!key) return { escalate: true };
    const { system, tools } = this.buildAssistant(allowEscalate, req.text, { job: req.agentJob, tools: req.agentTools });
    const history = this.recentHistory(req.conversationKey);
    const r = await this.toolLoop({ url: `${p.baseUrl}/chat/completions`, model: p.model, apiKey: key, system, userText: req.text, tools, history });
    recordProviderUse(p.id);
    if (!r.failed) this.deps.usage?.recordEngine({ [`${p.kind}:${p.id}:${p.model}`]: { inputTokens: r.inTok, outputTokens: r.outTok, costUSD: 0 } }, 0);
    if (!r.failed) logger.info({ provider: p.id, kind: p.kind }, 'cloud provider handled the turn');
    const out = this.finishAssistantTurn(req, allowEscalate, r);
    if (out.result) out.result.via = `${p.label} (${p.model})`;
    return out;
  }

  /** Try FREE providers in turn (least-used first) until one answers, only THEN hand off.
   *  For current/live FACT questions, restrict to STRONG providers (never mistral-small).
   *  Trying the whole pool first keeps live facts on the free tier instead of jumping to
   *  Claude the moment one provider is rate-limited or errors. */
  private async answerFreeCloud(req: RunRequest, allowEscalate: boolean): Promise<{ escalate: boolean; result?: RunResult }> {
    const pool = freeProviderPool({ strongOnly: needsCurrentInfo(req.text) });
    if (!pool.length) return { escalate: true };
    for (let i = 0; i < pool.length; i++) {
      const p = pool[i]!;
      const lastProvider = i === pool.length - 1;
      // Non-last providers may "give up" so we move to the NEXT free provider. The last one
      // uses the caller's escalate setting: escalate to Claude (if it's the fallback) or, when
      // there is no Claude, give a best-effort answer instead of bailing.
      const r = await this.answerProvider(req, p, lastProvider ? allowEscalate : true);
      if (!r.escalate && r.result) return r;
      logger.info({ provider: p.id }, 'free provider could not handle it — trying the next');
    }
    return { escalate: true };
  }

  /** Run one routing-chain tier ('local' | 'freecloud' | <providerId>). */
  private async attemptTier(tier: string, req: RunRequest, allowEscalate: boolean): Promise<{ escalate: boolean; result?: RunResult }> {
    if (tier === 'local') return this.deps.config.localModel ? this.answerLocal(req, allowEscalate) : { escalate: true };
    if (tier === 'freecloud') return this.answerFreeCloud(req, allowEscalate);
    const p = providerById(tier);
    if (p) return this.answerProvider(req, p, allowEscalate);
    return { escalate: true }; // unknown token (e.g. 'claude' is handled separately)
  }

  /** Plan the pre-Claude tiers to attempt + whether Claude is the final fallback. */
  private planRoute(req: RunRequest): { tiers: string[]; claude: boolean } {
    const { config } = this.deps;
    const chain = config.routeChain;
    const claudeIn = chain.includes('claude');
    // An agent with canElevate may fall back to Claude even on a fixed tier / chain without it.
    const elev = !!req.elevate;
    // Drop 'local' if the user turned local routing off (keeps that toggle meaningful).
    const cloud = chain.filter((t) => t !== 'claude').filter((t) => !(t === 'local' && config.localRouting === 'off'));
    if (req.route === 'claude') return { tiers: [], claude: true }; // explicit → Claude
    if (req.escalated) return claudeIn ? { tiers: [], claude: true } : { tiers: cloud.slice(-1), claude: false };
    if (req.route === 'local') return { tiers: cloud.includes('local') ? ['local'] : cloud.slice(0, 1), claude: elev };
    if (req.route === 'freecloud') return { tiers: ['freecloud'], claude: claudeIn || elev }; // explicit → rotate free providers
    if (req.route && req.route !== 'auto' && providerById(req.route)) return { tiers: [req.route], claude: claudeIn || elev }; // explicit provider id
    // Agent runs follow their configured tier/chain and only escalate via canElevate — do NOT force
    // Claude for "current info" (e.g. "what time is it"): the time is injected, so a cheap tier suffices.
    if (req.agentJob) return { tiers: cloud, claude: claudeIn || elev };
    if (this.hardClaudeOnly(req.text) && claudeIn) return { tiers: [], claude: true }; // needs Claude-only tools
    // Live/current-fact questions: the tiny local model mis-reasons even WHEN it searches
    // (grabs the wrong game, can't map "two nights ago", defaults the venue) — so skip
    // 'local' and use a capable tier: free cloud (e.g. Groq 70B) first, then Claude. With a
    // free-cloud key this is free and accurate; it only falls to Claude if nothing else exists.
    if (needsCurrentInfo(req.text)) {
      const stronger = cloud.filter((t) => t !== 'local');
      if (stronger.length || claudeIn) return { tiers: stronger, claude: claudeIn || elev };
    }
    return { tiers: cloud, claude: claudeIn || elev };
  }

  private async runInner(req: RunRequest): Promise<RunResult> {
    const { config, sessions } = this.deps;

    // Local-first routing: answer eligible turns with the on-device model so the
    // Claude subscription isn't touched at all. Auto-mode escalates to Claude when
    // the local model says it can't handle it (or on any local failure).
    // Walk the user-ordered routing chain (local / free cloud / paid providers), each
    // tier handing off to the next when it can't cope. Claude is the final fallback
    // ONLY if it's in the chain (so "local only" / "local + free" work with no Claude).
    const plan = this.planRoute(req);
    for (let i = 0; i < plan.tiers.length; i++) {
      const isLast = i === plan.tiers.length - 1 && !plan.claude;
      const r = await this.attemptTier(plan.tiers[i]!, req, /* allowEscalate */ !isLast);
      if (!r.escalate && r.result) {
        // Profile capture runs for ANY tier that answers (not just Claude), so durable
        // facts about the user are recorded even when local/free-cloud handled the turn.
        if (mentionsSelf(req.text)) void this.captureProfile(req).catch((err) => logger.warn({ err: String(err) }, 'profile-capture failed'));
        // Remember the ANSWER to a live/factual question (from a trustworthy tier) so the local
        // model can answer it from the knowledge store next time instead of re-searching/guessing.
        if (needsCurrentInfo(req.text) && r.result.via && !/^Local/.test(r.result.via)) {
          void this.captureFact(req, r.result.reply).catch((err) => logger.warn({ err: String(err) }, 'fact-capture failed'));
        }
        return r.result;
      }
      logger.info({ key: req.conversationKey, tier: plan.tiers[i] }, 'routing tier handed off');
    }
    if (!plan.claude) {
      return {
        reply: 'I could not handle that with the configured models, and Claude is not in your routing chain. Add a stronger provider or enable Claude in the Providers panel.',
        sessionId: '',
        costUsd: 0,
        isError: true,
        errorKind: 'no_backend',
      };
    }
    if (plan.tiers.length) req.onProgress?.(`(handed to ${config.smartModel || config.model || 'Claude'}…)\n\n`);
    // If lighter tiers were tried first, this turn needed more — give it the strong model.
    const escalatedFromLocal = plan.tiers.length > 0;
    const escalated = escalatedFromLocal || req.escalated === true;
    // When a turn reaches Claude via escalation (the local model couldn't, or the user
    // said "wrong"/"escalate"), direct the smart model to TEACH the system so the local
    // model can handle it next time — save reusable facts via `learn` and/or a skill.
    const escalationHint = escalated
      ? 'NOTE: this request reached you because the on-device local model could not handle it (or the user escalated). Handle it fully with your tools. THEN teach the system so the local model can do it next time: call `learn` to save a DURABLE, REUSABLE lesson — a device-id mapping like "bedroom lights = light.master, light.kids", an API endpoint, a config value, a fix, or a METHOD ("for live scores/news/weather, web_search with names+year") — tagged by topic; and if it is a repeatable procedure, also `create_skill`. NEVER `learn` a TRANSIENT/time-bound fact (a score, price, weather reading, headline, date, or one-off result) — those expire and are useless later. If nothing durable was learned, do not call `learn`.'
      : undefined;

    const existing = sessions.get(req.conversationKey);
    const workspace = existing?.workspace ?? this.ensureWorkspace(req.conversationKey, req.displayName);

    const localHint = config.localModel
      ? `A fast on-device model (${config.localModel.model}) is available via the \`ask_local_model\` tool. Offload trivial subtasks to it — summarizing, classifying, extracting, reformatting, drafting boilerplate — to conserve subscription quota; do the substantive reasoning yourself and sanity-check its output.`
      : undefined;
    // Name lock LAST so nothing in the curated SOUL/USER/MEMORY blocks can make the
    // agent quietly answer to a different name than the one shown in the UI. The
    // single source of truth for the name is config.agentName (Settings → Agent name).
    const dispName = effectiveName(config.agentName);
    const nameLock = `Your name is "${dispName}" — always identify as "${dispName}", regardless of anything in the persona, profile, or memory above, and it must match what the interface shows. If the user asks you to go by a different name for a while, call the \`set_display_name\` tool (do not just claim a new name in text).`;
    const memoryAware =
      'Your profile, working memory, and learned facts shown above ARE your own memory — read them here and update them with the `memory` tool (and `learn` for reusable findings). NEVER tell the user you "cannot access" your memory, your notes, or files: you have full filesystem and shell tools in your workspace, and `search_history` for past conversations. If asked what you remember or what is in your memory, answer from the blocks above and your tools — do not deflect.';
    const laws = config.lawsEnabled ? this.deps.memory.lawsBlock() : '';
    // The SDK has WebFetch (fetch a known URL) but NO web-search tool. Without a
    // configured search provider the agent literally cannot search — make that
    // actionable instead of a vague "I don't have real-time access".
    const searchHint = !localSearchAvailable()
      ? 'You can WebFetch a specific known URL, but you have NO web-search tool. If a request needs searching the web or current/live info you cannot reach via a known URL, do not guess at bot-blocked sites — briefly tell the user to add a free Tavily or Brave API key in Settings → Credentials to enable web search.'
      : undefined;
    // Surface the skills relevant to this request (own + external libraries like Hermes), with
    // file paths so the model can read the full SKILL.md if it wants to follow the procedure.
    const relSkills = (this.deps.skills as { relevant?: (q: string, n?: number) => Array<{ name: string; description: string }>; detailsAll?: () => Array<{ name: string; file: string }> } | undefined)?.relevant?.(req.text, 8) ?? [];
    let skillsHint: string | undefined;
    if (relSkills.length) {
      const files = new Map((this.deps.skills?.detailsAll?.() ?? []).map((s) => [s.name, s.file] as const));
      skillsHint = `## Skills relevant to this request — if one fits, read its SKILL.md and follow it:\n${relSkills
        .map((s) => `- ${s.name}: ${s.description}${files.get(s.name) ? ` (read: ${files.get(s.name)})` : ''}`)
        .join('\n')}`;
    }
    const agentRole = req.agentJob ? `YOU ARE A FOCUSED AGENT. YOUR JOB:\n${req.agentJob}\nDo exactly this job; stay on task.` : undefined;
    const append = [agentRole, laws, buildPersona(dispName), this.deps.memory.systemPromptBlock(), memoryAware, skillsHint, escalationHint, searchHint, localHint, config.systemPromptAppend, nameLock]
      .filter(Boolean)
      .join('\n\n');

    const channel = req.channel ?? req.conversationKey.split(':')[0] ?? 'cli';
    const chatId = req.chatId ?? req.conversationKey.split(':').slice(1).join(':') ?? req.conversationKey;
    const dynamicServers = this.buildMcpServers?.({ conversationKey: req.conversationKey, channel, chatId });
    const mcpServers = { ...this.deps.mcpServers, ...dynamicServers };

    // Per-turn wall-clock guard: if a turn hangs (e.g. a wedged child process),
    // abort it so it returns an error and releases its concurrency slot instead
    // of jamming the queue forever.
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), config.turnTimeoutMs);
    // Register so an agent's Stop can abort its in-flight turn (keyed by conversationKey, e.g. "agent:jimmy").
    this.inFlight.set(req.conversationKey, abortController);

    // Model selection. Priority: explicit per-chat override > escalation (use the
    // SMARTEST model, since the local model just failed at this) > fast model for
    // simple turns > primary model.
    let chosenModel: string | undefined;
    if (req.model) chosenModel = req.model;
    else if (escalatedFromLocal) chosenModel = config.smartModel || config.model;
    else if (config.fastModel && this.looksSimple(req.text)) chosenModel = config.fastModel;
    else chosenModel = config.model;
    if (chosenModel && chosenModel !== config.model) {
      logger.info({ key: req.conversationKey, model: chosenModel, escalated: escalatedFromLocal }, 'model selected for this turn');
    }

    // Agent tool restriction on the Claude tier: a focused agent gets ONLY its listed tools
    // (mirrors the local/free executor). Bare names map to this build's MCP server (zamolxis);
    // already-qualified names (e.g. a builtin or "mcp__x__y") pass through. Empty = no restriction.
    const agentAllowed =
      req.agentTools && req.agentTools.length
        ? req.agentTools.map((t) => (/__|^[A-Z]/.test(t) ? t : `mcp__zamolxis__${t}`))
        : undefined;

    const options: Options = {
      model: chosenModel,
      abortController,
      cwd: workspace,
      settingSources: ['project', 'user'],
      permissionMode: config.permissionMode,
      allowedTools: agentAllowed ?? config.allowedTools,
      disallowedTools: config.disallowedTools,
      canUseTool: this.canUseTool,
      maxTurns: config.maxTurns,
      persistSession: true,
      includePartialMessages: Boolean(req.onProgress),
      systemPrompt: { type: 'preset', preset: 'claude_code', append },
      env: engineEnv(),
      mcpServers,
      agents: this.deps.agents,
      ...(existing ? { resume: existing.sessionId } : {}),
      stderr: (d) => {
        const t = d.trim();
        if (t) logger.warn({ cc: t }, 'cc-stderr');
      },
    };

    // Cross-model continuity: Claude resumes its OWN SDK session (the turns it answered), but
    // turns handled by other tiers since its last turn aren't in that session. Inject them as
    // context so a conversation that bounced local <-> Claude stays coherent. (`recent` is
    // chronological; we take only turns newer than Claude's last and cap the block.)
    const sinceClaude = existing?.lastClaudeTs ?? 0;
    const unseen = (this.deps.sessionIndex?.recent(req.conversationKey, 20) ?? []).filter((t) => t.ts > sinceClaude);
    let priorContext = '';
    if (unseen.length) {
      const lines = unseen
        .slice(-10)
        .map((t) => `${t.role === 'assistant' ? dispName : 'User'}: ${t.text.slice(0, 1500)}`)
        .join('\n');
      priorContext = `## Recent conversation so far (some turns were answered by a faster model; here for context)\n${lines}\n\n---\n\n`;
    }
    const userLine = req.displayName ? `[from ${req.displayName}]\n${req.text}` : req.text;
    const promptText = priorContext + userLine;
    // Streaming-input mode (prompt as AsyncIterable) is REQUIRED for in-process
    // MCP tools: their callbacks ride the bidirectional control protocol. The
    // input stream must stay OPEN until the turn's result arrives — if the
    // generator returns first, the channel closes and a pending tool call kills
    // the child (exit 1, no stderr). `endInput()` is called on the result event.
    let endInput!: () => void;
    const inputDone = new Promise<void>((resolve) => {
      endInput = resolve;
    });
    async function* inputStream(): AsyncGenerator<SDKUserMessage> {
      yield {
        type: 'user',
        message: { role: 'user', content: promptText },
        parent_tool_use_id: null,
        session_id: '',
      };
      await inputDone;
    }

    let sessionId = existing?.sessionId ?? '';
    let reply = '';
    let costUsd = 0;
    let isError = false;
    let errorKind: string | undefined;
    let learnedThisTurn = false; // did the model already call `learn`? (skip the distill pass if so)
    let profileWroteThisTurn = false; // did the model already write to the profile? (skip profile-capture)

    try {
      for await (const msg of query({ prompt: inputStream(), options })) {
        switch (msg.type) {
          case 'system':
            if (msg.subtype === 'init') {
              sessionId = msg.session_id;
              // Which credential path did the engine pick? This is THE diagnostic for "Claude
              // doesn't work" (esp. on macOS): expect a subscription/oauth source. If it shows
              // 'none' or an api-key source, the subscription token isn't being read — on macOS
              // run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN in .env (the Keychain
              // that `claude login` writes isn't readable by this spawned engine).
              const src = (msg as { apiKeySource?: string }).apiKeySource;
              logger.info({ apiKeySource: src ?? 'unknown', model: chosenModel, hasOauthToken: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN) }, 'engine auth source');
            }
            break;
          case 'assistant': {
            if (msg.error) {
              isError = true;
              errorKind = msg.error;
              if (msg.error === 'rate_limit') this.deps.throttle.noteRateLimit();
            }
            const content = (msg as { message?: { content?: unknown } }).message?.content;
            if (Array.isArray(content)) {
              for (const b of content) {
                const blk = b as { type?: string; name?: string; input?: { scope?: string; action?: string } };
                if (blk?.type === 'tool_use' && typeof blk.name === 'string') {
                  if (/(^|_)learn$/.test(blk.name)) learnedThisTurn = true;
                  if (/(^|_)memory$/.test(blk.name) && blk.input?.scope === 'profile' && (blk.input.action === 'add' || blk.input.action === 'replace')) profileWroteThisTurn = true;
                }
              }
            }
            break;
          }
          case 'stream_event': {
            if (req.onProgress && msg.event.type === 'content_block_delta') {
              const delta = msg.event.delta;
              if (delta.type === 'text_delta') req.onProgress(delta.text);
            }
            break;
          }
          case 'result': {
            endInput(); // turn finished — release the input stream so the query can close
            sessionId = msg.session_id;
            costUsd = msg.total_cost_usd;
            this.deps.usage?.recordEngine(msg.modelUsage, msg.total_cost_usd);
            if (msg.subtype === 'success') {
              reply = msg.result;
            } else {
              isError = true;
              errorKind = msg.subtype;
              reply = `(${msg.subtype})${'errors' in msg && msg.errors?.length ? ': ' + msg.errors.join('; ') : ''}`;
            }
            break;
          }
        }
      }
    } catch (err) {
      endInput();
      const es = String(err);
      logger.error({ err: es, conversationKey: req.conversationKey }, 'engine run failed');
      const auth = /\b401\b|authenticat/i.test(es);
      const aborted = /abort/i.test(es) || abortController.signal.aborted;
      const reply = auth
        ? AUTH_EXPIRED_MSG
        : aborted
          ? 'That took too long and was stopped. Please try again, or simplify the request.'
          : 'Sorry — I hit an internal error handling that. Please try again.';
      return { reply, sessionId, costUsd, isError: true, errorKind: auth ? 'auth' : aborted ? 'timeout' : 'exception' };
    } finally {
      clearTimeout(timeout);
      if (this.inFlight.get(req.conversationKey) === abortController) this.inFlight.delete(req.conversationKey);
    }

    // Surface an expired/invalid subscription login as a clear, actionable
    // message instead of a cryptic error result.
    if (isError && (errorKind === 'authentication_failed' || /\b401\b|authenticat/i.test(reply))) {
      reply = AUTH_EXPIRED_MSG;
      errorKind = 'auth';
    }

    // Use ONE timestamp for both the archived turn and lastClaudeTs, so the next Claude turn's
    // "ts > lastClaudeTs" filter excludes this turn's own records (no duplicate context).
    const now = Date.now();
    if (sessionId) {
      sessions.set(req.conversationKey, { sessionId, workspace, updatedAt: now, lastClaudeTs: now });
    }
    // Archive the exchange for full-text search (search_history tool) and cross-model history.
    if (!isError) {
      this.deps.sessionIndex?.record(req.conversationKey, 'user', req.text, now);
      this.deps.sessionIndex?.record(req.conversationKey, 'assistant', reply, now);
    }
    // Deterministic teach-back: when a turn reached the smart model via escalation and
    // the model did NOT already call `learn`, distill one reusable fact so the local
    // model can handle it next time. Fire-and-forget so it doesn't delay the reply.
    if (escalated && !isError && !learnedThisTurn && reply.trim().length > 12) {
      void this.distillLearning(req, reply).catch((err) => logger.warn({ err: String(err) }, 'teach-back distill failed'));
    }
    // Profile capture: if the user revealed something durable about themselves and the
    // model didn't already record it to the profile, distill and save it to USER.md.
    if (!isError && !profileWroteThisTurn && mentionsSelf(req.text)) {
      void this.captureProfile(req).catch((err) => logger.warn({ err: String(err) }, 'profile-capture failed'));
    }
    if (!isError && needsCurrentInfo(req.text) && reply.trim().length > 8) {
      void this.captureFact(req, reply).catch((err) => logger.warn({ err: String(err) }, 'fact-capture failed'));
    }
    return { reply: reply.trim() || '(no reply)', sessionId, costUsd, isError, errorKind, via: `Claude${chosenModel ? ` (${chosenModel})` : ''}` };
  }

  /** Distill ONE absolute, self-contained fact from an answered question and store it in the
   *  knowledge index — so a smaller model can answer the same thing later without searching. */
  private async captureFact(req: RunRequest, answer: string): Promise<void> {
    if (!answer || answer.trim().length < 8) return;
    const sys =
      'From the answered question below, extract ONE absolute, self-contained FACT worth remembering so a smaller model can answer the same question later WITHOUT searching. RESOLVE any relative time ("two nights ago", "yesterday", "last night", "today") to the ABSOLUTE date using the current date, and include that date. Keep the proper nouns and numbers. Output ONLY the fact, max 200 chars. If the answer has no durable factual content (chit-chat, an error, a refusal, an opinion, or a live value like a current price), output exactly: NONE';
    const prompt = `Current date: ${new Date().toLocaleDateString()}.\nQuestion: ${req.text}\nAnswer: ${answer.slice(0, 2000)}\nAbsolute fact (or NONE):`;
    const out = await this.oneShotClaude(sys, prompt, this.deps.config.fastModel || this.deps.config.model);
    const fact = out.replace(/^[-*\s`'"]+/, '').replace(/[`'"\s]+$/, '').trim();
    if (!fact || /^none\b/i.test(fact) || fact.length > 240) return;
    // Reject still-relative phrasing (should have been resolved) so stored facts never go stale.
    if (/\b(two nights ago|last night|yesterday|today|tonight|this (week|morning|evening|season))\b/i.test(fact)) return;
    const ok = this.deps.memory.addFact(fact);
    if (ok) logger.info({ key: req.conversationKey, fact }, 'fact captured to knowledge store');
  }

  /** Extract at most one NEW durable user fact from the message and store it in USER.md. */
  private async captureProfile(req: RunRequest): Promise<void> {
    const known = this.deps.memory.getUser().replace(/^#.*$/m, '').trim();
    const sys =
      'You maintain a USER PROFILE. From the user message, extract AT MOST ONE durable, reusable fact ABOUT THE USER worth keeping long-term (their name, location, timezone, role, communication style, recurring projects, preferences, hard constraints / things to avoid). Output ONLY that fact as one short bullet phrase, max 140 chars. Do NOT restate anything already known. If there is nothing new and durable (a one-off task, a question, chit-chat, or something already known), output exactly: NONE';
    const prompt = `Already known about the user:\n${known || '(nothing yet)'}\n\nUser just said:\n${req.text}\n\nNew durable profile fact (or NONE):`;
    const out = await this.oneShotClaude(sys, prompt, this.deps.config.fastModel || this.deps.config.model);
    const fact = out.replace(/^[-*\s`'"]+/, '').replace(/[`'"\s]+$/, '').trim();
    if (!fact || /^none\b/i.test(fact) || fact.length > 180) return;
    const res = this.deps.memory.addUser(fact);
    logger.info({ key: req.conversationKey, fact, ok: res.ok }, 'profile-capture: recorded a user fact');
  }

  /** Minimal one-shot Claude completion (no MCP tools, single turn) — returns the reply text. */
  private async oneShotClaude(append: string, prompt: string, model?: string): Promise<string> {
    const options: Options = {
      model,
      settingSources: [],
      permissionMode: 'default',
      maxTurns: 1,
      systemPrompt: { type: 'preset', preset: 'claude_code', append },
      env: engineEnv(),
    };
    let out = '';
    try {
      for await (const msg of query({ prompt, options })) {
        if (msg.type === 'result' && msg.subtype === 'success') out = msg.result;
      }
    } catch (err) {
      logger.warn({ err: String(err) }, 'oneShotClaude failed');
    }
    return out.trim();
  }

  /** After an escalation, extract ONE concise reusable fact and store it in LEARNINGS.md. */
  private async distillLearning(req: RunRequest, answer: string): Promise<void> {
    const sys =
      'You turn a just-solved request into ONE durable, GENERALIZABLE lesson that helps a smaller on-device model handle SIMILAR requests next time. Capture a reusable METHOD or fact: which tool/approach to use (e.g. "for current sports scores, news, weather, or prices, use web_search with a specific query including names and the year — never claim there is no result without searching first"), a device-id/name mapping, an API endpoint, a config value, or a fix. ' +
      'Do NOT store TRANSIENT or time-bound specifics — no scores, standings, prices, weather, headlines, specific dates, or one-off results; they expire and are useless later. If the only thing learned is such a transient fact (or it is chit-chat or a secret), output exactly: NONE. ' +
      'Output ONLY the lesson, max 160 chars, optionally prefixed with a [topic] tag in square brackets.';
    const prompt = `Request:\n${req.text}\n\nWorking answer:\n${answer.slice(0, 4000)}\n\nReusable fact (or NONE):`;
    const out = await this.oneShotClaude(sys, prompt, this.deps.config.fastModel || this.deps.config.model);
    const fact = out.replace(/^[`'"\s]+|[`'"\s]+$/g, '').trim();
    if (!fact || /^none\b/i.test(fact) || fact.length > 220) return;
    const res = this.deps.memory.addLearning(fact);
    logger.info({ key: req.conversationKey, fact, ok: res.ok }, 'teach-back: distilled a learning');
  }
}
