/**
 * TokenJuice - tool-output compression.
 *
 * Large tool results (a 200KB HTTP body, a noisy shell dump, a giant search page)
 * waste the model's context and cost tokens. This caps oversized outputs to a
 * configurable size BEFORE they reach the model, while writing the FULL output to
 * disk so nothing is ever lost - the truncation note points the model (and the user)
 * at the saved file. A head + tail slice is kept (errors and summaries often live at
 * the very end of a dump, so a plain head-only truncation would drop them).
 *
 * The cap is a process-wide global set from config/settings via `setToolOutputCap`.
 * A cap of 0 (or less) disables capping entirely.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DIR = path.join(os.homedir(), '.zamolxis', 'tooljuice');

let CAP = 12000;
let seq = 0;

/** Configure the global cap (chars). <= 0 disables compression. */
export function setToolOutputCap(chars: number): void {
  if (Number.isFinite(chars)) CAP = Math.max(0, Math.floor(chars));
}

/** Current cap in chars (0 = disabled). */
export function toolOutputCap(): number {
  return CAP;
}

/**
 * Cap a single string. Returns it unchanged when under the cap or capping is off.
 * When it must truncate, the full text is saved to ~/.zamolxis/tooljuice/ and a note
 * is spliced between the kept head and tail.
 */
export function compressText(input: string, opts: { cap?: number; toolName?: string } = {}): string {
  const cap = opts.cap ?? CAP;
  if (!input || cap <= 0 || input.length <= cap) return input;

  let savedPath = '';
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const safe = (opts.toolName || 'tool').replace(/[^a-z0-9_-]/gi, '_').slice(0, 40);
    const id = `${safe}-${Date.now().toString(36)}-${process.pid}-${++seq}`;
    savedPath = path.join(DIR, `${id}.txt`);
    fs.writeFileSync(savedPath, input, 'utf8');
  } catch {
    savedPath = '';
  }

  // Keep a generous head and a smaller tail; the middle is what gets dropped.
  const budget = Math.max(200, cap - 160); // leave room for the note itself
  const headLen = Math.floor(budget * 0.7);
  const tailLen = budget - headLen;
  const head = input.slice(0, headLen);
  const tail = input.slice(input.length - tailLen);
  const omitted = input.length - headLen - tailLen;
  const note =
    `\n\n... [TokenJuice: truncated - ${input.length} chars total, ${omitted} omitted from the middle` +
    (savedPath ? `. Full output saved to ${savedPath}` : '') +
    `] ...\n\n`;
  return head + note + tail;
}

/**
 * Cap every text part of an MCP tool result ({ content: [{ type: 'text', text }] }).
 * Non-text parts (images, etc.) pass through untouched. Any shape it does not
 * recognize is returned unchanged.
 */
export function compressToolResult<T>(name: string, res: T, cap?: number): T {
  const r = res as unknown as { content?: unknown };
  if (!r || !Array.isArray(r.content)) return res;
  const content = r.content.map((c) => {
    const part = c as { type?: string; text?: unknown };
    if (part && part.type === 'text' && typeof part.text === 'string') {
      return { ...part, text: compressText(part.text, { cap, toolName: name }) };
    }
    return c;
  });
  return { ...(r as object), content } as unknown as T;
}
