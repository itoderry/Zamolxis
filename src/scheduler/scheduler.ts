import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Cron } from 'croner';
import { logger } from '../logger.js';
import type { Engine } from '../core/engine.js';
import type { ChannelManager } from '../channels/manager.js';

export interface ScheduledJob {
  id: string;
  name: string;
  /** Cron expression for recurring jobs (mutually exclusive with `at`). */
  cron?: string;
  /** ISO timestamp for a one-shot job. */
  at?: string;
  /** The instruction handed to the agent when the job fires. */
  prompt: string;
  /** If set, run this named user-defined agent (its job/tools/model/elevation) instead of a raw prompt. */
  agent?: string;
  /** Where to deliver the result. */
  channel: string;
  chatId: string;
  conversationKey: string;
  enabled: boolean;
  lastRun?: number;
}

/**
 * Natural-language-friendly scheduler: the agent calls the `schedule_task` tool,
 * a job is persisted, and this scheduler fires it on time — running the prompt
 * through the engine and delivering the reply to the originating channel.
 */
export class Scheduler {
  private readonly file: string;
  private jobs: ScheduledJob[] = [];
  private readonly crons = new Map<string, Cron>();
  private engine?: Engine;
  private channels?: ChannelManager;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'jobs.json');
    this.load();
  }

  wire(engine: Engine, channels: ChannelManager): void {
    this.engine = engine;
    this.channels = channels;
  }

  private load(): void {
    try {
      this.jobs = JSON.parse(fs.readFileSync(this.file, 'utf8')) as ScheduledJob[];
    } catch {
      this.jobs = [];
    }
  }

  private persist(): void {
    fs.writeFileSync(this.file, JSON.stringify(this.jobs, null, 2));
  }

  /** Arm all enabled jobs. Call once after wiring. */
  start(): void {
    for (const job of this.jobs) if (job.enabled) this.arm(job);
    logger.info({ count: this.crons.size }, 'scheduler started');
  }

  private arm(job: ScheduledJob): void {
    this.disarm(job.id);
    const pattern = job.cron ?? (job.at ? new Date(job.at) : undefined);
    if (!pattern) return;
    const cron = new Cron(pattern as string | Date, { name: job.id }, () => void this.fire(job.id));
    this.crons.set(job.id, cron);
  }

  private disarm(id: string): void {
    this.crons.get(id)?.stop();
    this.crons.delete(id);
  }

  private async fire(id: string): Promise<void> {
    const job = this.jobs.find((j) => j.id === id);
    if (!job || !this.engine || !this.channels) return;
    // Skip agents that are stopped or paused by the startup restore policy (no run, no delivery).
    if (job.agent && this.engine.isAgentRunnable && !this.engine.isAgentRunnable(job.agent)) return;
    logger.info({ id, name: job.name }, 'job firing');
    try {
      const result = job.agent
        ? await this.engine.runAgent(job.agent, job.prompt)
        : await this.engine.run({
            conversationKey: job.conversationKey,
            text: job.prompt,
            channel: job.channel,
            chatId: job.chatId,
            displayName: `scheduler:${job.name}`,
          });
      const channel = this.channels.get(job.channel);
      if (channel) {
        await channel.send({ chatId: job.chatId, text: job.agent ? `[agent ${job.agent}] ${result.reply}` : result.reply });
      } else if (job.agent) {
        // Agent-scheduled jobs carry channel:'agent', which is not a real channel — deliver the
        // result back through the agent message bus (surfaced to the web UI + CLI, mirrored into chat).
        await this.engine.sendAgentMessage(job.agent, 'user', result.reply);
      }
    } catch (err) {
      logger.error({ id, err: String(err) }, 'job failed');
    } finally {
      job.lastRun = Date.now();
      if (job.at) {
        job.enabled = false; // one-shot
        this.disarm(job.id);
      }
      this.persist();
    }
  }

  add(job: Omit<ScheduledJob, 'id' | 'enabled'>): ScheduledJob {
    const full: ScheduledJob = { ...job, id: randomUUID(), enabled: true };
    this.jobs.push(full);
    this.persist();
    this.arm(full);
    return full;
  }

  list(conversationKey?: string): ScheduledJob[] {
    return conversationKey ? this.jobs.filter((j) => j.conversationKey === conversationKey) : this.jobs;
  }

  cancel(id: string): boolean {
    const idx = this.jobs.findIndex((j) => j.id === id);
    if (idx < 0) return false;
    this.disarm(id);
    this.jobs.splice(idx, 1);
    this.persist();
    return true;
  }

  /** Count schedules bound to a given agent. */
  countByAgent(agent: string): number {
    return this.jobs.filter((j) => j.agent === agent).length;
  }

  /** Suspend (enabled=false → disarm) or resume (enabled=true → arm) ALL schedules for an agent.
   *  Used by the agent "Stop" control. Returns how many jobs were affected. */
  setAgentEnabled(agent: string, enabled: boolean): number {
    let n = 0;
    for (const job of this.jobs) {
      if (job.agent !== agent) continue;
      job.enabled = enabled;
      if (enabled) this.arm(job);
      else this.disarm(job.id);
      n++;
    }
    if (n) this.persist();
    return n;
  }

  stop(): void {
    for (const cron of this.crons.values()) cron.stop();
    this.crons.clear();
  }
}
