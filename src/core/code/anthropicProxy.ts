import type http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { providerById, recordProviderUse } from '../providers.js';
import { logger } from '../../logger.js';

/**
 * Anthropic Messages API -> OpenAI chat/completions translator.
 *
 * Claude Code only speaks the Anthropic API. To let it run on a free OpenAI-compatible provider
 * (Groq, Cerebras, Gemini, ...), the "free" code backend points ANTHROPIC_BASE_URL at
 * http://127.0.0.1:<port>/anthropic/<providerId>, and this module answers there:
 *
 *   POST /anthropic/<providerId>/v1/messages               -> provider /chat/completions
 *   POST /anthropic/<providerId>/v1/messages/count_tokens  -> local estimate
 *
 * The provider is always called NON-streaming; when Claude Code asked for `stream: true` the full
 * answer is replayed as a valid Anthropic SSE event sequence. That is simpler and more robust than
 * translating each provider's streaming quirks. Only loopback callers presenting the per-process
 * secret are served, so the route can't be used to spend the user's provider keys from elsewhere.
 */

// ── Minimal Anthropic shapes (only the fields we map) ──

export interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | AnthropicBlock[];
  is_error?: boolean;
  source?: { type: string; media_type?: string; data?: string; url?: string };
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: unknown;
  type?: string;
}

export interface AnthropicRequest {
  model?: string;
  system?: string | Array<{ type: string; text?: string }>;
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  tool_choice?: { type: string; name?: string; disable_parallel_tool_use?: boolean };
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
}

export interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicBlock[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number };
}

/** The OpenAI-side message shape we build. */
type OpenAIMessage = Record<string, unknown>;

interface OpenAIChoice {
  finish_reason?: string | null;
  message?: {
    content?: string | null | Array<{ type?: string; text?: string }>;
    tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string | Record<string, unknown> } }>;
  };
}

export interface OpenAIResponse {
  id?: string;
  choices?: OpenAIChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Default ceiling for max_tokens: Claude Code asks for 32k+, which many free providers reject. */
const DEFAULT_MAX_TOKENS_CAP = Number(process.env.ZAMOLXIS_PROXY_MAX_TOKENS) || 16_384;

const rid = (prefix: string): string => `${prefix}_${randomBytes(12).toString('hex')}`;

/** Text of a tool_result's content (string or blocks); images become a placeholder. */
function flattenToolResult(content: AnthropicBlock['content']): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  return content
    .map((b) => (b.type === 'text' ? b.text ?? '' : b.type === 'image' ? '[image omitted]' : ''))
    .filter(Boolean)
    .join('\n');
}

/** Anthropic image source -> OpenAI image_url part. */
function imagePart(b: AnthropicBlock): Record<string, unknown> | null {
  const s = b.source;
  if (!s) return null;
  if (s.type === 'base64' && s.data) return { type: 'image_url', image_url: { url: `data:${s.media_type || 'image/png'};base64,${s.data}` } };
  if (s.type === 'url' && s.url) return { type: 'image_url', image_url: { url: s.url } };
  return null;
}

/** Drop JSON-schema keys some OpenAI-compatible providers refuse (e.g. "$schema"). */
function cleanSchema(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(cleanSchema);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (k !== '$schema') out[k] = cleanSchema(x);
    return out;
  }
  return v;
}

