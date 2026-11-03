import { fileURLToPath } from 'node:url';
import { loadConfig, applyPersistedSettings, type ZamolxisConfig } from './config.js';
import { logger } from './logger.js';
import { setToolOutputCap } from './core/toolOutput.js';
import { checkAuth, oauthExpiry } from './core/auth.js';
import { SessionStore } from './core/session.js';
import { AgentStore } from './core/agents.js';
import { Throttle } from './core/throttle.js';
import { Engine } from './core/engine.js';
import { ChannelManager } from './channels/manager.js';
import { CliChannel } from './channels/cli.js';
import { TelegramChannel } from './channels/telegram.js';
import { DiscordChannel } from './channels/discord.js';
import { SlackChannel } from './channels/slack.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import { SignalChannel } from './channels/signal.js';
import { EmailChannel } from './channels/email.js';
import { WebChannel } from './channels/web.js';
import type { Channel } from './channels/types.js';
import { Scheduler } from './scheduler/scheduler.js';
import { SkillsManager } from './skills/manager.js';
import { SandboxManager } from './sandbox/backends.js';
import { SettingsManager } from './core/settings.js';
import { MemoryManager } from './core/memory.js';
import { SessionIndex } from './core/sessionIndex.js';
import { TabsManager } from './core/tabs.js';
import { UsageTracker } from './core/usage.js';
import { RunHistory } from './core/runHistory.js';
import { TriggerStore, TriggerWatcher } from './core/triggers.js';
import { pushNotif } from './core/notifications.js';
import { loadExternalMcpServers } from './core/externalMcp.js';
import { initProviders } from './core/providers.js';
import { initClaudeModels } from './core/claudeModels.js';
import { initPlans } from './core/plans.js';
import { initLocalApps } from './core/localApps.js';
import { initWatchers } from './core/watchers.js';
import { initAppScan } from './core/appscan.js';
import { initUrlWatch } from './core/urlwatch.js';
import { initJiraWatch } from './core/jirawatch.js';
import { PREMADE_AGENTS } from './core/premadeAgents.js';
import { AgentPages } from './core/agentPages.js';
import { BanStore, isSmartestModel } from './core/bans.js';
import { PermissionStore } from './core/permissions.js';
import { configuredProviders } from './core/providers.js';
import { loadCodeModel } from './core/code/localCodeModel.js';
import { buildToolServers } from './tools/index.js';
import { Orchestrator } from './core/code/orchestrator.js';
import { stopWhisperServers } from './core/voice/whisperServer.js';
import { stopKokoroSidecars } from './core/voice/kokoroSidecar.js';

