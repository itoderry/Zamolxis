import { fileURLToPath } from 'node:url';
import { loadConfig, applyPersistedSettings, type ZamolxisConfig } from './config.js';
import { logger } from './logger.js';
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
import { initProviders } from './core/providers.js';
import { initClaudeModels } from './core/claudeModels.js';
import { initLocalApps } from './core/localApps.js';
import { initWatchers } from './core/watchers.js';
import { initAppScan } from './core/appscan.js';
import { initUrlWatch } from './core/urlwatch.js';
import { initJiraWatch } from './core/jirawatch.js';
import { PREMADE_AGENTS } from './core/premadeAgents.js';
import { BanStore, isSmartestModel } from './core/bans.js';
import { configuredProviders } from './core/providers.js';
import { buildToolServers } from './tools/index.js';

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
  if (process.argv.includes('--doctor') || process.argv.includes('--check')) doctor(config);
  initProviders(config.dataDir); // free-cloud provider rotation: daily usage tracking
  initClaudeModels(config.dataDir); // live Claude model list from the API (cached; falls back offline)
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
  for (const pre of PREMADE_AGENTS) {
    try {
      if (agentStore.get(pre.name)) continue;
      agentStore.upsert({ name: pre.name, label: pre.label, job: pre.job, tools: pre.tools, model: 'claude', canElevate: true, open: pre.open, createdBy: 'user', help: pre.help, guide: pre.guide });
      if (pre.cron && scheduler.countByAgent(pre.name) === 0) {
        scheduler.add({ name: `agent:${pre.name}`, agent: pre.name, prompt: '', cron: pre.cron, channel: 'agent', chatId: pre.name, conversationKey: `agent:${pre.name}` });
      }
      logger.info({ name: pre.name, cron: pre.cron }, 'pre-made agent seeded');
    } catch (err) {
      logger.warn({ err: String(err), name: pre.name }, 'pre-made agent seeding skipped');
    }
  }
  // Per-(model, skill) ban list: a banned model refuses that capability; auto-populated on escalate.
  const bans = new BanStore(config.dataDir);
  const engine = new Engine({
    config, sessions, throttle, memory, sessionIndex, usage, skills, agentStore, bans, onAgentMessage: pushAgentMsg,
    scheduleAgent: (name, cron, task) => void scheduler.add({ name: `agent:${name}`, agent: name, prompt: task || '', cron, channel: 'agent', chatId: name, conversationKey: `agent:${name}` }),
    countAgentSchedules: (name) => scheduler.countByAgent(name),
    setAgentSchedulesEnabled: (name, enabled) => scheduler.setAgentEnabled(name, enabled),
  });
  // Agent-managed dashboard tabs (web UI), with optional periodic refresh.
  const tabs = new TabsManager(config.dataDir);
  tabs.wire(engine);

  const manager = new ChannelManager(engine);

  // Wire the scheduler to the engine + channels (created above).
  scheduler.wire(engine, manager);

  let reloading = false;

  // (Re)build the reloadable layer: sandbox, settings, the per-turn MCP tools,
  // and the channel set — from the current `config`. Called at boot and on reload.
  function wire(): void {
    const sandbox = new SandboxManager(config.sandbox);
    const settings = new SettingsManager(config, sandbox, config.dataDir, () => manager.runningNames(), memory);
    engine.buildMcpServers = (ctx) =>
      buildToolServers(ctx, { scheduler, skills, sandbox, memory, sessionIndex, tabs, usage, localModel: config.localModel, dataDir: config.dataDir, skillsDir: config.skillsDir, agentStore, runAgent: (n, t) => engine.runAgent(n, t).then((r) => r.reply), sendAgentMessage: (f, t, x) => engine.sendAgentMessage(f, t, x), compileAgent: (n) => engine.compileAgent(n), buildHaMap: () => engine.buildHaDeviceMap() });
    logger.info({ sandbox: sandbox.listConfigured(), default: sandbox.defaultBackend }, 'sandbox ready');

    const factories: Array<[boolean, () => Channel]> = [
      [config.channels.cli, () => new CliChannel()],
      [config.channels.telegram, () => new TelegramChannel()],
      [config.channels.discord, () => new DiscordChannel()],
      [config.channels.slack, () => new SlackChannel()],
      [config.channels.whatsapp, () => new WhatsAppChannel(config.dataDir)],
      [config.channels.signal, () => new SignalChannel()],
      [config.channels.email, () => new EmailChannel()],
      [config.channels.web, () => new WebChannel(config, settings, reload, (key) => sessions.purge(key), tabs, usage, skills, memory, agentStore, (n, t) => engine.runAgent(n, t).then((r) => ({ reply: r.reply, via: r.via })), agentMsgs,
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
        (name, chatId, text) => manager.sendToChannel(name, chatId, text))],
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
  logger.info('Zamolxis up');

  // Keep-alive heartbeat: guarantees the event loop stays alive even with no
  // active channels or scheduled jobs, so a process manager never restart-loops
  // an "idle" daemon. Also a cheap liveness signal in the logs.
  const heartbeat = setInterval(() => logger.debug('heartbeat'), 60_000);

  const shutdown = async (sig: string) => {
    logger.info({ sig }, 'shutting down');
    clearInterval(heartbeat);
    scheduler.stop();
    tabs.stop();
    sessionIndex.close();
    await manager.stopAll();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err: String(err) }, 'fatal');
  process.exit(1);
});
