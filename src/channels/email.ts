import { ImapFlow } from 'imapflow';
import nodemailer, { type Transporter } from 'nodemailer';
import { simpleParser } from 'mailparser';
import type { Channel, ChannelHandler, OutboundMessage } from './types.js';
import { requireEnv } from './util.js';
import { logger } from '../logger.js';

/**
 * Email channel. Polls IMAP for unseen mail and replies via SMTP. The chatId is
 * the correspondent's email address. Configure:
 *   EMAIL_IMAP_HOST, EMAIL_IMAP_PORT (993), EMAIL_USER, EMAIL_PASSWORD,
 *   EMAIL_SMTP_HOST, EMAIL_SMTP_PORT (465), EMAIL_FROM (defaults to EMAIL_USER),
 *   EMAIL_POLL_SECONDS (default 30).
 */
export class EmailChannel implements Channel {
  readonly name = 'email';
  private handler?: ChannelHandler;
  private timer?: NodeJS.Timeout;
  private polling = false;
  private readonly smtp: Transporter;
  private readonly user: string;
  private readonly from: string;
  private readonly imapConfig: { host: string; port: number; secure: boolean; auth: { user: string; pass: string } };
  private readonly intervalMs: number;

  constructor() {
    this.user = requireEnv('EMAIL_USER', 'email');
    const pass = requireEnv('EMAIL_PASSWORD', 'email');
    this.from = process.env.EMAIL_FROM || this.user;
    this.intervalMs = Number(process.env.EMAIL_POLL_SECONDS ?? 30) * 1000;
    this.imapConfig = {
      host: requireEnv('EMAIL_IMAP_HOST', 'email'),
      port: Number(process.env.EMAIL_IMAP_PORT ?? 993),
      secure: true,
      auth: { user: this.user, pass },
    };
    this.smtp = nodemailer.createTransport({
      host: requireEnv('EMAIL_SMTP_HOST', 'email'),
      port: Number(process.env.EMAIL_SMTP_PORT ?? 465),
      secure: Number(process.env.EMAIL_SMTP_PORT ?? 465) === 465,
      auth: { user: this.user, pass },
    });
  }

  async start(handler: ChannelHandler): Promise<void> {
    this.handler = handler;
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    logger.info({ everySec: this.intervalMs / 1000 }, 'email online (imap polling)');
    void this.poll();
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    const client = new ImapFlow({ ...this.imapConfig, logger: false });
    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        for await (const msg of client.fetch({ seen: false }, { source: true, uid: true })) {
          if (!msg.source) continue;
          const parsed = await simpleParser(msg.source);
          const fromAddr = parsed.from?.value?.[0]?.address;
          const subject = parsed.subject ?? '(no subject)';
          const body = (parsed.text ?? '').trim();
          if (!fromAddr || !body) continue;
          try {
            const reply = await this.handler!({
              channel: this.name,
              chatId: fromAddr,
              from: parsed.from?.value?.[0]?.name || fromAddr,
              text: `Subject: ${subject}\n\n${body}`,
            });
            await this.smtp.sendMail({ from: this.from, to: fromAddr, subject: `Re: ${subject}`, text: reply });
          } catch (err) {
            logger.error({ err: String(err) }, 'email handler error');
          }
          await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen'], { uid: true });
        }
      } finally {
        lock.release();
      }
    } catch (err) {
      logger.warn({ err: String(err) }, 'email poll failed');
    } finally {
      await client.logout().catch(() => {});
      this.polling = false;
    }
  }

  async send(msg: OutboundMessage): Promise<void> {
    await this.smtp.sendMail({ from: this.from, to: msg.chatId, subject: 'Message from Zamolxis', text: msg.text });
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
  }
}
