import path from 'node:path';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import type { WASocket } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import type { Channel, ChannelHandler, OutboundMessage } from './types.js';
import { logger } from '../logger.js';

/**
 * WhatsApp channel via Baileys (multi-device web protocol). First run prints a
 * QR code in the terminal to pair with your phone; credentials persist under
 * <dataDir>/whatsapp-auth so later runs reconnect automatically.
 */
export class WhatsAppChannel implements Channel {
  readonly name = 'whatsapp';
  private sock?: WASocket;
  private handler?: ChannelHandler;
  private readonly authDir: string;
  private stopped = false;

  constructor(dataDir: string) {
    this.authDir = path.join(dataDir, 'whatsapp-auth');
  }

  async start(handler: ChannelHandler): Promise<void> {
    this.handler = handler;
    await this.connect();
  }

  private async connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const sock = makeWASocket({ auth: state });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      if (update.qr) {
        logger.info('whatsapp: scan the QR code below to pair');
        qrcode.generate(update.qr, { small: true });
      }
      if (update.connection === 'open') logger.info('whatsapp online');
      if (update.connection === 'close') {
        const code = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
          ?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        if (!this.stopped && !loggedOut) {
          logger.warn('whatsapp connection closed — reconnecting');
          void this.connect();
        } else if (loggedOut) {
          logger.error('whatsapp logged out — delete the auth dir and re-pair');
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        const jid = m.key.remoteJid;
        if (!jid || m.key.fromMe || jid === 'status@broadcast') continue;
        const text = m.message?.conversation ?? m.message?.extendedTextMessage?.text ?? '';
        if (!text) continue;
        try {
          const reply = await this.handler!({
            channel: this.name,
            chatId: jid,
            from: m.pushName ?? undefined,
            text,
          });
          await sock.sendMessage(jid, { text: reply });
        } catch (err) {
          logger.error({ err: String(err) }, 'whatsapp handler error');
        }
      }
    });
  }

  async send(msg: OutboundMessage): Promise<void> {
    await this.sock?.sendMessage(msg.chatId, { text: msg.text });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.sock?.logout().catch(() => {});
  }
}
