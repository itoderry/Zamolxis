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
}

function buildPersona(name: string): string {
  return `You are ${name}, a self-hosted personal agent that lives on the user's own machine and talks to them across messaging channels. You are persistent: you remember context across conversations via files in your workspace, you can write new skills for yourself, schedule recurring work, delegate to subagents, and use the shell and the web. Be concise and direct in chat. When a task spans multiple steps, just do it — only ask the user when a choice is genuinely theirs to make. Your name is ${name}; refer to yourself as ${name}. As you learn durable facts about the user (their name, timezone, preferences, recurring projects, environment), record them in your user profile with the \`memory\` tool using scope="profile"; use the default scope for your own working notes. Keep entries concise and consolidate or remove stale ones when near full. Use \`search_history\` to recall things discussed in past conversations.`;
}

const AUTH_EXPIRED_MSG =
  'My Claude subscription login has expired or is invalid. On the host machine, run `claude login`, then restart Zamolxis.';

function sanitizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

/** Did the local model ask to hand off? Tolerant of how small models phrase it:
 *  "ESCALATE", "<ESCALATE>", "[ESCALATE].", or an empty reply all count. */
function wantsEscalate(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t) return true;
  if (/<ESCALATE>/i.test(t)) return true;
  if (/^[<[(]?\s*escalate\s*[>\])]?\s*[.!]?$/i.test(t)) return true; // reply is essentially just the word
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

  /** A short user message that rejects the previous answer and asks to escalate. */
  private isEscalationTrigger(text: string): boolean {
    const t = (text ?? '').trim().toLowerCase();
    if (!t || t.length > 40) return false;
    return /^(escalate( this| it)?|wrong|that'?s wrong|that is wrong|incorrect|that'?s incorrect|not right|that'?s not right|no,? ?(that'?s )?(wrong|incorrect)|nope,? ?wrong|redo|try again|do it again|use claude|ask claude|bigger model)[.!]*$/i.test(t);
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
  private buildAssistant(allowEscalate: boolean, query = ''): { system: string; tools: LocalToolset } {
    const { config } = this.deps;
    const tools = buildLocalTools();
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
    const nowLine = `Right now it is ${new Date().toLocaleString()}. Use this to judge whether a dated event is in the PAST or upcoming — never describe a past event as if it is still to come (e.g. do not offer tickets/odds for a game that already happened).`;
    const searchSynth = hasSearch
      ? "When you web_search: pick the most AUTHORITATIVE on-topic result (official, league, ESPN, or encyclopedia pages over ticket/betting/preview pages) and ANSWER THE USER'S ACTUAL QUESTION directly in 1-2 sentences with the specific fact. Do NOT paste ticket prices, betting odds, moneylines, streaming/\"watch\" options, or other details the user didn't ask for. If the top result is a betting/preview page, look for the answer in another result instead of dumping it."
      : undefined;
    const learned = query ? this.deps.memory.relevantLearningsBlock(query) : this.deps.memory.learningsBlock();
    const system = [toolsLine, searchSynth, safety, escalateRule, persona, nowLine, profileHint, learned, skillsHint, config.systemPromptAppend]
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
    const { system, tools } = this.buildAssistant(allowEscalate, req.text);
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
    const { system, tools } = this.buildAssistant(allowEscalate, req.text);
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
    // Drop 'local' if the user turned local routing off (keeps that toggle meaningful).
    const cloud = chain.filter((t) => t !== 'claude').filter((t) => !(t === 'local' && config.localRouting === 'off'));
    if (req.route === 'claude') return { tiers: [], claude: true }; // explicit → Claude
    if (req.escalated) return claudeIn ? { tiers: [], claude: true } : { tiers: cloud.slice(-1), claude: false };
    if (req.route === 'local') return { tiers: cloud.includes('local') ? ['local'] : cloud.slice(0, 1), claude: false };
    if (req.route === 'freecloud') return { tiers: ['freecloud'], claude: claudeIn }; // explicit → rotate free providers
    if (req.route && req.route !== 'auto' && providerById(req.route)) return { tiers: [req.route], claude: claudeIn }; // explicit provider id
    if (this.hardClaudeOnly(req.text) && claudeIn) return { tiers: [], claude: true }; // needs Claude-only tools
    // Live/current-fact questions: the tiny local model mis-reasons even WHEN it searches
    // (grabs the wrong game, can't map "two nights ago", defaults the venue) — so skip
    // 'local' and use a capable tier: free cloud (e.g. Groq 70B) first, then Claude. With a
    // free-cloud key this is free and accurate; it only falls to Claude if nothing else exists.
    if (needsCurrentInfo(req.text)) {
      const stronger = cloud.filter((t) => t !== 'local');
      if (stronger.length || claudeIn) return { tiers: stronger, claude: claudeIn };
    }
    return { tiers: cloud, claude: claudeIn };
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
    const append = [laws, buildPersona(dispName), this.deps.memory.systemPromptBlock(), memoryAware, skillsHint, escalationHint, searchHint, localHint, config.systemPromptAppend, nameLock]
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

    const options: Options = {
      model: chosenModel,
      abortController,
      cwd: workspace,
      settingSources: ['project', 'user'],
      permissionMode: config.permissionMode,
      allowedTools: config.allowedTools,
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
            if (msg.subtype === 'init') sessionId = msg.session_id;
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