/** Print a readiness report (`--doctor`/`--check`) and exit. Used by the installer. */
function doctor(config: ZamolxisConfig): never {
  const tag = (b: boolean) => (b ? 'OK  ' : 'MISS');
  const major = Number(process.versions.node.split('.')[0]);
  const auth = checkAuth();
  const enabled = Object.entries(config.channels)
    .filter(([, v]) => v)
    .map(([k]) => k);
  const sb = new SandboxManager(config.sandbox);
  const paid = [
    process.env.OPENAI_API_KEY ? 'generate_image + openai router' : null,
    process.env.OPENROUTER_API_KEY ? 'openrouter router' : null,
  ].filter(Boolean);
  const distOk = true; // we're running from dist/ or tsx, so the build resolved

  console.log('\nZamolxis doctor');
  console.log('===============');
  console.log(`[${tag(major >= 20)}] Node ${process.version} (need >= 20)`);
  console.log(`[${tag(auth.credentialsFound)}] Claude subscription credentials (${auth.note})`);
  if (!auth.credentialsFound) console.log("        -> run 'claude login' with a Pro/Max account");
  const exp = oauthExpiry();
  if (exp) {
    console.log(`[${tag(!exp.expired)}] OAuth token ${exp.expired ? 'EXPIRED' : 'valid'} (expires ${exp.expiresAt.toLocaleString()})`);
    if (exp.expired) console.log("        -> run 'claude login' to refresh, then restart");
  }
  console.log(`[${tag(distOk)}] Build present`);
  console.log(`[OK  ] Data dir: ${config.dataDir}`);
  console.log(`[OK  ] Model: ${config.model ?? '(cli default)'} | fast: ${config.fastModel ?? '-'}`);
  console.log(`[${tag(enabled.length > 0)}] Channels enabled: ${enabled.join(', ') || '(none — set ZAMOLXIS_CHANNEL_* in .env)'}`);
  console.log(`[OK  ] Sandbox backends: ${sb.listConfigured().join(', ')} (default: ${sb.defaultBackend})`);
  console.log(`[--  ] Local model (offload): ${config.localModel ? `${config.localModel.model} @ ${config.localModel.url}` : 'none (run installer with -Local to set one up)'}`);
  console.log(`[--  ] Paid plugins: ${paid.length ? paid.join(', ') : 'none (optional; needs OPENAI_API_KEY / OPENROUTER_API_KEY)'}`);
  const usageTotals = new UsageTracker(config.dataDir).snapshot().total;
  const models = Object.entries(usageTotals.models);
  console.log(
    `[--  ] Paid model usage (all-time): ${usageTotals.totals.total.toLocaleString()} tokens over ${usageTotals.totals.calls} call(s)` +
      (models.length ? `\n        ${models.map(([m, u]) => `${m}: ${u.total.toLocaleString()} tok (${u.calls})`).join('\n        ')}` : ''),
  );

  const ready = major >= 20 && auth.credentialsFound;
  console.log(ready ? '\nReady. Start with:  npm run cli   (or: npm start)\n' : '\nNot ready — resolve the MISS items above.\n');
  process.exit(ready ? 0 : 1);
}

