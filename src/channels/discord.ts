import { Client, GatewayIntentBits, Events, Partials, type TextBasedChannel } from 'discord.js';
import type { Channel, ChannelHandler, OutboundMessage } from './types.js';
import { chunk, requireEnv } from './util.js';
import { logger } from '../logger.js';

const DISCORD_LIMIT = 2000;

/**
 * Discord bot channel (discord.js). Responds to direct messages and to messages
 * that mention the bot in a guild. Set DISCORD_BOT_TOKEN.
 */
export class DiscordChannel implements Channel {
  readonly name = 'discord';
  private readonly client: Client;
  private readonly token: string;

  constructor() {
    this.token = requireEnv('DISCORD_BOT_TOKEN', 'discord');
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    });
  }

  async start(handler: ChannelHandler): Promise<void> {
    this.client.on(Events.MessageCreate, async (message) => {
      if (message.author.bot) return;
      const isDM = !message.guild;
      const mentioned = this.client.user ? message.mentions.has(this.client.user) : false;
      if (!isDM && !mentioned) return;

      const text = this.client.user
        ? message.content.replace(`<@${this.client.user.id}>`, '').trim()
        : message.content;
      try {
        const reply = await handler({
          channel: this.name,
          chatId: message.channelId,
          from: message.author.username,
          text,
        });
        for (const part of chunk(reply, DISCORD_LIMIT)) await message.reply(part);
      } catch (err) {
        logger.error({ err: String(err) }, 'discord handler error');
      }
    });

    this.client.once(Events.ClientReady, (c) => logger.info({ tag: c.user.tag }, 'discord online'));
    await this.client.login(this.token);
  }

  async send(msg: OutboundMessage): Promise<void> {
    const channel = (await this.client.channels.fetch(msg.chatId)) as TextBasedChannel | null;
    if (channel && 'send' in channel) {
      for (const part of chunk(msg.text, DISCORD_LIMIT)) await channel.send(part);
    }
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }
}
