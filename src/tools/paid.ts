import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { UsageTracker } from '../core/usage.js';
import { logger } from '../logger.js';

/** OpenAI-compatible usage block (chat completions + images all return this shape). */
interface ApiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
}
function normalizeUsage(u?: ApiUsage): { prompt: number; completion: number; total: number } {
  const prompt = u?.prompt_tokens ?? u?.input_tokens ?? 0;
  const completion = u?.completion_tokens ?? u?.output_tokens ?? 0;
  const total = u?.total_tokens ?? prompt + completion;
  return { prompt, completion, total };
}

/**
 * Optional, KEY-GATED tools. These cannot be funded by the Claude subscription
 * (there is no Claude image-gen API, and other providers bill separately), so
 * each is registered ONLY when its API key is present. Absent keys → the tool
 * simply doesn't exist, and the agent never sees it.
 */

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

export function buildPaidTools(dataDir: string, usage: UsageTracker): Array<SdkMcpToolDefinition<any>> {
  const tools: Array<SdkMcpToolDefinition<any>> = [];
  const openaiKey = process.env.OPENAI_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;

  // ── Image generation (OpenAI gpt-image-1) ────────────────────────────────
  if (openaiKey) {
    tools.push(
      tool(
        'generate_image',
        'Generate an image from a text prompt (OpenAI gpt-image-1). Saves a PNG to disk and returns its path. NOTE: billed to your OpenAI account, not the Claude subscription.',
        {
          prompt: z.string().describe('What to draw'),
          size: z.enum(['1024x1024', '1536x1024', '1024x1536']).optional(),
        },
        async (args) => {
          try {
            const res = await fetch('https://api.openai.com/v1/images/generations', {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${openaiKey}` },
              body: JSON.stringify({ model: 'gpt-image-1', prompt: args.prompt, size: args.size ?? '1024x1024', n: 1 }),
            });
            if (!res.ok) return text(`Image generation failed: ${res.status} ${await res.text()}`);
            const data = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }>; usage?: ApiUsage };
            usage.record('openai:gpt-image-1', normalizeUsage(data.usage));
            const b64 = data.data?.[0]?.b64_json;
            if (!b64) return text('Image generation returned no data.');
            const dir = path.join(dataDir, 'images');
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, `img_${Date.now()}.png`);
            fs.writeFileSync(file, Buffer.from(b64, 'base64'));
            return text(`Image saved to ${file}`);
          } catch (err) {
            return text(`Image generation error: ${String(err)}`);
          }
        },
      ),
    );
  }

  // ── Cross-provider model router (OpenAI / OpenRouter) ─────────────────────
  if (openaiKey || openrouterKey) {
    const providers = [openaiKey ? 'openai' : null, openrouterKey ? 'openrouter' : null].filter(Boolean).join(', ');
    tools.push(
      tool(
        'ask_external_model',
        `Consult a non-Claude model for a second opinion. Available providers: ${providers}. NOTE: billed to that provider, not the Claude subscription.`,
        {
          provider: z.enum(['openai', 'openrouter']),
          model: z.string().describe('e.g. "gpt-4o" (openai) or "google/gemini-2.0-flash-001" (openrouter)'),
          prompt: z.string(),
        },
        async (args) => {
          const cfg =
            args.provider === 'openai'
              ? { url: 'https://api.openai.com/v1/chat/completions', key: openaiKey }
              : { url: 'https://openrouter.ai/api/v1/chat/completions', key: openrouterKey };
          if (!cfg.key) return text(`Provider ${args.provider} is not configured (missing API key).`);
          try {
            const res = await fetch(cfg.url, {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
              body: JSON.stringify({ model: args.model, messages: [{ role: 'user', content: args.prompt }] }),
            });
            if (!res.ok) return text(`${args.provider} call failed: ${res.status} ${await res.text()}`);
            const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: ApiUsage };
            usage.record(`${args.provider}:${args.model}`, normalizeUsage(data.usage));
            return text(data.choices?.[0]?.message?.content ?? '(no content)');
          } catch (err) {
            return text(`${args.provider} call error: ${String(err)}`);
          }
        },
      ),
    );
  }

  if (tools.length) logger.info({ count: tools.length }, 'paid plugins enabled (key-gated)');
  return tools;
}
