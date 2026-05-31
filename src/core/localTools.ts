import { logger } from '../logger.js';

/**
 * Real tools the on-device local model can call (executed by US, not the model):
 *  - http_get  — fetch a URL (public APIs, websites, or the LAN, e.g. Home Assistant)
 *  - web_search — search the web (only offered when a provider API key is set)
 *
 * This is what lets the offline local model actually reach the internet: it emits a
 * tool call, our code performs the request and feeds the result back. A SKILL.md can
 * then name an endpoint and the local model can genuinely fetch it.
 */

const MAX_BODY = 8000;
const TIMEOUT_MS = 12000;

export interface LocalToolset {
  defs: unknown[]; // OpenAI-format tool definitions for the chat-completions API
  names: string[];
  exec(name: string, args: Record<string, unknown>): Promise<string>;
}

async function fetchWithTimeout(url: string, opts: RequestInit, ms: number): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

function searchProvider(): 'tavily' | 'brave' | 'searxng' | 'duckduckgo' {
  if (process.env.TAVILY_API_KEY) return 'tavily';
  if (process.env.BRAVE_API_KEY) return 'brave';
  if (process.env.ZAMOLXIS_SEARXNG_URL) return 'searxng';
  return 'duckduckgo'; // keyless default
}

/** Web search is ALWAYS available — DuckDuckGo needs no key (Tavily/Brave/SearXNG
 *  are optional upgrades). */
export function localSearchAvailable(): boolean {
  return true;
}

/** Which provider is active (for UI display). */
export function searchProviderName(): string {
  return searchProvider();
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
// Non-browser UA for API calls: Wikipedia REST needs a non-empty UA; wttr.in (and other
// curl-friendly services) serve PLAIN TEXT to non-browser clients but HTML to browser UAs.
const API_UA = 'Zamolxis/1.0 (+https://github.com/zamolxis-agent)';

/** Fetch a page and return cleaned main text (best-effort, bounded, never throws). */
async function fetchPageText(url: string, ua: string, maxLen = 2000): Promise<string> {
  try {
    const r = await fetchWithTimeout(url, { headers: { 'User-Agent': ua, Accept: 'text/html' } }, 9000);
    if (!r.ok) return '';
    const ct = r.headers.get('content-type') || '';
    if (!/text|html/i.test(ct)) return '';
    const html = await r.text();
    const text = stripTags(
      html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' '),
    );
    return text.slice(0, maxLen);
  } catch {
    return '';
  }
}

/** Parse DuckDuckGo's HTML results page (no API key needed). */
function parseDuckDuckGo(html: string): Array<{ title: string; url: string; snippet: string }> {
  const out: Array<{ title: string; url: string; snippet: string }> = [];
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) && out.length < 5) {
    let url = m[1]!;
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) {
      try {
        url = decodeURIComponent(uddg[1]!);
      } catch {
        /* keep raw */
      }
    } else if (url.startsWith('//')) {
      url = 'https:' + url;
    }
    out.push({ title: stripTags(m[2]!), url, snippet: '' });
  }
  let s: RegExpExecArray | null;
  let i = 0;
  while ((s = snipRe.exec(html)) && i < out.length) {
    out[i]!.snippet = stripTags(s[1]!).slice(0, 240);
    i++;
  }
  return out;
}

/** Run a web search. Default provider is DuckDuckGo (no key). Optional upgrades:
 *  SearXNG (ZAMOLXIS_SEARXNG_URL), Tavily (TAVILY_API_KEY), Brave (BRAVE_API_KEY).
 *  Reused by the local tool loop AND the Claude-side web_search MCP tool. */
