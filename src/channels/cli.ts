import * as readline from 'node:readline';
import { stdin, stdout } from 'node:process';
import type { Channel, ChannelHandler, OutboundMessage } from './types.js';
import { logger } from '../logger.js';

/**
 * Local stdin/stdout channel. The simplest possible surface — proves the full
 * inbound -> engine -> outbound loop without any external service or token.
 */
export class CliChannel implements Channel {
  readonly name = 'cli';
  private rl?: readline.Interface;
  private handler?: ChannelHandler;
  private closed = false;

  async start(handler: ChannelHandler): Promise<void> {
    // No interactive terminal (running under a service / pm2)? Stand down so we
    // don't spin on a closed stdin — the other channels and scheduler carry on.
    if (!stdin.isTTY) {
      this.closed = true;
      logger.info('cli channel idle: no interactive TTY');
      return;
    }
    this.handler = handler;
    this.rl = readline.createInterface({ input: stdin, output: stdout, prompt: 'you › ' });
    stdout.write('Zamolxis CLI ready. Type a message (Ctrl+C to exit).\n');
    this.rl.prompt();

    this.rl.on('line', async (line) => {
      const text = line.trim();
      if (!text) return this.prompt();
      this.rl?.pause();
      try {
        const reply = await this.handler!({ channel: this.name, chatId: 'local', from: 'you', text });
        if (!this.closed) stdout.write(`\nzamolxis › ${reply}\n\n`);
      } catch (err) {
        logger.error({ err: String(err) }, 'cli handler error');
        if (!this.closed) stdout.write(`\nzamolxis › (error)\n\n`);
      }
      if (!this.closed) {
        this.rl?.resume();
        this.prompt();
      }
    });

    this.rl.on('close', () => {
      this.closed = true;
      stdout.write('\nbye.\n');
    });
  }

  async send(msg: OutboundMessage): Promise<void> {
    if (this.closed) return;
    stdout.write(`\nzamolxis › ${msg.text}\n\n`);
    this.prompt();
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.rl?.close();
  }

  private prompt(): void {
    if (!this.closed) this.rl?.prompt();
  }
}