/** Map an Anthropic Messages request to an OpenAI chat/completions body (always non-streaming). */
export function toOpenAIRequest(body: AnthropicRequest, model: string, opts?: { maxTokensCap?: number }): Record<string, unknown> {
  const messages: OpenAIMessage[] = [];
  const system = typeof body.system === 'string' ? body.system : (body.system ?? []).map((b) => b.text ?? '').filter(Boolean).join('\n\n');
  if (system) messages.push({ role: 'system', content: system });

  for (const m of body.messages ?? []) {
    if (typeof m.content === 'string') {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
      const calls = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id || rid('call'), type: 'function', function: { name: b.name ?? '', arguments: JSON.stringify(b.input ?? {}) } }));
      if (!text && !calls.length) continue; // e.g. only thinking blocks: nothing the provider can use
      // A tool-call-only turn carries content null (several OpenAI-compatible providers reject "").
      messages.push(calls.length ? { role: 'assistant', content: text || null, tool_calls: calls } : { role: 'assistant', content: text });
      continue;
    }
    // user: tool results become `tool` messages, which must directly follow the assistant's tool_calls,
    // so they go first; any text/images in the same turn follow as one user message.
    for (const b of blocks) {
      if (b.type !== 'tool_result') continue;
      const out = flattenToolResult(b.content);
      messages.push({ role: 'tool', tool_call_id: b.tool_use_id ?? '', content: b.is_error ? `Error: ${out}` : out || '(empty)' });
    }
    const parts: Array<Record<string, unknown>> = [];
    for (const b of blocks) {
      if (b.type === 'text' && b.text) parts.push({ type: 'text', text: b.text });
      else if (b.type === 'image') {
        const p = imagePart(b);
        if (p) parts.push(p);
      }
    }
    if (parts.length) {
      const textOnly = parts.every((p) => p.type === 'text');
      messages.push({ role: 'user', content: textOnly ? parts.map((p) => p.text as string).join('\n') : parts });
    }
  }

  const out: Record<string, unknown> = { model, messages, stream: false };
  // Client tools only (server tools such as web_search_2025xxxx carry no input_schema).
  const tools = (body.tools ?? []).filter((t) => t && t.name && t.input_schema);
  if (tools.length) {
    out.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: cleanSchema(t.input_schema) } }));
    const tc = body.tool_choice;
    if (tc?.type === 'any') out.tool_choice = 'required';
    else if (tc?.type === 'tool' && tc.name) out.tool_choice = { type: 'function', function: { name: tc.name } };
    else if (tc?.type === 'none') out.tool_choice = 'none';
    else if (tc?.type === 'auto') out.tool_choice = 'auto';
    if (tc?.disable_parallel_tool_use) out.parallel_tool_calls = false;
  }
  const cap = opts?.maxTokensCap ?? DEFAULT_MAX_TOKENS_CAP;
  if (typeof body.max_tokens === 'number' && body.max_tokens > 0) out.max_tokens = cap > 0 ? Math.min(body.max_tokens, cap) : body.max_tokens;
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences.slice(0, 4);
  return out;
}

/** OpenAI finish_reason -> Anthropic stop_reason. A reply carrying tool calls is always tool_use. */
export function mapFinishReason(reason: string | null | undefined, hasToolCalls: boolean): string {
  if (hasToolCalls) return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_use';
  if (reason === 'content_filter') return 'refusal';
  return 'end_turn';
}

