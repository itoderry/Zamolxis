import { Bot } from 'grammy';
import type { Channel, ChannelHandler, OutboundMessage } from './types.js';
import { chunk, requireEnv } from './util.js';
import { logger } from '../logger.js';

const TG_LIMIT = 4096;

/**
 * Telegram bot channel (grammY, long-polling). Set TELEGRAM_BOT_TOKEN.
 * Optional TELEGRAM_ALLOWED_USERS = comma-separated usernames (without @) and/or
 * numeric user ids; when set, only those users get a response.
 */
export class TelegramChannel implements Channel {
  readonly name = 'telegram';
  private readonly bot: Bot;
  private readonly allowed: Set<string>;

  constructor() {
    this.bot = new Bot(requireEnv('TELEGRAM_BOT_TOKEN', 'telegram'));
    this.allowed = new Set(
      (process.env.TELEGRAM_ALLOWED_USERS ?? '')
        .split(',')
        .map((s) => s.trim().replace(/^@/, '').toLowerCase())
        .filter(Boolean),
    );
  }

  private isAllowed(ctx: { from?: { id?: number; username?: string } }): boolean {
    if (this.allowed.size === 0) return true; // no allowlist => open
    const uname = ctx.from?.username?.toLowerCase();
    const uid = ctx.from?.id != null ? String(ctx.from.id) : undefined;
    return (uname != null && this.allowed.has(uname)) || (uid != null && this.allowed.has(uid));
  }

  async start(handler: ChannelHandler): Promise<void> {
    this.bot.on('message:text', async (ctx) => {
      try {
        if (!this.isAllowed(ctx)) {
          logger.warn({ from: ctx.from?.username ?? ctx.from?.id }, 'telegram: rejected unauthorized user');
          await ctx.reply('Sorry, you are not authorized to use this assistant.');
          return;
        }
        await ctx.replyWithChatAction('typing');
        const reply = await handler({
          channel: this.name,
          chatId: String(ctx.chat.id),
          from: ctx.from?.first_name ?? ctx.from?.username,
          text: ctx.message.text,
        });
        for (const part of chunk(reply, TG_LIMIT)) await ctx.reply(part);
      } catch (err) {
        logger.error({ err: String(err) }, 'telegram handler error');
      }
    });
    await this.bot.init();
    // bot.start() resolves only when the bot stops; run it detached.
    void this.bot.start({ onStart: (i) => logger.info({ username: i.username }, 'telegram online') });
  }

  async send(msg: OutboundMessage): Promise<void> {
    for (const part of chunk(msg.text, TG_LIMIT)) await this.bot.api.sendMessage(msg.chatId, part);
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }
}