export async function runWebSearch(query: string): Promise<string> {
  const q = String(query ?? '').trim();
  if (!q) return 'Error: empty query';
  const provider = searchProvider();
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
  try {
    if (provider === 'tavily') {
      const r = await fetchWithTimeout(
        'https://api.tavily.com/search',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query: q, max_results: 5, include_answer: true, search_depth: 'advanced' }) },
        TIMEOUT_MS,
      );
      const d = (await r.json()) as { answer?: string; results?: Array<{ title?: string; url?: string; content?: string }> };
      // Tavily returns a synthesized direct answer — put it FIRST so a small model can relay it.
      const ans = d.answer ? `Direct answer: ${d.answer}\n\nSupporting results:\n` : '';
      const items = (d.results ?? []).map((x) => `- ${x.title ?? ''}\n  ${x.url ?? ''}\n  ${(x.content ?? '').slice(0, 300)}`).join('\n');
      return (ans + items).trim() || 'No results.';
    }
    if (provider === 'brave') {
      const r = await fetchWithTimeout(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=5`,
        { headers: { 'X-Subscription-Token': process.env.BRAVE_API_KEY ?? '', Accept: 'application/json' } },
        TIMEOUT_MS,
      );
      const d = (await r.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
      const items = (d.web?.results ?? []).slice(0, 5).map((x) => `- ${x.title ?? ''}\n  ${x.url ?? ''}\n  ${(x.description ?? '').slice(0, 240)}`).join('\n');
      return items || 'No results.';
    }
    if (provider === 'searxng') {
      const base = (process.env.ZAMOLXIS_SEARXNG_URL ?? '').replace(/\/$/, '');
      const r = await fetchWithTimeout(`${base}/search?q=${encodeURIComponent(q)}&format=json`, { headers: { Accept: 'application/json' } }, TIMEOUT_MS);
      const d = (await r.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
      const items = (d.results ?? []).slice(0, 5).map((x) => `- ${x.title ?? ''}\n  ${x.url ?? ''}\n  ${(x.content ?? '').slice(0, 240)}`).join('\n');
      return items || 'No results.';
    }
    // duckduckgo (default, no key) — scrape the HTML results page
    const r = await fetchWithTimeout(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, { headers: { 'User-Agent': ua, Accept: 'text/html' } }, TIMEOUT_MS);
    const html = await r.text();
    const results = parseDuckDuckGo(html);
    if (!results.length) return 'No results (DuckDuckGo returned nothing — it may be rate-limiting; try again, or configure SearXNG/Tavily/Brave).';
    let body = results.map((x) => `- ${x.title}\n  ${x.url}\n  ${x.snippet}`).join('\n');
    // DuckDuckGo snippets are thin — fetch the top result's actual page text so a small
    // model reads real content (e.g. a recap that literally states the score) instead of
    // guessing from a fragment. Best-effort: skip silently if the page blocks/fails.
    const page = await fetchPageText(results[0]!.url, ua);
    if (page) body += `\n\n--- Full text of the top result (${results[0]!.url}) ---\n${page}`;
    return body;
  } catch (err) {
    return `Search error: ${String(err)}`;
  }
}

/** True when a Home Assistant token is configured. */
export function haConfigured(): boolean {
  return !!process.env.ZAMOLXIS_HA_TOKEN;
}

// Genuinely security-sensitive services the agent must NOT do autonomously.
const HA_BLOCKED = new Set(['lock.unlock', 'alarm_control_panel.disarm']);

/** Call a Home Assistant service to control a device (POST /api/services/<domain>/<service>). */
export async function runHaService(domain: string, service: string, entityId: string): Promise<string> {
  const token = process.env.ZAMOLXIS_HA_TOKEN;
  if (!token) return 'Home Assistant is not configured (no token).';
  const base = (process.env.ZAMOLXIS_HA_URL || 'http://homeassistant.local:8123').replace(/\/$/, '');
  domain = String(domain || '').trim();
  service = String(service || '').trim();
  entityId = String(entityId || '').trim();
  if (!domain || !service || !entityId) return 'Provide domain, service, and entity_id (e.g. light, turn_on, light.kitchen).';
  const key = `${domain}.${service}`;
  if (HA_BLOCKED.has(key)) return `For safety, "${key}" is disabled for the agent — please do that yourself in Home Assistant.`;
  try {
    const r = await fetchWithTimeout(
      `${base}/api/services/${domain}/${service}`,
      { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ entity_id: entityId }) },
      TIMEOUT_MS,
    );
    if (!r.ok) return `HA service call failed: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`;
    const d = (await r.json()) as Array<{ entity_id?: string; state?: string }>;
    const changed = Array.isArray(d) && d.length ? d.map((s) => `${s.entity_id}=${s.state}`).join(', ') : 'done';
    return `Called ${key} on ${entityId}. Result: ${changed}`;
  } catch (err) {
    return `HA service error: ${String(err)}`;
  }
}

export function buildLocalTools(): LocalToolset {
  const defs: unknown[] = [];
  const names: string[] = [];

  defs.push({
    type: 'function',
    function: {
      name: 'http_get',
      description:
        'HTTP GET a URL and return the response body (truncated). Works for public JSON APIs, websites, or the local network (e.g. Home Assistant at http://homeassistant.local:8123). Optionally pass headers (e.g. an Authorization token a skill gives you).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL starting with http:// or https://' },
          headers: { type: 'object', description: 'Optional request headers, e.g. {"Authorization":"Bearer <token>"}' },
        },
        required: ['url'],
      },
    },
  });
  names.push('http_get');

  defs.push({
    type: 'function',
    function: {
      name: 'read_url',
      description:
        'Fetch a web PAGE and return its READABLE TEXT (HTML stripped). Use this to actually READ an article/page (e.g. one you found via web_search) — much better than http_get for web pages, which returns raw HTML. For JSON APIs use http_get instead.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Full http(s):// URL of the page to read' } },
        required: ['url'],
      },
    },
  });
  names.push('read_url');

  if (haConfigured()) {
    defs.push({
      type: 'function',
      function: {
        name: 'ha_service',
        description:
          'Control a Home Assistant device by calling a service. Provide domain, service, entity_id — e.g. domain="light" service="turn_on" entity_id="light.kitchen". Common: light/switch/fan turn_on|turn_off, scene turn_on. (Locks and alarm disarm are blocked for safety.)',
        parameters: {
          type: 'object',
          properties: {
            domain: { type: 'string', description: 'e.g. light, switch, fan, scene, climate' },
            service: { type: 'string', description: 'e.g. turn_on, turn_off, toggle' },
            entity_id: { type: 'string', description: 'e.g. light.kitchen' },
          },
          required: ['domain', 'service', 'entity_id'],
        },
      },
    });
    names.push('ha_service');
  }

  const provider = searchProvider();
  if (provider) {
    defs.push({
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the web and return the top results (title, url, snippet). Use when you do not already know the URL to fetch.',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      },
    });
    names.push('web_search');
  }

  async function httpGet(args: Record<string, unknown>): Promise<string> {
    const url = String(args.url ?? '');
    if (!/^https?:\/\//i.test(url)) return 'Error: url must start with http:// or https://';
    const headers = (args.headers && typeof args.headers === 'object' ? (args.headers as Record<string, string>) : {});
    // Default User-Agent + JSON Accept: many public APIs (Wikipedia REST, etc.) block or
    // return HTML to UA-less requests. Caller-provided headers win.
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent')) headers['User-Agent'] = API_UA;
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'accept')) headers['Accept'] = 'application/json, text/plain, */*';
    // Auto-attach Home Assistant auth for the configured HA host, so skills and
    // prompts never need to carry the long-lived token.
    const haToken = process.env.ZAMOLXIS_HA_TOKEN;
    if (haToken && !Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')) {
      try {
        const host = new URL(url).host;
        const haHost = process.env.ZAMOLXIS_HA_URL ? new URL(process.env.ZAMOLXIS_HA_URL).host : '';
        if ((haHost && host === haHost) || /(^|\.)homeassistant\.local(:\d+)?$/i.test(host)) {
          headers['Authorization'] = `Bearer ${haToken}`;
        }
      } catch {
        /* bad url */
      }
    }
    try {
      const r = await fetchWithTimeout(url, { method: 'GET', headers }, TIMEOUT_MS);
      const text = await r.text();
      const body = text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}\n…[truncated ${text.length - MAX_BODY} chars]` : text;
      return `HTTP ${r.status} ${r.statusText}\n${body}`;
    } catch (err) {
      return `Error fetching ${url}: ${String(err)}`;
    }
  }

  return {
    defs,
    names,
    async exec(name, args) {
      logger.info({ tool: name }, 'local tool exec');
      if (name === 'http_get') return httpGet(args);
      if (name === 'web_search') return runWebSearch(String(args.query ?? ''));
      if (name === 'read_url') {
        const url = String(args.url ?? '');
        if (!/^https?:\/\//i.test(url)) return 'Error: url must start with http:// or https://';
        const t = await fetchPageText(url, UA, 6000);
        return t || '(no readable text extracted — the page may be JavaScript-heavy or blocking bots; try http_get, or another source/skill)';
      }
      if (name === 'ha_service') return runHaService(String(args.domain ?? ''), String(args.service ?? ''), String(args.entity_id ?? ''));
      return `Unknown tool: ${name}`;
    },
  };
}
