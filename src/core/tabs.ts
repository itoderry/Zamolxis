import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from '../logger.js';
import type { Engine } from './engine.js';

export interface Tab {
  id: string;
  title: string;
  content: string;
  /** If set with refreshSeconds, the agent re-runs this prompt on a timer and the reply becomes the tab content. */
  refreshPrompt?: string;
  refreshSeconds?: number;
  updatedAt: number;
}

const MIN_REFRESH = 30; // seconds — guard against quota-burning tight loops

/**
 * Agent-managed dashboard tabs (skill-like, persistent): the agent creates named
 * tabs and pushes content into them; a tab may carry a prompt + interval so the
 * agent periodically regenerates its content. Rendered as tabs in the web UI.
 */
export class TabsManager {
  private readonly file: string;
  private tabs: Tab[] = [];
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private engine?: Engine;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'tabs.json');
    this.load();
  }

  wire(engine: Engine): void {
    this.engine = engine;
  }

  private load(): void {
    try {
      this.tabs = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Tab[];
    } catch {
      this.tabs = [];
    }
  }
  private persist(): void {
    fs.writeFileSync(this.file, JSON.stringify(this.tabs, null, 2));
  }

  list(): Tab[] {
    return this.tabs.map((t) => ({ ...t }));
  }

  private slug(title: string): string {
    return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || randomUUID().slice(0, 8);
  }
  private find(idOrTitle: string): Tab | undefined {
    const q = idOrTitle.trim().toLowerCase();
    return this.tabs.find((t) => t.id === idOrTitle || t.id === q || t.title.toLowerCase() === q);
  }

  start(): void {
    for (const t of this.tabs) this.arm(t);
    logger.info({ tabs: this.tabs.length, refreshing: this.timers.size }, 'tabs ready');
  }

  private arm(tab: Tab): void {
    this.disarm(tab.id);
    if (!tab.refreshPrompt || !tab.refreshSeconds) return;
    const secs = Math.max(MIN_REFRESH, tab.refreshSeconds);
    this.timers.set(
      tab.id,
      setInterval(() => void this.refresh(tab.id), secs * 1000),
    );
  }
  private disarm(id: string): void {
    const t = this.timers.get(id);
    if (t) clearInterval(t);
    this.timers.delete(id);
  }

  private async refresh(id: string): Promise<void> {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab || !tab.refreshPrompt || !this.engine) return;
    try {
      const r = await this.engine.run({
        conversationKey: `tab:${id}`,
        text: tab.refreshPrompt,
        channel: 'tab',
        chatId: id,
        displayName: `tab:${tab.title}`,
      });
      if (!r.isError) {
        tab.content = r.reply;
        tab.updatedAt = Date.now();
        this.persist();
        logger.info({ id, title: tab.title }, 'tab refreshed');
      }
    } catch (err) {
      logger.warn({ id, err: String(err) }, 'tab refresh failed');
    }
  }

  create(opts: { title: string; content?: string; refreshPrompt?: string; refreshSeconds?: number }): Tab {
    let id = this.slug(opts.title);
    while (this.tabs.some((t) => t.id === id)) id = `${id}-${Math.floor(Math.random() * 1000)}`;
    const tab: Tab = {
      id,
      title: opts.title.trim().slice(0, 60) || id,
      content: opts.content ?? '',
      refreshPrompt: opts.refreshPrompt?.trim() || undefined,
      refreshSeconds: opts.refreshSeconds && opts.refreshSeconds > 0 ? Math.max(MIN_REFRESH, Math.floor(opts.refreshSeconds)) : undefined,
      updatedAt: Date.now(),
    };
    this.tabs.push(tab);
    this.persist();
    this.arm(tab);
    if (tab.refreshPrompt && !tab.content) void this.refresh(tab.id); // populate immediately
    return tab;
  }

  update(idOrTitle: string, patch: { content?: string; title?: string; refreshPrompt?: string; refreshSeconds?: number }): Tab | null {
    const tab = this.find(idOrTitle);
    if (!tab) return null;
    if (typeof patch.content === 'string') tab.content = patch.content;
    if (typeof patch.title === 'string' && patch.title.trim()) tab.title = patch.title.trim().slice(0, 60);
    if (typeof patch.refreshPrompt === 'string') tab.refreshPrompt = patch.refreshPrompt.trim() || undefined;
    if (typeof patch.refreshSeconds === 'number') tab.refreshSeconds = patch.refreshSeconds > 0 ? Math.max(MIN_REFRESH, Math.floor(patch.refreshSeconds)) : undefined;
    tab.updatedAt = Date.now();
    this.persist();
    this.arm(tab);
    return tab;
  }

  remove(idOrTitle: string): boolean {
    const tab = this.find(idOrTitle);
    if (!tab) return false;
    this.disarm(tab.id);
    this.tabs = this.tabs.filter((t) => t.id !== tab.id);
    this.persist();
    return true;
  }

  stop(): void {
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
  }
}
