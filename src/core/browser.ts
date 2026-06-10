import { logger } from '../logger.js';
import { setCanvas } from './canvas.js';

/**
 * Interactive browser control (OpenClaw-style) via playwright-core driving the user's installed
 * Chrome (channel:'chrome' — no separate browser download). One shared, visible browser/page,
 * lazily launched and idle-closed. Exposed as the `browser` tool to BOTH tiers so free/local
 * models can navigate the web too. Screenshots are pushed to the Canvas.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
let browser: any = null;
let page: any = null;
let idleTimer: NodeJS.Timeout | null = null;

function armIdle(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void closeBrowser(), 10 * 60_000);
  idleTimer.unref?.();
}
export async function closeBrowser(): Promise<void> {
  try { if (browser) await browser.close(); } catch { /* */ }
  browser = null; page = null;
}
async function ensurePage(): Promise<any> {
  if (page && !page.isClosed()) { armIdle(); return page; }
  const pw: any = await import('playwright-core');
  if (!browser) {
    browser = await pw.chromium.launch({ channel: 'chrome', headless: false }).catch(async () => pw.chromium.launch({ channel: 'msedge', headless: false }));
  }
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  page = await ctx.newPage();
  armIdle();
  return page;
}

function clip(s: string, n = 6000): string { s = String(s || ''); return s.length > n ? s.slice(0, n) + '\n...[truncated]' : s; }

async function summary(p: any): Promise<string> {
  let title = '', url = '', text = '';
  try { title = await p.title(); } catch { /* */ }
  try { url = p.url(); } catch { /* */ }
  try { text = await p.evaluate('document.body ? document.body.innerText : ""'); } catch { /* */ }
  return `[${title}] ${url}\n\n${clip(text, 3500)}`;
}

async function interactiveSnapshot(p: any): Promise<string> {
  const items: Array<{ i: number; tag: string; label: string }> = await p.evaluate(
    "(() => { const out=[]; const els=Array.from(document.querySelectorAll('a,button,input,textarea,select,[role=button],[role=link]')); let i=0;"
    + " for (const el of els){ const r=el.getBoundingClientRect(); if(r.width<2||r.height<2) continue; const tag=el.tagName.toLowerCase();"
    + " let label=(el.getAttribute('aria-label')||el.innerText||el.getAttribute('placeholder')||el.getAttribute('value')||el.getAttribute('name')||'').trim().replace(/\\s+/g,' ').slice(0,70);"
    + " if(tag==='input'||tag==='textarea'||tag==='select') label='['+(el.type||tag)+'] '+label; if(!label) continue; out.push({i:++i,tag,label}); if(out.length>=60) break; } return out; })()");
  if (!items.length) return 'No interactive elements found. Try the "text" action to read the page.';
  return 'Interactive elements (click/type by their text):\n' + items.map((x) => `- ${x.label}`).join('\n');
}

interface BrowserArgs { action: string; url?: string; text?: string; selector?: string; value?: string; submit?: boolean; key?: string; dy?: number }

export async function browserControl(args: BrowserArgs): Promise<string> {
  const action = String(args.action || '');
  let p: any;
  try { p = await ensurePage(); } catch (e) {
    return 'Browser automation unavailable: ' + String((e as Error)?.message || e) + ' — needs playwright-core and Google Chrome (or Edge) installed.';
  }
  armIdle();
  try {
    if (action === 'goto') {
      let u = String(args.url || ''); if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
      await p.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await p.waitForTimeout(600);
      return await summary(p);
    }
    if (action === 'text') return clip(await p.evaluate('document.body ? document.body.innerText : ""'), 6000);
    if (action === 'snapshot') return await interactiveSnapshot(p);
    if (action === 'click') {
      const loc = args.selector ? p.locator(args.selector) : p.getByText(String(args.text || ''), { exact: false }).first();
      await loc.click({ timeout: 10000 });
      await p.waitForTimeout(700);
      return 'Clicked.\n\n' + await summary(p);
    }
    if (action === 'type') {
      const loc = args.selector ? p.locator(args.selector) : (args.text ? p.getByPlaceholder(String(args.text), { exact: false }).first() : p.locator('input,textarea').first());
      await loc.fill(String(args.value || ''), { timeout: 10000 });
      if (args.submit) { await loc.press('Enter'); await p.waitForTimeout(800); return 'Typed + submitted.\n\n' + await summary(p); }
      return 'Typed into the field.';
    }
    if (action === 'press') { await p.keyboard.press(String(args.key || 'Enter')); await p.waitForTimeout(500); return 'Pressed ' + (args.key || 'Enter') + '.\n\n' + await summary(p); }
    if (action === 'back') { await p.goBack({ waitUntil: 'domcontentloaded' }); return await summary(p); }
    if (action === 'scroll') { await p.mouse.wheel(0, Number(args.dy) || 700); return 'Scrolled.'; }
    if (action === 'screenshot') {
      const buf: Buffer = await p.screenshot({ type: 'png' });
      let title = 'Browser'; try { title = 'Browser — ' + (await p.title()); } catch { /* */ }
      setCanvas('<body style="margin:0;background:#222;display:grid;place-items:center"><img style="max-width:100%;height:auto" src="data:image/png;base64,' + buf.toString('base64') + '"></body>', title);
      return 'Screenshot captured and shown on the Canvas.';
    }
    if (action === 'close') { await closeBrowser(); return 'Browser closed.'; }
    return 'Unknown browser action. Use: goto, text, snapshot, click, type, press, scroll, back, screenshot, close.';
  } catch (e) {
    logger.warn({ err: String(e), action }, 'browser action failed');
    return 'Browser action "' + action + '" failed: ' + String((e as Error)?.message || e);
  }
}
