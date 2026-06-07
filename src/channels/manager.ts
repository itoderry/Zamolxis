import type { Channel, InboundMessage } from './types.js';
import { conversationKey } from './types.js';
import type { Engine } from '../core/engine.js';
import { logger } from '../logger.js';

/**
 * Owns the set of active channels, wires each one's inbound traffic to the
 * engine, and exposes channels for proactive sends (scheduler).
 */
/** The shared "main" conversation key. Web-main + every messaging channel are bridged to it. */
export const MAIN_KEY = 'main';
/** The web thread id that is the (undeletable) main chat. */
export const MAIN_WEB_CID = 'main';

export class ChannelManager {
  private readonly channels = new Map<string, Channel>();
  /** Channels that started without throwing — i.e. actually live. */
  private readonly started = new Set<string>();
  /** Bridged endpoints for the main chat: channelName -> chatId to deliver to (two-way mirror). */
  private readonly bridge = new Map<string, string>();
  /** Rolling log of messages per channel (for the Messages desktop client). */
  private readonly channelLog: Array<{ channel: string; chatId: string; from?: string; dir: 'in' | 'out'; text: string; ts: number }> = [];

  constructor(private readonly engine: Engine) {}

  private recordMsg(channel: string, chatId: string, from: string | undefined, dir: 'in' | 'out', text: string): void {
    this.channelLog.push({ channel, chatId, from, dir, text, ts: Date.now() });
    if (this.channelLog.length > 800) this.channelLog.splice(0, this.channelLog.length - 800);
  }

  /** Connected messaging channels (excludes web UI + local CLI) for the Messages client. */
  connectedChannels(): Array<{ name: string; running: boolean }> {
    return [...this.channels.keys()].filter((n) => n !== 'web' && n !== 'cli').map((n) => ({ name: n, running: this.started.has(n) }));
  }

  /** Recent messages for one channel, grouped chronologically (newest last). */
  channelMessages(channel: string): Array<{ chatId: string; from?: string; dir: 'in' | 'out'; text: string; ts: number }> {
    return this.channelLog.filter((m) => m.channel === channel).slice(-200).map((m) => ({ chatId: m.chatId, from: m.from, dir: m.dir, text: m.text, ts: m.ts }));
  }

  /** Send a message out through a specific channel to a specific chat. */
  async sendToChannel(channel: string, chatId: string, text: string): Promise<{ ok: boolean; error?: string }> {
    const ch = this.channels.get(channel);
    if (!ch) return { ok: false, error: 'channel not connected' };
    try {
      await ch.send({ chatId, text });
      this.recordMsg(channel, chatId, 'you', 'out', text);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message || err) };
    }
  }

  /** Is this inbound message part of the shared main conversation?
   *  Web: only the dedicated main thread. CLI: no (local REPL). All messaging channels: yes —
   *  every configured chat the user set up feeds/mirrors the one main chat. */
  private isBridged(msg: InboundMessage): boolean {
    if (msg.channel === 'web') return msg.chatId === MAIN_WEB_CID;
    if (msg.channel === 'cli') return false;
    return true;
  }

  /** Mirror text to every bridged surface except the originating channel. */
  private broadcast(originChannel: string, text: string): void {
    for (const [chName, chatId] of this.bridge) {
      if (chName === originChannel) continue;
      const ch = this.channels.get(chName);
      if (ch) void ch.send({ chatId, text }).catch((err) => logger.warn({ err: String(err), ch: chName }, 'main-chat bridge send failed'));
    }
  }

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
    const bridged = this.isBridged(msg);
    const key = bridged ? MAIN_KEY : conversationKey(msg);
    if (bridged) {
      // Remember this surface as a main-chat endpoint, and mirror the user's message to the others
      // so the conversation reads the same everywhere (two-way across all configured channels).
      this.bridge.set(msg.channel, msg.chatId);
      this.broadcast(msg.channel, `💬 ${msg.from || 'you'}: ${msg.text}`);
    }
    logger.info({ key, from: msg.from, len: msg.text.length, bridged }, 'inbound');
    const result = await this.engine.run({
      conversationKey: key,
      text: msg.text,
      channel: msg.channel,
      chatId: msg.chatId,
      displayName: msg.from,
      route: msg.route,
      model: msg.model,
      images: msg.images,
      onProgress,
    });
    logger.info({ key, costUsd: result.costUsd, isError: result.isError }, 'replied');
    // Record the turn per channel for the Messages client (real inbound/outbound history).
    this.recordMsg(msg.channel, msg.chatId, msg.from, 'in', msg.text);
    this.recordMsg(msg.channel, msg.chatId, undefined, 'out', result.reply);
    // Mirror the assistant's reply to the other bridged surfaces (the origin gets it via return).
    if (bridged) this.broadcast(msg.channel, result.reply);
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
