import bolt from '@slack/bolt';
import type { Channel, ChannelHandler, OutboundMessage } from './types.js';
import { requireEnv } from './util.js';
import { logger } from '../logger.js';

const { App } = bolt;

/**
 * Slack channel via Socket Mode. Set SLACK_BOT_TOKEN (xoxb-…) and
 * SLACK_APP_TOKEN (xapp-…, with connections:write). Responds to DMs and mentions.
 */
export class SlackChannel implements Channel {
  readonly name = 'slack';
  private readonly app: InstanceType<typeof App>;

  constructor() {
    this.app = new App({
      token: requireEnv('SLACK_BOT_TOKEN', 'slack'),
      appToken: requireEnv('SLACK_APP_TOKEN', 'slack'),
      socketMode: true,
    });
  }

  async start(handler: ChannelHandler): Promise<void> {
    const onText = async (channelId: string, user: string | undefined, text: string, say: (t: string) => Promise<unknown>) => {
      try {
        const reply = await handler({ channel: this.name, chatId: channelId, from: user, text });
        await say(reply);
      } catch (err) {
        logger.error({ err: String(err) }, 'slack handler error');
      }
    };

    // Direct messages.
    this.app.message(async ({ message, say }) => {
      const m = message as { text?: string; user?: string; channel?: string; subtype?: string; channel_type?: string };
      if (m.subtype || !m.text || m.channel_type !== 'im') return;
      await onText(m.channel ?? '', m.user, m.text, (t) => say(t));
    });

    // @-mentions in channels.
    this.app.event('app_mention', async ({ event, say }) => {
      const e = event as { text?: string; user?: string; channel?: string };
      const text = (e.text ?? '').replace(/<@[^>]+>/g, '').trim();
      await onText(e.channel ?? '', e.user, text, (t) => say(t));
    });

    await this.app.start();
    logger.info('slack online (socket mode)');
  }

  async send(msg: OutboundMessage): Promise<void> {
    await this.app.client.chat.postMessage({ channel: msg.chatId, text: msg.text });
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }
}
