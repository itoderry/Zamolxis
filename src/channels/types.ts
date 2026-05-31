/**
 * Channel abstraction. Every messaging surface (CLI, Telegram, Discord, …)
 * normalizes its traffic to these envelopes so the engine is channel-agnostic.
 */
export interface InboundMessage {
  /** Channel id, e.g. "telegram". */
  channel: string;
  /** Opaque per-channel chat/thread id (DM id, channel id, etc.). */
  chatId: string;
  /** Sender display name, if known. */
  from?: string;
  /** Message text. */
  text: string;
  /** Optional per-message routing override: 'local' | 'claude' | 'freecloud' | a provider id; default follows config. */
  route?: string;
  /** Optional per-message Claude model override (alias 'opus'|'sonnet'|'haiku'); default follows config. */
  model?: string;
}

export interface OutboundMessage {
  chatId: string;
  text: string;
}

export interface Channel {
  readonly name: string;
  /**
   * Start the channel. `onMessage` is called for each inbound message; its
   * resolved string is the reply to send back (the manager handles delivery,
   * but channels may also use `send` directly for streaming/proactive sends).
   */
  start(handler: ChannelHandler): Promise<void>;
  /** Send a message proactively (used by the scheduler and streaming). */
  send(msg: OutboundMessage): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Handles one inbound message and resolves with the full reply. Channels that
 * support live output (e.g. the web UI) may pass `onProgress` to receive
 * streamed assistant text chunks as they arrive.
 */
export type ChannelHandler = (msg: InboundMessage, onProgress?: (chunk: string) => void) => Promise<string>;

/** Build a stable conversation key from an inbound message. */
export function conversationKey(msg: InboundMessage): string {
  return `${msg.channel}:${msg.chatId}`;
}
