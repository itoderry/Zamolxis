import type { Channel, InboundMessage } from './types.js';
import { conversationKey } from './types.js';
import type { Engine } from '../core/engine.js';
import { logger } from '../logger.js';

/**
 * Owns the set of active channels, wires each one's inbound traffic to the
 * engine, and exposes channels for proactive sends (scheduler).
 */
export class ChannelManager {
  private readonly channels = new Map<string, Channel>();
  /** Channels that started without throwing — i.e. actually live. */
  private readonly started = new Set<string>();

  constructor(private readonly engine: Engine) {}

  register(channel: Channel): void {
    this.channels.set(channel.name, channel);
  }

  get(name: string): Channel | undefined {
    return this.channels.get(name);
  }

  /** Names of channels currently running (started successfully). */
  runningNames(): string[] {
    return [...this.started];
  }

  /** Drop all registered channels (after stopAll) so they can be rebuilt on reload. */
  clear(): void {
    this.channels.clear();
    this.started.clear();
  }

  async startAll(): Promise<void> {
    for (const channel of this.channels.values()) {
      try {
        await channel.start((msg, onProgress) => this.handle(msg, onProgress));
        this.started.add(channel.name);
        logger.info({ channel: channel.name }, 'channel started');
      } catch (err) {
        // One channel failing to start (e.g. a bad token) must not take down the
        // others — especially the web UI you'd use to fix the setting.
        logger.error({ channel: channel.name, err: String(err) }, 'channel failed to start — skipping');
      }
    }
  }

  private async handle(msg: InboundMessage, onProgress?: (chunk: string) => void): Promise<string> {
    const key = conversationKey(msg);
    logger.info({ key, from: msg.from, len: msg.text.length }, 'inbound');
    const result = await this.engine.run({
      conversationKey: key,
      text: msg.text,
      channel: msg.channel,
      chatId: msg.chatId,
      displayName: msg.from,
      route: msg.route,
      model: msg.model,
      onProgress,
    });
    logger.info({ key, costUsd: result.costUsd, isError: result.isError }, 'replied');
    return result.reply;
  }

  async stopAll(): Promise<void> {
    for (const channel of this.channels.values()) {
      try {
        await channel.stop();
      } catch (err) {
        logger.warn({ channel: channel.name, err: String(err) }, 'channel stop failed');
      }
    }
  }
}