/** Parse tool-call arguments (string or object); malformed JSON becomes {}. */
function parseArgs(a: string | Record<string, unknown> | undefined): Record<string, unknown> {
  if (!a) return {};
  if (typeof a === 'object') return a;
  try {
    const v = JSON.parse(a) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Map an OpenAI chat/completions response back to an Anthropic message. */
export function fromOpenAIResponse(data: OpenAIResponse, model: string): AnthropicResponse {
  const choice = data.choices?.[0];
  const msg = choice?.message;
  const content: AnthropicBlock[] = [];
  const raw = msg?.content;
  const text = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map((p) => p.text ?? '').join('') : '';
  if (text) content.push({ type: 'text', text });
  const calls = msg?.tool_calls ?? [];
  for (const tc of calls) {
    if (!tc.function?.name) continue;
    content.push({ type: 'tool_use', id: tc.id || rid('toolu'), name: tc.function.name, input: parseArgs(tc.function.arguments) });
  }
  const hasTools = content.some((b) => b.type === 'tool_use');
  if (!content.length) content.push({ type: 'text', text: '' });
  return {
    id: rid('msg'),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapFinishReason(choice?.finish_reason, hasTools),
    stop_sequence: null,
    usage: {
      input_tokens: data.usage?.prompt_tokens ?? 0,
      output_tokens: data.usage?.completion_tokens ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

/** Replay a complete message as the Anthropic streaming event sequence. */
export function sseEvents(msg: AnthropicResponse): Array<{ event: string; data: Record<string, unknown> }> {
  const ev: Array<{ event: string; data: Record<string, unknown> }> = [];
  ev.push({
    event: 'message_start',
    data: {
      type: 'message_start',
      message: { ...msg, content: [], stop_reason: null, stop_sequence: null, usage: { ...msg.usage, output_tokens: 0 } },
    },
  });
  msg.content.forEach((b, index) => {
    if (b.type === 'tool_use') {
      ev.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } } });
      ev.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input ?? {}) } } });
    } else {
      ev.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } } });
      if (b.text) ev.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } } });
    }
    ev.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
  });
  ev.push({ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: msg.stop_reason, stop_sequence: msg.stop_sequence }, usage: { output_tokens: msg.usage.output_tokens } } });
  ev.push({ event: 'message_stop', data: { type: 'message_stop' } });
  return ev;
}

/** Serialize events in the SSE wire format. */
export function toSse(events: Array<{ event: string; data: Record<string, unknown> }>): string {
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
}

/** Rough token estimate for count_tokens (about 4 characters per token). */
export function estimateTokens(body: Partial<AnthropicRequest>): number {
  const chars = JSON.stringify(body.system ?? '').length + JSON.stringify(body.messages ?? []).length + JSON.stringify(body.tools ?? []).length;
  return Math.max(1, Math.ceil(chars / 4));
}

/** Anthropic-shaped error for a provider/HTTP status, so Claude Code retries or fails cleanly. */
export function anthropicError(status: number, message: string): { status: number; body: Record<string, unknown> } {
  let type = 'api_error';
  let code = status;
  if (status === 400 || status === 404 || status === 413 || status === 422) { type = status === 404 ? 'not_found_error' : status === 413 ? 'request_too_large' : 'invalid_request_error'; code = status === 422 ? 400 : status; }
  else if (status === 401) type = 'authentication_error';
  else if (status === 403) type = 'permission_error';
  else if (status === 429) type = 'rate_limit_error';
  else if (status === 503 || status === 529) { type = 'overloaded_error'; code = 529; }
  else if (status >= 500) { type = 'api_error'; code = 500; }
  return { status: code, body: { type: 'error', error: { type, message } } };
}

export function isLoopback(addr: string | undefined): boolean {
  const a = (addr || '').toLowerCase();
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1' || a.startsWith('127.');
}