async function main(): Promise<void> {
  // A long-running agent must survive stray async errors from channel SDKs
  // (e.g. a bad token triggering a background auth probe) without dying.
  process.on('unhandledRejection', (reason) => logger.error({ reason: String(reason) }, 'unhandledRejection'));
  process.on('uncaughtException', (err) => logger.error({ err: String(err) }, 'uncaughtException'));

  const config = loadConfig();
  setToolOutputCap(config.toolOutputCap ?? 12000); // TokenJuice: sync tool-output cap from config
  if (process.argv.includes('--doctor') || process.argv.includes('--check')) doctor(config);
  initProviders(config.dataDir); // free-cloud provider rotation: daily usage tracking
  initClaudeModels(config.dataDir); // live Claude model list from the API (cached; falls back offline)
  initPlans(config.dataDir); // saved plans (proposed ones survive a restart)
  initLocalApps(config.dataDir); // saved SQL connection profiles for the Database app/tool
  initUrlWatch(config.dataDir); // Site Sentinel: the watched-URL list (checked by the urlHealth watcher)
  initJiraWatch(config.dataDir); // watched Jira tasks: followed issue keys (checked by the jiraTasks watcher)
  initWatchers(config.dataDir); // proactive watchers (Outlook inbox / site health / Jira tasks) that push notifications
  initAppScan(config.dataDir); // discover the host's installed apps for the desktop launchers
  const auth = checkAuth();
  logger.info(
    { dataDir: config.dataDir, model: config.model ?? '(cli default)', auth: auth.note },
    'Zamolxis starting',
  );

  const sessions = new SessionStore(config.dataDir);
  const throttle = new Throttle(config.maxConcurrent);
  // Curated memory (SOUL/USER/MEMORY) + full-text session archive — both global.
  const memory = new MemoryManager(config.dataDir);
  const sessionIndex = new SessionIndex(config.dataDir);
  // Token accounting for the paid (metered) models — total + current session.
  const usage = new UsageTracker(config.dataDir);
  // Self-authored skills — created up-front so the engine can surface them to the local model.
  const skills = new SkillsManager(config.skillsDir, config.extraSkillsDirs);
  // Seed the skills bundled with the install (skills-seed/) on first run. One-time per slug,
  // non-destructive — user edits/deletes are preserved.
  try {
    const seedDir = fileURLToPath(new URL('../skills-seed', import.meta.url));
    skills.seedFrom(seedDir);
  } catch (err) {
    logger.warn({ err: String(err) }, 'skill seeding skipped');
  }
  const agentStore = new AgentStore(config.dataDir);
  // In-memory log of agent messages (agent->agent and agent->user), polled by the web UI's
  // Agents chat and mirrored into the active chat. Capped; also archived for search.
  const agentMsgs: Array<{ from: string; to: string; text: string; ts: number; via?: string }> = [];
  const pushAgentMsg = (m: { from: string; to: string; text: string; ts: number; via?: string }) => {
    agentMsgs.push(m);
    if (agentMsgs.length > 500) agentMsgs.shift();
    try { sessionIndex.record('agents', m.from, `-> ${m.to}: ${m.text}`, m.ts); } catch { /* best-effort */ }
    logger.info({ from: m.from, to: m.to }, 'agent message');
  };
  // Scheduler is created before the engine so the engine can drive it: auto-schedule an agent
  // when the planner extracts a recurring job from the story, and suspend/resume on Stop.
  const scheduler = new Scheduler(config.dataDir);
  // Pre-made agents (seeded once per name; the user can edit, reschedule, stop, or delete them
  // like any other agent and they are NOT re-imposed). Cron schedules are seeded only together
  // with the agent's first creation, so a deleted schedule stays deleted.
  // Only the two heaviest-reasoning agents start on the top Claude tier; everything else runs on
  // Sonnet, which is plenty for routine watch/triage work and a fraction of the token cost. New
  // agents are seeded PAUSED so a fresh install doesn't quietly burn the model budget — the user
  // turns on the ones they actually want from the Sub-agents panel.
  const TOP_TIER = new Set(['research-analyst', 'pr-reviewer', 'desktop-automation']);
  for (const pre of PREMADE_AGENTS) {
    try {
      // Already present: just make sure it is tagged as pre-made (idempotent; tags installs seeded
      // before the flag existed) so the UI offers Hide instead of Delete for it.
      if (agentStore.get(pre.name)) { agentStore.setPremade(pre.name, true); continue; }
      agentStore.upsert({ name: pre.name, label: pre.label, job: pre.job, tools: pre.tools, model: TOP_TIER.has(pre.name) ? 'claude' : 'sonnet', canElevate: true, open: pre.open, createdBy: 'user', help: pre.help, guide: pre.guide, premade: true });
      agentStore.setStopped(pre.name, true);
      // Agents with their own page (John the Butler's duties dashboard) seed with Web-page delivery on.
      if (pre.webPage) agentStore.setDeliver(pre.name, { chat: true, web: true });
      if (pre.cron && scheduler.countByAgent(pre.name) === 0) {
        scheduler.add({ name: `agent:${pre.name}`, agent: pre.name, prompt: '', cron: pre.cron, channel: 'agent', chatId: pre.name, conversationKey: `agent:${pre.name}` });
        scheduler.setAgentEnabled(pre.name, false); // seeded paused: schedule defined but disarmed
      }
      logger.info({ name: pre.name, cron: pre.cron }, 'pre-made agent seeded');
    } catch (err) {
      logger.warn({ err: String(err), name: pre.name }, 'pre-made agent seeding skipped');
    }
  }
  // One-time usage clamp for installs that seeded the pre-made agents on the top tier / aggressive
  // cadences: move routine agents off the top tier onto Sonnet (only if still on a default tier, so
  // a deliberate choice is preserved), re-time the two agents whose cadence changed, and pause
  // everything so nothing runs until the user opts in. Once only (marker), so later tweaks stick.
  // NOTE: this only changes Claude tiers + paused state — the provider routing (paid/free/local) is
  // untouched. Re-enable any agent from Settings → Sub-agents.
  try {
    const fsmod = await import('node:fs');
    const pathmod = await import('node:path');
    const usageMarker = pathmod.join(config.dataDir, '.premade-usage-v1');
    if (!fsmod.existsSync(usageMarker)) {
      const keepTopTier = new Set(['research-analyst', 'pr-reviewer', 'desktop-automation']);
      const recadence: Record<string, string> = { 'jira-watcher': '0 8-17 * * 1-5', 'meeting-prep': '0 */3 * * 1-5' };
      for (const pre of PREMADE_AGENTS) {
        const a = agentStore.get(pre.name);
        if (!a) continue;
        if (!keepTopTier.has(pre.name) && (a.model === 'claude' || a.model === 'auto')) agentStore.setModel(pre.name, 'sonnet');
        const cron = recadence[pre.name];
        if (cron) {
          for (const j of scheduler.list().filter((s) => s.agent === pre.name)) scheduler.cancel(j.id);
          scheduler.add({ name: `agent:${pre.name}`, agent: pre.name, prompt: '', cron, channel: 'agent', chatId: pre.name, conversationKey: `agent:${pre.name}` });
        }
        agentStore.setStopped(pre.name, true);
        scheduler.setAgentEnabled(pre.name, false);
      }
      fsmod.writeFileSync(usageMarker, new Date().toISOString());
      logger.info('one-time pre-made agent usage clamp applied (Sonnet tier + paused)');
    }
    // One-time refresh: Desktop Automation's job/help/guide now bind it explicitly to the Laws
    // (Prime Directives). upsert preserves the user-controllable bits (model, paused state, schedule).
    const lawsMarker = pathmod.join(config.dataDir, '.premade-laws-v1');
    if (!fsmod.existsSync(lawsMarker)) {
      for (const pre of PREMADE_AGENTS.filter((p) => p.name === 'desktop-automation')) {
        if (!agentStore.get(pre.name)) continue;
        agentStore.upsert({ name: pre.name, label: pre.label, job: pre.job, tools: pre.tools, help: pre.help, guide: pre.guide });
      }
      fsmod.writeFileSync(lawsMarker, new Date().toISOString());
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'usage-clamp migration skipped');
  }
  // Per-(model, skill) ban list: a banned model refuses that capability; auto-populated on escalate.
  const bans = new BanStore(config.dataDir);
  // Per-agent published "last result" pages, served at /<agent-name> when web delivery is on.
  const agentPages = new AgentPages(config.dataDir);
  // Rolling ledger of finished agent runs (cost, duration, outcome) for the observability dashboard.
  const runs = new RunHistory(config.dataDir);
  // Remembered tool-permission grants (per chat / skill / agent) for the interactive posture.
  const permissions = new PermissionStore(config.dataDir);
  const engine = new Engine({
    config, sessions, throttle, memory, sessionIndex, usage, skills, agentStore, bans, pages: agentPages, runs, permissions,
    // External MCP servers the user wired up in <dataDir>/mcp.json (merged alongside the built-in
    // `zamolxis` server at query time); lets agents like Desktop Automation reach extra toolsets.
    mcpServers: loadExternalMcpServers(config.dataDir),
    onAgentMessage: pushAgentMsg,
    scheduleAgent: (name, cron, task) => void scheduler.add({ name: `agent:${name}`, agent: name, prompt: task || '', cron, channel: 'agent', chatId: name, conversationKey: `agent:${name}` }),
    countAgentSchedules: (name) => scheduler.countByAgent(name),
    setAgentSchedulesEnabled: (name, enabled) => scheduler.setAgentEnabled(name, enabled),
  });
  // Claude Code delegation: subtasks run as Claude Code workers (SDK in a project folder, or the
  // headless CLI) on their own throttle. Late-bound both ways: it asks the engine for permissions.
  const orchestrator = new Orchestrator({ config, memory, runs, bans, usage, host: engine });
  engine.delegator = orchestrator;
  // Agent-managed dashboard tabs (web UI), with optional periodic refresh.
  const tabs = new TabsManager(config.dataDir);
  tabs.wire(engine);

  const manager = new ChannelManager(engine);

  // Wire the scheduler to the engine + channels (created above).
  scheduler.wire(engine, manager);
  // OPT-IN (set ZAMOLXIS_AGENT_TRIGGER=windows): mirror each scheduled agent into the Windows Task
  // Scheduler so the OS triggers it (it shows up there and fires even with the app closed), instead
  // of the in-process timer. Each schedule becomes a task that runs `zamolxis run-agent <name>`.
  // Defaulted OFF so it doesn't silently move live agents to OS scheduling / create schtasks; the
  // full machinery is in place and flips on with that env var.
  scheduler.winTrigger = process.platform === 'win32' && (process.env.ZAMOLXIS_AGENT_TRIGGER || '').toLowerCase() === 'windows';
  scheduler.winExec = { nodeExe: process.execPath, binPath: fileURLToPath(new URL('../bin/zamolxis.mjs', import.meta.url)) };

  let reloading = false;

  // (Re)build the reloadable layer: sandbox, settings, the per-turn MCP tools,
  // and the channel set — from the current `config`. Called at boot and on reload.
  function wire(): void {
    const sandbox = new SandboxManager(config.sandbox);
    const settings = new SettingsManager(config, sandbox, config.dataDir, () => manager.runningNames(), memory);
    engine.buildMcpServers = (ctx) =>
      buildToolServers(ctx, { scheduler, skills, sandbox, memory, sessionIndex, tabs, usage, localModel: config.localModel, dataDir: config.dataDir, skillsDir: config.skillsDir, agentStore, runAgent: (n, t) => engine.runAgent(n, t).then((r) => r.reply), delegate: (tasks, c, force) => orchestrator.delegateText(tasks, c, force), loadCodeModel: (m, op) => loadCodeModel(config, { model: m, onProgress: op }).then((r) => r.message), sendAgentMessage: (f, t, x) => engine.sendAgentMessage(f, t, x), compileAgent: (n) => engine.compileAgent(n), buildHaMap: () => engine.buildHaDeviceMap() });
    logger.info({ sandbox: sandbox.listConfigured(), default: sandbox.defaultBackend }, 'sandbox ready');

    const factories: Array<[boolean, () => Channel]> = [
      [config.channels.cli, () => {
        const cli = new CliChannel();
        engine.registerPermissionPrompter('cli', (ask) => cli.promptPermission(ask));
        return cli;
      }],
      [config.channels.telegram, () => new TelegramChannel()],
      [config.channels.discord, () => new DiscordChannel()],
      [config.channels.slack, () => new SlackChannel()],
      [config.channels.whatsapp, () => new WhatsAppChannel(config.dataDir)],
      [config.channels.signal, () => new SignalChannel()],
      [config.channels.email, () => new EmailChannel()],
      [config.channels.web, () => { const web = new WebChannel(config, settings, reload, (key) => sessions.purge(key), tabs, usage, skills, memory, agentStore, (n, t, force) => engine.runAgent(n, t, { force }).then((r) => ({ reply: r.reply, via: r.via, isError: r.isError, report: r.report })), agentMsgs,
        (name, cron, task) => scheduler.add({ name: `agent:${name}`, agent: name, prompt: task || '', cron, channel: 'agent', chatId: name, conversationKey: `agent:${name}` }),
        () => scheduler.list().filter((j) => j.agent).map((j) => ({ id: j.id, agent: j.agent, cron: j.cron, at: j.at, prompt: j.prompt })),
        (id) => scheduler.cancel(id),
        (n) => engine.compileAgent(n),
        (text) => engine.nlToCron(text),
        (n, stop) => engine.stopAgent(n, stop),
        (n) => engine.analyzeAgent(n),
        (key) => sessionIndex.recent(key, 50),
        {
          list: () => bans.list(),
          add: (model: string, skill: string) => (isSmartestModel(model) ? { ok: false, reason: 'the smartest model cannot be banned' } : bans.add(model, skill)),
          remove: (model: string, skill: string) => bans.remove(model, skill),
          capabilities: () => engine.capabilityNames(),
          models: () => ['local', ...configuredProviders().map((p) => p.id)],
        },
        () => manager.connectedChannels(),
        (name) => manager.channelMessages(name),
        (name, chatId, text) => manager.sendToChannel(name, chatId, text),
        agentPages,
        (text, conversationKey) => engine.run({ conversationKey, text }).then((r) => ({ reply: r.reply, isError: r.isError })),
        {
          list: () => permissions.list(),
          revoke: (scope: string, tool: string) => permissions.revoke(scope, tool),
          clearScope: (scope: string) => permissions.clearScope(scope),
        },
        (agent, reply, via) => scheduler.deliverToChannels(agent, reply, via),
        (key) => engine.cancelTurn(key));
        engine.registerPermissionPrompter('web', (ask) => web.promptPermission(ask));
        return web;
      }],
    ];
    for (const [enabled, make] of factories) {
      if (!enabled) continue;
      try {
        manager.register(make());
      } catch (err) {
        logger.error({ err: String(err) }, 'channel failed to initialize — skipping');
      }
    }
  }

  // Live reload (triggered by the web Settings panel): stop channels, re-apply
  // persisted settings + credentials, then rebuild and restart channels. Avoids
  // a full process restart, so it works even without a process supervisor.
  async function reload(): Promise<void> {
    if (reloading) return;
    reloading = true;
    try {
      logger.info('reload: applying settings and restarting channels');
      await manager.stopAll();
      manager.clear();
      applyPersistedSettings(config);
      wire();
      await manager.startAll();
      logger.info('reload complete');
    } catch (err) {
      logger.error({ err: String(err) }, 'reload failed');
    } finally {
      reloading = false;
    }
  }

  wire();
  await manager.startAll();
  scheduler.start();
  engine.applyAgentStartupPolicy(); // pause agents per the restore setting / per-agent autostart
  tabs.start();
  // Event-driven triggers: fire an agent when a file lands or a resource threshold is crossed -
  // the reactive counterpart to the scheduler's clock. Reloads triggers.json on the fly so the
  // web UI can add/toggle triggers without a restart. The reply goes back through the agent
  // message bus, the same path an agent-scheduled job uses.
  const triggerStore = new TriggerStore(config.dataDir);
  const triggerWatcher = new TriggerWatcher(triggerStore, {
    runAgent: (name, task) => engine.runAgent(name, task, { force: true, origin: 'event' }).then((r) => ({ reply: r.reply, via: r.via, isError: r.isError })),
    deliver: async (agent, reply, via) => { await engine.sendAgentMessage(agent, 'user', reply, via); },
    isRunnable: (name) => engine.isAgentRunnable(name),
    notify: (title, body, kind) => void pushNotif(title, body, kind),
  });
  triggerWatcher.start();
  logger.info('Zamolxis up');

  // Keep-alive heartbeat: guarantees the event loop stays alive even with no
  // active channels or scheduled jobs, so a process manager never restart-loops
  // an "idle" daemon. Also a cheap liveness signal in the logs.
  const heartbeat = setInterval(() => logger.debug('heartbeat'), 60_000);

  const shutdown = async (sig: string) => {
    logger.info({ sig }, 'shutting down');
    clearInterval(heartbeat);
    scheduler.stop();
    triggerWatcher.stop();
    tabs.stop();
    sessionIndex.close();
    await manager.stopAll();
    // Voice sidecars (whisper-server, Kokoro) are stopped by the web channel; this catches any left over.
    stopWhisperServers();
    stopKokoroSidecars();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err: String(err) }, 'fatal');
  process.exit(1);
});
