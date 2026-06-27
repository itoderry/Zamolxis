import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';

/** The last result an agent published to its web page (Settings → agent → deliver: Web page). */
export interface AgentPage {
  text: string;
  ts: number;
  via?: string;
}

/**
 * Stores the most recent result per agent so it can be served at a stable URL
 * (http://<host>/<agent-name>). Only agents with "Web page" delivery turned on write here; the
 * page shows whatever that agent produced last — a living dashboard instead of a one-off file.
 */
export class AgentPages {
  private readonly file: string;
  private map: Record<string, AgentPage> = {};

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'agent-pages.json');
    try {
      this.map = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, AgentPage>;
    } catch {
      this.map = {};
    }
  }

  set(name: string, text: string, via?: string): void {
    this.map[name] = { text, ts: Date.now(), via };
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.map, null, 2));
    } catch (err) {
      logger.warn({ err: String(err), name }, 'could not persist agent page');
    }
  }

  get(name: string): AgentPage | undefined {
    return this.map[name];
  }
}
