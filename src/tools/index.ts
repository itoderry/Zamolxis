import path from 'node:path';
import { z } from 'zod';
import { tool, createSdkMcpServer, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { packSetup } from '../core/pack.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { SkillsManager } from '../skills/manager.js';
import type { SandboxManager, BackendName } from '../sandbox/backends.js';
import type { MemoryManager } from '../core/memory.js';
import type { SessionIndex } from '../core/sessionIndex.js';
import type { TabsManager } from '../core/tabs.js';
import type { UsageTracker } from '../core/usage.js';
import { runWebSearch, localSearchAvailable, runHaService, haConfigured } from '../core/localTools.js';
import { setTempName } from '../core/displayName.js';
import { buildPaidTools } from './paid.js';
import { readInbox, resolveAccount, listAccountNames, addAccount } from './email.js';
import type { AgentStore } from '../core/agents.js';

/** Live conversation context, captured per agent turn so tools deliver to the right place. */
export interface ToolContext {
  conversationKey: string;
  channel: string;
  chatId: string;
}

export interface ToolDeps {
  scheduler: Scheduler;
  skills: SkillsManager;
  sandbox: SandboxManager;
  memory: MemoryManager;
  sessionIndex: SessionIndex;
  tabs: TabsManager;
  /** Token accounting for the paid (metered) models. */
  usage: UsageTracker;
  /** Optional on-device model for offloading easy subtasks. */
  localModel?: { url: string; model: string };
  /** Root for tool artifacts (e.g. generated images). */
  dataDir: string;
  /** Shared skills directory (for packing the setup). */
  skillsDir: string;
  /** User-defined agents store (create/list). */
  agentStore?: AgentStore;
  /** Run a named user-defined agent (late-bound to the engine). */
  runAgent?: (name: string, task?: string) => Promise<string>;
  /** Deliver a message from an agent to another agent or the user (late-bound to the engine). */
  sendAgentMessage?: (from: string, to: string, text: string) => Promise<string>;
  /** Compile an agent's NL job into an executable plan via the smart model (late-bound to the engine). */
  compileAgent?: (name: string) => Promise<{
    ok: boolean;
    executor?: string;
    skills?: string[];
    codeTools?: { name: string }[];
    risk?: { level: string; note: string; recommendedModel?: string };
    schedule?: { cron: string; humanReadable?: string };
  }>;
}

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

/**
 * Build the in-process "zamolxis" MCP server for one agent turn. Tools close over
 * `ctx` so e.g. a scheduled job is delivered back to this very conversation.
 */
export function buildToolServers(ctx: ToolContext, deps: ToolDeps): Record<string, McpServerConfig> {
  const scheduleTask = tool(
    'schedule_task',
    'Schedule work to run later and deliver the result back to this conversation. Provide either a cron expression (recurring) or an ISO timestamp (one-shot).',
    {
      name: z.string().describe('Short human-readable name for the job'),
      prompt: z.string().describe('The instruction to run when the job fires'),
      cron: z.string().optional().describe('Cron expression, e.g. "0 9 * * 1-5" for weekdays at 9am'),
      at: z.string().optional().describe('ISO-8601 timestamp for a one-time run'),
    },
    async (args) => {
      if (!args.cron && !args.at) return text('Error: provide either `cron` or `at`.');
      const job = deps.scheduler.add({
        name: args.name,
        prompt: args.prompt,
        cron: args.cron,
        at: args.at,
        channel: ctx.channel,
        chatId: ctx.chatId,
        conversationKey: ctx.conversationKey,
      });
      return text(`Scheduled "${job.name}" (id ${job.id}) ${args.cron ? `on cron \`${args.cron}\`` : `at ${args.at}`}.`);
    },
  );

  const listScheduled = tool('list_scheduled', 'List scheduled jobs for this conversation.', {}, async () => {
    const jobs = deps.scheduler.list(ctx.conversationKey);
    if (jobs.length === 0) return text('No scheduled jobs.');
    return text(
      jobs
        .map((j) => `- ${j.id} "${j.name}" ${j.cron ? `cron ${j.cron}` : `at ${j.at}`}${j.enabled ? '' : ' (done)'}`)
        .join('\n'),
    );
  });

  const cancelScheduled = tool(
    'cancel_scheduled',
    'Cancel a scheduled job by id.',
    { id: z.string() },
    async (args) => text(deps.scheduler.cancel(args.id) ? `Cancelled ${args.id}.` : `No job ${args.id}.`),
  );

  const createSkill = tool(
    'create_skill',
    'Write a reusable skill for yourself. Becomes available in all conversations on the next turn. The body is markdown instructions.',
    {
      name: z.string().describe('Skill name, e.g. "summarize-pdf"'),
      description: z.string().describe('One line: when this skill should be used'),
      body: z.string().describe('Markdown instructions for performing the skill'),
    },
    async (args) => {
      const slug = deps.skills.write(args.name, args.description, args.body);
      return text(`Created skill "${slug}". It will be discoverable on the next turn.`);
    },
  );

  const listSkills = tool('list_skills', 'List skills you have authored.', {}, async () => {
    const skills = deps.skills.list();
    return text(skills.length ? skills.map((s) => `- ${s.name}: ${s.description}`).join('\n') : 'No skills yet.');
  });

  const sandboxExec = tool(
    'sandbox_exec',
    `Run a shell command in a sandbox backend. Default backend: "${deps.sandbox.defaultBackend}". Configured: ${deps.sandbox.listConfigured().join(', ')}. Use this instead of plain bash when you want isolation (docker), a remote host (ssh), or a cloud sandbox (modal).`,
    {
      command: z.string().describe('Shell command to run'),
      backend: z.enum(['local', 'docker', 'ssh', 'modal']).optional().describe('Override the default backend'),
      timeout_seconds: z.number().int().positive().max(600).optional(),
    },
    async (args) => {
      const backend = (args.backend ?? deps.sandbox.defaultBackend) as BackendName;
      const r = await deps.sandbox.exec(args.command, backend, (args.timeout_seconds ?? 60) * 1000);
      const head = `[backend ${r.backend} · exit ${r.exitCode}${r.timedOut ? ' · TIMED OUT' : ''}]`;
      const body = [r.stdout && `stdout:\n${r.stdout}`, r.stderr && `stderr:\n${r.stderr}`].filter(Boolean).join('\n');
      return text(`${head}\n${body || '(no output)'}`);
    },
  );

  const memoryTool = tool(
    'memory',
    'Your durable, curated long-term store (shared across every channel and conversation). Two scopes: scope="profile" is the USER PROFILE (USER.md) — durable facts ABOUT THE USER (name, timezone, communication style, recurring projects, things to avoid); scope="memory" (default) is your own WORKING MEMORY (MEMORY.md) for ongoing tasks and context. action="add" to record a concise entry; "replace" to update one (find = a substring of the existing entry, text = the new entry); "remove" to delete (find = substring); "list" to view entries and capacity. Both scopes are capped — keep them concise and consolidate when near full. (SOUL.md / persona is owned by the user; you do not edit it.)',
    {
      action: z.enum(['add', 'replace', 'remove', 'list']),
      scope: z.enum(['memory', 'profile']).optional().describe('"profile" = facts about the user (USER.md); "memory" = your working notes (default).'),
      text: z.string().optional().describe('The entry to add, or the replacement text'),
      find: z.string().optional().describe('Substring identifying the entry to replace/remove'),
    },
    async (args) => {
      const profile = args.scope === 'profile';
      const label = profile ? 'Profile' : 'Memory';
      switch (args.action) {
        case 'list': {
          const u = profile ? deps.memory.userUsage() : deps.memory.usage();
          const items = profile ? deps.memory.userList() : deps.memory.list();
          return text(`${label} ${u.pct}% full (${u.chars}/${u.max} chars):\n${items.length ? items.map((e) => `- ${e}`).join('\n') : '(empty)'}`);
        }
        case 'add':
          if (!args.text) return text('Provide `text` to record.');
          return text((profile ? deps.memory.addUser(args.text) : deps.memory.add(args.text)).message);
        case 'replace':
          if (!(args.find && args.text)) return text('Provide both `find` and `text`.');
          return text((profile ? deps.memory.replaceUser(args.find, args.text) : deps.memory.replace(args.find, args.text)).message);
        case 'remove':
          if (!args.find) return text('Provide `find`.');
          return text((profile ? deps.memory.removeUser(args.find) : deps.memory.remove(args.find)).message);
        default:
          return text('Unknown action.');
      }
    },
  );

  const learn = tool(
    'learn',
    'Teach the system a concise, reusable fact you discovered while solving something (especially after an escalation the on-device model could not handle) so the LOCAL model and future turns can apply it directly next time. Examples: a device-id mapping ("bedroom lights = light.master, light.kids"), an API endpoint, a config value, a fix. Optionally tag a topic/skill. Save only genuinely reusable findings, not one-offs.',
    {
      fact: z.string().describe('The concise reusable fact/resolution to remember'),
      topic: z.string().optional().describe('Optional tag, e.g. a skill or area like "home-assistant"'),
    },
    async (args) => {
      const fact = (args.fact ?? '').trim();
      if (!fact || /^none\.?$/i.test(fact)) return text('Nothing durable to learn — skipped.');
      // Storage-layer guard: reject TRANSIENT/time-bound facts (scores, prices, weather,
      // dated one-offs) — they expire and pollute the store. Learn durable methods/mappings.
      // Match transient VALUES (a score "6-1", a date, a price, "today/last night", "game 5"),
      // NOT category words — so a durable METHOD like "for scores/weather use web_search" is allowed.
      const transient =
        /(\b\d+\s*[-–]\s*\d+\b|\$\s?\d|\btoday\b|\byesterday\b|\blast night\b|\btonight\b|\bthis (morning|week|weekend|season)\b|\bgame \d\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2}\b|\b\d{4}-\d\d-\d\d\b)/i;
      if (transient.test(fact)) {
        return text('That looks transient/time-bound (it will be stale later) — NOT saved. Only learn durable methods, device/id mappings, endpoints, config values, or fixes.');
      }
      const entry = args.topic ? `[${args.topic.trim()}] ${fact}` : fact;
      return text(deps.memory.addLearning(entry).message);
    },
  );

  const packSetupTool = tool(
    'pack_setup',
    'Bundle the CURRENT Zamolxis setup into a portable pack file so a NEW install can be seeded from it. It ALWAYS includes every skill (including ones created over time). Before calling, ASK the user whether the new install should also include: their persona (SOUL.md), their profile (USER.md), and the learned facts/teachings (LEARNINGS.md) — then set the flags accordingly. Returns the saved pack file path.',
    {
      include_soul: z.boolean().optional().describe('Include the persona SOUL.md'),
      include_user: z.boolean().optional().describe('Include the user profile USER.md'),
      include_teachings: z.boolean().optional().describe('Include the learned facts LEARNINGS.md'),
    },
    async (args) => {
      const parts: { soul?: string; user?: string; learnings?: string } = {};
      if (args.include_soul) parts.soul = deps.memory.getSoul();
      if (args.include_user) parts.user = deps.memory.getUser();
      if (args.include_teachings) parts.learnings = deps.memory.getLearnings();
      const stamp = new Date().toISOString();
      const r = packSetup(deps.skillsDir, path.join(deps.dataDir, 'exports'), parts, stamp);
      return text(`Packed ${r.included.join(' + ')} → ${r.path}\nApply it on a new machine with:  zamolxis unpack "${r.path}"`);
    },
  );

  const setDisplayName = tool(
    'set_display_name',
    'Temporarily change the name you go by AND that the whole interface shows (header, labels, title). Use this when the user asks you to go by a different name for a while (e.g. "your name is Charlie for two minutes"). It auto-reverts to your configured name after `minutes` (default 2). Do not just claim a new name in text — call this so the UI actually reflects it.',
    {
      name: z.string().describe('The temporary name to go by'),
      minutes: z.number().optional().describe('How long before it reverts (default 2)'),
    },
    async (args) => {
      const r = setTempName(args.name, args.minutes ?? 2);
      return text(`Okay — I'll go by "${r.name}" until ${new Date(r.until).toLocaleTimeString()}, then automatically revert.`);
    },
  );

  const searchHistory = tool(
    'search_history',
    'Full-text search across ALL past conversations (every channel and thread), beyond what is in your active memory. Use it to recall something discussed before.',
    {
      query: z.string().describe('Search terms'),
      limit: z.number().int().positive().max(25).optional(),
    },
    async (args) => {
      if (!deps.sessionIndex.available()) return text('Session search is unavailable on this runtime.');
      const hits = deps.sessionIndex.search(args.query, args.limit ?? 10);
      if (!hits.length) return text('No matches found in past conversations.');
      return text(
        hits
          .map((h) => `[${new Date(h.ts).toISOString().slice(0, 16).replace('T', ' ')} · ${h.conversation} · ${h.role}] ${h.text}`)
          .join('\n'),
      );
    },
  );

  const createTab = tool(
    'create_tab',
    'Create a dashboard tab in the web interface and push content into it (markdown). Optionally give it refresh_prompt + refresh_seconds and the tab will periodically regenerate its content by running that prompt (min 30s). Use tabs for at-a-glance views: status boards, daily briefs, watchlists, notes.',
    {
      title: z.string().describe('Tab title shown in the tab bar'),
      content: z.string().optional().describe('Initial markdown content'),
      refresh_prompt: z.string().optional().describe('Prompt to re-run on a timer; its reply becomes the tab content'),
      refresh_seconds: z.number().int().positive().optional().describe('Refresh interval in seconds (min 30)'),
    },
    async (args) => {
      const t = deps.tabs.create({ title: args.title, content: args.content, refreshPrompt: args.refresh_prompt, refreshSeconds: args.refresh_seconds });
      return text(`Created tab "${t.title}" (id ${t.id})${t.refreshSeconds ? `, refreshing every ${t.refreshSeconds}s` : ''}.`);
    },
  );

  const updateTab = tool(
    'update_tab',
    'Replace the content of an existing tab (push fresh data into it). Identify it by id or title.',
    { tab: z.string(), content: z.string() },
    async (args) => text(deps.tabs.update(args.tab, { content: args.content }) ? `Updated tab "${args.tab}".` : `No tab "${args.tab}".`),
  );

  const deleteTab = tool(
    'delete_tab',
    'Delete a dashboard tab by id or title.',
    { tab: z.string() },
    async (args) => text(deps.tabs.remove(args.tab) ? `Deleted tab "${args.tab}".` : `No tab "${args.tab}".`),
  );

  const listTabs = tool('list_tabs', 'List the dashboard tabs you have created.', {}, async () => {
    const tabs = deps.tabs.list();
    return text(tabs.length ? tabs.map((t) => `- ${t.id} "${t.title}"${t.refreshSeconds ? ` (every ${t.refreshSeconds}s)` : ''}`).join('\n') : 'No tabs.');
  });

  // Web search via the configured provider (Tavily/Brave) — gives Claude a reliable
  // search path that doesn't depend on Claude Code's built-in web tool being enabled.
  const searchTools = [];
  if (localSearchAvailable()) {
    searchTools.push(
      tool(
        'web_search',
        'Search the web (via the configured Tavily/Brave provider) and return the top results (title, url, snippet). Use for current/live information.',
        { query: z.string().describe('Search query') },
        async (a) => text(await runWebSearch(a.query)),
      ),
    );
  }

  // Home Assistant device control (POST a service). Read is via http_get/the skill;
  // this is the write path. Lock/alarm-disarm are blocked inside runHaService.
  if (haConfigured()) {
    searchTools.push(
      tool(
        'ha_service',
        'Control a Home Assistant device: call a service. e.g. domain="light", service="turn_on", entity_id="light.kitchen". Common: light/switch/fan turn_on|turn_off|toggle, scene turn_on. Confirm with the user before anything security- or safety-related (locks, garage, alarm).',
        { domain: z.string(), service: z.string(), entity_id: z.string() },
        async (a) => text(await runHaService(a.domain, a.service, a.entity_id)),
      ),
    );
  }

  // Optional on-device model: offload-only, conserves subscription quota.
  const localTools = [];
  if (deps.localModel) {
    const lm = deps.localModel;
    localTools.push(
      tool(
        'ask_local_model',
        `Offload a SIMPLE subtask (summarize, classify, extract, reformat, draft boilerplate) to the on-device local model "${lm.model}". It runs locally and free, conserving Claude subscription quota — but it is weaker than you, so use it only for easy work and sanity-check its output.`,
        { prompt: z.string(), system: z.string().optional() },
        async (a) => {
          try {
            const res = await fetch(`${lm.url}/chat/completions`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                model: lm.model,
                messages: [
                  { role: 'system', content: a.system || 'You are a concise, accurate helper.' },
                  { role: 'user', content: a.prompt },
                ],
                stream: false,
              }),
            });
            if (!res.ok) return text(`Local model error: ${res.status} ${await res.text()}`);
            const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
            return text(data.choices?.[0]?.message?.content ?? '(no content)');
          } catch (err) {
            return text(`Local model unreachable at ${lm.url} (is it running?): ${String(err)}`);
          }
        },
      ),
    );
  }

  const createAgent = tool(
    'create_agent',
    'Create or update a named agent: a focused job that runs on a chosen model/tier with a chosen set of tools. Use when the user says e.g. "make an agent that uses web_search to do X".',
    {
      name: z.string().describe('Short name/slug for the agent'),
      job: z.string().describe('The role and instructions: what this agent is and does'),
      tools: z.array(z.string()).optional().describe('Tool names the agent may use, e.g. ["web_search","read_url","http_get"]; omit for the default toolset'),
      model: z.string().optional().describe('Where it runs: auto | local | freecloud | a provider id (groq, google, cerebras, mistral, openrouter, deepseek, openai) | claude. Default auto.'),
      canElevate: z.boolean().optional().describe('May it escalate to the smartest model when stuck (default true)'),
    },
    async (args) => {
      if (!deps.agentStore) return text('Agents are not available in this build.');
      try {
        const n = deps.agentStore.upsert({ name: args.name, job: args.job, tools: args.tools, model: args.model, canElevate: args.canElevate });
        let extra = '';
        if (deps.compileAgent) {
          try {
            const p = await deps.compileAgent(n);
            if (p.ok) {
              extra =
                `\nPlanner compiled it: executor=${p.executor}, risk=${p.risk?.level ?? 'n/a'}` +
                (p.schedule && p.schedule.cron ? `, schedule=${p.schedule.humanReadable || p.schedule.cron}` : '') +
                (p.skills && p.skills.length ? `, skills=[${p.skills.join(', ')}]` : '') +
                (p.codeTools && p.codeTools.length ? `, generated tools=[${p.codeTools.map((t) => t.name).join(', ')}]` : '') +
                '.';
              if (p.risk && p.risk.level !== 'low') extra += `\n⚠ ${p.risk.level} risk: ${p.risk.note} (recommended model: ${p.risk.recommendedModel}).`;
            }
          } catch {
            /* compile is best-effort; the agent still runs on its raw job */
          }
        }
        return text(`Agent "${n}" saved (model: ${args.model || 'auto'}).${extra}\nRun it with run_agent, or from the Agents list in the UI.`);
      } catch (e) {
        return text('Could not create agent: ' + String(e));
      }
    },
  );
  const listAgents = tool('list_agents', 'List the user-defined agents.', {}, async () => {
    if (!deps.agentStore) return text('Agents are not available in this build.');
    const a = deps.agentStore.list();
    return text(a.length ? a.map((x) => `- ${x.name} [${x.model}]: ${x.job.slice(0, 90)}`).join('\n') : 'No agents defined yet.');
  });
  const runAgentTool = tool(
    'run_agent',
    'Run a named agent on a task right now and return its result.',
    { name: z.string().describe('The agent name'), task: z.string().optional().describe('What to do (optional; uses the agent job if omitted)') },
    async (args) => {
      if (!deps.runAgent) return text('Cannot run agents from here.');
      try {
        return text(await deps.runAgent(args.name, args.task));
      } catch (e) {
        return text('Agent run failed: ' + String(e));
      }
    },
  );
  const scheduleAgent = tool(
    'schedule_agent',
    'Run an existing agent on a recurring schedule (cron) or once (at an ISO time). Its result is delivered back to this conversation.',
    {
      name: z.string().describe('The agent name'),
      cron: z.string().optional().describe('Cron expression, e.g. "0 8 * * 1-5" for weekdays 8am'),
      at: z.string().optional().describe('ISO-8601 timestamp for a one-time run'),
      task: z.string().optional().describe('Task to give the agent each run (optional; uses its job)'),
    },
    async (args) => {
      if (!deps.agentStore?.get(args.name)) return text(`No agent named "${args.name}".`);
      if (!args.cron && !args.at) return text('Provide either `cron` (recurring) or `at` (one-shot).');
      const job = deps.scheduler.add({ name: `agent:${args.name}`, agent: args.name, prompt: args.task || '', cron: args.cron, at: args.at, channel: ctx.channel, chatId: ctx.chatId, conversationKey: ctx.conversationKey });
      return text(`Scheduled agent "${args.name}" (${args.cron || args.at}). Cancel with cancel_scheduled and id ${job.id}.`);
    },
  );
  const sendMessage = tool(
    'send_message',
    'Send a message to another agent (by name) or to the user. Agents use this to report results/progress, or to hand work to another agent.',
    { to: z.string().describe('Recipient: an agent name, or "user"'), text: z.string().describe('The message') },
    async (args) => {
      if (!deps.sendAgentMessage) return text('Messaging is not available in this build.');
      const from = ctx.conversationKey.startsWith('agent:') ? ctx.conversationKey.slice('agent:'.length) : 'assistant';
      return text(await deps.sendAgentMessage(from, args.to, args.text));
    },
  );

  const readEmail = tool(
    'read_email',
    'Read an email inbox. READ-ONLY: never sends, replies, deletes, or marks messages as read. Returns recent/unread messages with sender, subject, and date. Supports multiple accounts — pass `account` (a name from list_email_accounts) to pick one. Use for "summarize my unread emails", "any important mail in my gmail today?". See the gmail/outlook/yahoo connection skills to set accounts up.',
    {
      account: z.string().optional().describe('Account name (from list_email_accounts). Omit if only one is configured.'),
      unreadOnly: z.boolean().optional().describe('Only unread messages (default true); false = recent messages'),
      limit: z.number().optional().describe('Max messages to return (default 15, max 50)'),
      search: z.string().optional().describe('Only messages whose sender or subject contains this text'),
    },
    async (args) => {
      const conn = resolveAccount(deps.dataDir, args.account);
      if (!conn) {
        const names = listAccountNames(deps.dataDir);
        if (names.length > 1 && !args.account) return text(`Which account? Configured: ${names.join(', ')}. Re-run with account set to one of these.`);
        if (args.account) return text(`No email account named "${args.account}". Configured: ${names.join(', ') || '(none)'}.`);
        return text('No email account is set up. Add one to <dataDir>/emails.json (see the "Connect Gmail/Outlook/Yahoo" skills for the exact server settings + app-password steps), then ask again. This is read-only and never sends.');
      }
      try {
        const items = await readInbox(conn, { unreadOnly: args.unreadOnly, limit: args.limit, search: args.search });
        if (!items.length) return text(args.unreadOnly === false ? 'No messages found in the inbox.' : 'No unread messages.');
        return text(items.map((m, i) => `${i + 1}. From: ${m.from}\n   Subject: ${m.subject}\n   Date: ${m.date}`).join('\n\n'));
      } catch (e) {
        return text('Could not read the inbox: ' + String(e));
      }
    },
  );
  const addEmailAccount = tool(
    'add_email_account',
    'Save an email account so read_email can use it. The user can give just their email + app password (and optionally a provider); IMAP server settings are auto-filled for gmail/outlook/hotmail/yahoo/icloud/fastmail/zoho (or by email domain). Pass imapHost for anything else. Use when the user says e.g. "connect my gmail me@gmail.com, app password XXXX" or supplies email+password while creating an agent. Stored locally; the password is never echoed.',
    {
      user: z.string().describe('The full email address'),
      password: z.string().describe('App password (or mailbox password). Stored locally only.'),
      name: z.string().optional().describe('Short account name to reference later (default: the part before @)'),
      provider: z.string().optional().describe('gmail | outlook | hotmail | live | yahoo | icloud | fastmail | zoho (optional; auto-detected from the address)'),
      imapHost: z.string().optional().describe('IMAP host for providers without a preset'),
      imapPort: z.number().optional().describe('IMAP port (default 993)'),
    },
    async (args) => {
      const r = addAccount(deps.dataDir, args);
      if (!r.ok) return text('Could not add the account: ' + (r.error || 'unknown error'));
      return text(`Saved email account "${r.name}" (IMAP ${r.imapHost}). Use it with read_email account="${r.name}". It's read-only — Zamolxis never sends from it.`);
    },
  );
  const listEmailAccounts = tool(
    'list_email_accounts',
    'List the configured email account names that read_email can use (no passwords). Use to discover which mailboxes are available.',
    {},
    async () => {
      const names = listAccountNames(deps.dataDir);
      return text(names.length ? `Email accounts: ${names.join(', ')}` : 'No email accounts configured yet. See the Gmail/Outlook/Yahoo connection skills.');
    },
  );

  return {
    zamolxis: createSdkMcpServer({
      name: 'zamolxis',
      version: '0.1.0',
      tools: [
        readEmail,
        addEmailAccount,
        listEmailAccounts,
        createAgent,
        listAgents,
        runAgentTool,
        scheduleAgent,
        sendMessage,
        scheduleTask,
        listScheduled,
        cancelScheduled,
        createSkill,
        listSkills,
        sandboxExec,
        memoryTool,
        learn,
        packSetupTool,
        setDisplayName,
        searchHistory,
        createTab,
        updateTab,
        deleteTab,
        listTabs,
        ...searchTools,
        ...localTools,
        ...buildPaidTools(deps.dataDir, deps.usage),
      ],
    }),
  };
}
