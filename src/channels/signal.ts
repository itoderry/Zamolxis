import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as readline from 'node:readline';
import type { Channel, ChannelHandler, OutboundMessage } from './types.js';
import { requireEnv } from './util.js';
import { logger } from '../logger.js';

/**
 * Signal channel via `signal-cli` in JSON-RPC daemon mode. Requires signal-cli
 * installed and a registered/linked number. Set SIGNAL_NUMBER (e.g. +15551234567)
 * and optionally SIGNAL_CLI_PATH (defaults to "signal-cli" on PATH).
 */
export class SignalChannel implements Channel {
  readonly name = 'signal';
  private proc?: ChildProcessWithoutNullStreams;
  private handler?: ChannelHandler;
  private nextId = 1;
  private readonly number: string;
  private readonly bin: string;

  constructor() {
    this.number = requireEnv('SIGNAL_NUMBER', 'signal');
    this.bin = process.env.SIGNAL_CLI_PATH || 'signal-cli';
  }

  async start(handler: ChannelHandler): Promise<void> {
    this.handler = handler;
    const proc = spawn(this.bin, ['-a', this.number, 'jsonRpc'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    proc.stderr.on('data', (d: Buffer) => logger.debug({ signal: d.toString().trim() }, 'signal-cli'));
    proc.on('exit', (code) => logger.warn({ code }, 'signal-cli exited'));

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => void this.onLine(line));
    logger.info('signal online (json-rpc)');
  }

  private async onLine(line: string): Promise<void> {
    let obj: { method?: string; params?: { envelope?: { sourceNumber?: string; sourceName?: string; dataMessage?: { message?: string } } } };
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    if (obj.method !== 'receive' || !obj.params?.envelope) return;
    const env = obj.params.envelope;
    const text = env.dataMessage?.message;
    const from = env.sourceNumber;
    if (!text || !from) return;
    try {
      const reply = await this.handler!({ channel: this.name, chatId: from, from: env.sourceName, text });
      await this.send({ chatId: from, text: reply });
    } catch (err) {
      logger.error({ err: String(err) }, 'signal handler error');
    }
  }

  async send(msg: OutboundMessage): Promise<void> {
    const req = { jsonrpc: '2.0', id: this.nextId++, method: 'send', params: { recipient: [msg.chatId], message: msg.text } };
    this.proc?.stdin.write(JSON.stringify(req) + '\n');
  }

  async stop(): Promise<void> {
    this.proc?.kill();
  }
}