function secretOk(req: http.IncomingMessage, secret: string): boolean {
  const xk = req.headers['x-api-key'];
  const auth = req.headers.authorization;
  const got = typeof xk === 'string' ? xk : typeof auth === 'string' && /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '') : '';
  const a = Buffer.from(got);
  const b = Buffer.from(secret);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export interface ProxyProvider {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface ProxyOptions {
  secret: string;
  /** Resolve a provider id to its endpoint; defaults to the built-in provider list + env keys. */
  resolveProvider?: (id: string) => ProxyProvider | null;
  /** Called after a successful provider call (defaults to the daily-usage counter). */
  recordUse?: (id: string) => void;
  /** Provider call timeout (default 10 minutes). */
  timeoutMs?: number;
}

function defaultResolve(id: string): ProxyProvider | null {
  const p = providerById(id);
  if (!p) return null;
  const key = process.env[p.envKey];
  return key ? { baseUrl: p.baseUrl, model: p.model, apiKey: key } : null;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  const e = anthropicError(status, message);
  sendJson(res, e.status, e.body);
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Is this a Claude model id (which a free provider can't serve, so its default model is used)? */
function looksClaude(m?: string): boolean {
  const x = (m || '').toLowerCase();
  return !x || x.startsWith('claude') || /opus|sonnet|haiku|fable/.test(x);
}

/**
 * Serve one request under /anthropic/. The caller (web channel) routes every path with that prefix
 * here, before its own auth check: this route has its own (loopback + secret).
 */
export async function handleAnthropicProxy(req: http.IncomingMessage, res: http.ServerResponse, opts: ProxyOptions): Promise<void> {
  try {
    if (!isLoopback(req.socket.remoteAddress)) return sendError(res, 403, 'The Zamolxis translator only serves this machine.');
    if (!secretOk(req, opts.secret)) return sendError(res, 401, 'Invalid or missing translator key.');
    const url = new URL(req.url ?? '/', 'http://x');
    const m = /^\/anthropic\/([^/]+)\/v1\/messages(\/count_tokens)?\/?$/.exec(url.pathname);
    if (!m) return sendError(res, 404, `Unsupported path ${url.pathname}`);
    if (req.method !== 'POST') return sendError(res, 404, 'Only POST is supported.');
    const providerId = decodeURIComponent(m[1]!);
    let body: AnthropicRequest;
    try {
      body = JSON.parse((await readBody(req, 32 * 1024 * 1024)) || '{}') as AnthropicRequest;
    } catch (err) {
      const tooLarge = String(err).includes('too large');
      return sendError(res, tooLarge ? 413 : 400, tooLarge ? 'Request body is too large.' : 'Request body is not valid JSON.');
    }
    if (m[2]) return sendJson(res, 200, { input_tokens: estimateTokens(body) });

    const provider = (opts.resolveProvider ?? defaultResolve)(providerId);
    if (!provider) return sendError(res, 401, `Provider "${providerId}" is unknown or has no API key configured.`);
    const model = looksClaude(body.model) ? provider.model : body.model!;
    const oaBody = toOpenAIRequest(body, model);
    // Stop the provider call on timeout AND when Claude Code hangs up (run stopped / killed), so a
    // dead worker doesn't keep spending the provider's quota.
    const upstreamAc = new AbortController();
    const upstreamTimer = setTimeout(() => upstreamAc.abort(), opts.timeoutMs ?? 600_000);
    upstreamTimer.unref?.();
    res.on('close', () => {
      if (!res.writableFinished) upstreamAc.abort();
    });
    let upstream: Response;
    try {
      upstream = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
        body: JSON.stringify(oaBody),
        signal: upstreamAc.signal,
      });
    } catch (err) {
      clearTimeout(upstreamTimer);
      if (res.destroyed) return;
      logger.warn({ provider: providerId, err: String(err) }, 'translator: provider unreachable');
      return sendError(res, 529, `Provider ${providerId} is unreachable: ${String(err)}`);
    }
    if (!upstream.ok) {
      const t = await upstream.text().catch(() => '');
      logger.warn({ provider: providerId, status: upstream.status, body: t.slice(0, 300) }, 'translator: provider error');
      return sendError(res, upstream.status, `Provider ${providerId} returned HTTP ${upstream.status}: ${t.slice(0, 500)}`);
    }
    let data: OpenAIResponse;
    try {
      data = (await upstream.json()) as OpenAIResponse;
    } catch {
      return sendError(res, 502, `Provider ${providerId} returned a non-JSON answer.`);
    } finally {
      clearTimeout(upstreamTimer);
    }
    if (!data.choices?.length) return sendError(res, 502, `Provider ${providerId} returned no choices.`);
    (opts.recordUse ?? recordProviderUse)(providerId);
    const msg = fromOpenAIResponse(data, model);
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.end(toSse(sseEvents(msg)));
      return;
    }
    sendJson(res, 200, msg);
  } catch (err) {
    logger.warn({ err: String(err) }, 'translator request failed');
    if (!res.headersSent) sendError(res, 500, 'Translator error: ' + String(err));
    else res.end();
  }
}
