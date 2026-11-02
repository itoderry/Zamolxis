/**
 * Obsidian-style memory vault.
 *
 * Zamolxis keeps its curated memory as a handful of bounded markdown files
 * (USER.md, MEMORY.md, per-agent notes, SOUL/LAWS/LEARNINGS). This module
 * materializes that memory into a proper Obsidian vault: a folder of atomic,
 * wiki-linked notes the user can open directly in Obsidian to browse, search,
 * and see the graph of what the assistant knows.
 *
 * The vault is a GENERATED VIEW. `sync()` rewrites only the folders it owns
 * (Home.md, Profile/, Memory/, Agents/, System/) so any notes the user adds in
 * Obsidian elsewhere in the vault are left untouched. Editing memory still
 * happens through the memory tool / the memory files; the vault reflects it.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { MemoryManager } from './memory.js';

/** A note as surfaced to the UI. */
export interface VaultNote {
  title: string;
  rel: string; // path relative to the vault root, e.g. "Profile/01 email.md"
  section: string; // Home | Profile | Memory | Agents | System
}

const MANAGED = ['Home.md', 'Profile', 'Memory', 'Agents', 'System'];

export class MemoryVault {
  readonly dir: string;
  constructor(
    dataDir: string,
    private readonly mem: MemoryManager,
    private readonly agentNames: () => string[] = () => [],
  ) {
    this.dir = path.join(dataDir, 'vault');
  }

  // ── Title / filename helpers ───────────────────────────────────────────────
  /** Strip characters Obsidian/Windows forbid in a note name (must match filename + wiki-link). */
  private safe(s: string): string {
    return s
      .replace(/[[\]#^|\\/:*?"<>]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  /** A human note title from an entry (first line, trimmed, no wiki-hostile chars). */
  private titleOf(entry: string, n: number): string {
    const first = this.safe((entry.split('\n')[0] || entry).trim());
    const short = first.length > 56 ? first.slice(0, 56).trim() + '...' : first;
    const nn = String(n).padStart(2, '0');
    return `${nn} ${short || 'note'}`;
  }
  private wl(title: string): string {
    return `[[${title}]]`;
  }
  private write(rel: string, content: string): void {
    const abs = path.join(this.dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  /** Remove the managed folders/files before a regeneration (leaves user notes alone). */
  private wipeManaged(): void {
    for (const m of MANAGED) {
      const abs = path.join(this.dir, m);
      try {
        fs.rmSync(abs, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }

  /** Regenerate the vault from the current memory state. */
  sync(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    this.ensureObsidianConfig();
    this.wipeManaged();

    const agents = this.agentNames();
    const agentTitle = (a: string) => `Agent - ${this.safe(a)}`;
    const agentTitles = agents.map(agentTitle);

    // Cross-linking: inside any entry body, mention of an agent's name becomes a [[Agent - name]] link.
    const linkAgents = (body: string): string => {
      let out = body;
      for (const a of agents) {
        const re = new RegExp(`(?<![\\w\\[])(${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?![\\w\\]])`, 'gi');
        out = out.replace(re, `[[${agentTitle(a)}|$1]]`);
      }
      return out;
    };

    // ── Profile (USER.md entries) → atomic notes ──
    const profile = this.mem.userList();
    const profileTitles: string[] = [];
    profile.forEach((e, i) => {
      const title = this.titleOf(e, i + 1);
      profileTitles.push(title);
      this.write(
        `Profile/${title}.md`,
        `---\nsource: USER.md\nscope: profile\n---\n\n${linkAgents(e)}\n\n---\n${this.wl('User Profile')} · ${this.wl('Home')}\n`,
      );
    });
    this.write(
      'Profile/User Profile.md',
      `# User Profile\n\nDurable facts the assistant curates about the user (from USER.md).\n\n` +
        (profileTitles.length ? profileTitles.map((t) => `- ${this.wl(t)}`).join('\n') : '_(empty)_') +
        `\n\n---\n${this.wl('Home')}\n`,
    );

    // ── Working memory (MEMORY.md entries) → atomic notes ──
    const mem = this.mem.list();
    const memTitles: string[] = [];
    mem.forEach((e, i) => {
      const title = this.titleOf(e, i + 1);
      memTitles.push(title);
      this.write(
        `Memory/${title}.md`,
        `---\nsource: MEMORY.md\nscope: memory\n---\n\n${linkAgents(e)}\n\n---\n${this.wl('Working Memory')} · ${this.wl('Home')}\n`,
      );
    });
    this.write(
      'Memory/Working Memory.md',
      `# Working Memory\n\nThe assistant's own ongoing notes for the main chat (from MEMORY.md).\n\n` +
        (memTitles.length ? memTitles.map((t) => `- ${this.wl(t)}`).join('\n') : '_(empty)_') +
        `\n\n---\n${this.wl('Home')}\n`,
    );

    // ── Per-agent working memory ──
    agents.forEach((a) => {
      const entries = this.mem.list(a);
      const body = entries.length ? entries.map((e) => `- ${linkAgents(e)}`).join('\n') : '_(no notes yet)_';
      const title = agentTitle(a);
      this.write(
        `Agents/${title}.md`,
        `---\nsource: agent-memory/${a}\nscope: agent\nagent: ${a}\n---\n\n# ${title}\n\nPrivate working memory for the **${a}** agent.\n\n${body}\n\n---\n${this.wl('Home')}\n`,
      );
    });

    // ── System notes (single-file narrative content) ──
    const soul = this.mem.getSoul().trim();
    const laws = this.mem.getLaws().trim();
    const learnings = this.mem.getLearnings().trim();
    this.write('System/Persona.md', `${soul || '# Persona\n\n_(none)_'}\n\n---\n${this.wl('Home')}\n`);
    this.write('System/Laws.md', `${laws || '# Laws\n\n_(none)_'}\n\n---\n${this.wl('Home')}\n`);
    this.write('System/Learnings.md', `${learnings || '# Learnings\n\n_(none)_'}\n\n---\n${this.wl('Home')}\n`);

    // ── Home index ──
    const home =
      `# Zamolxis Memory Vault\n\n` +
      `This is a generated, browsable view of everything Zamolxis remembers. Open the folder in ` +
      `Obsidian to explore the graph. Notes under Profile / Memory / Agents / System are regenerated ` +
      `on each sync; anything else you add here is left untouched.\n\n` +
      `## Sections\n\n` +
      `- ${this.wl('User Profile')} - durable facts about you (${profile.length})\n` +
      `- ${this.wl('Working Memory')} - the assistant's ongoing notes (${mem.length})\n` +
      (agentTitles.length ? agentTitles.map((t) => `- ${this.wl(t)} - agent memory`).join('\n') + '\n' : '') +
      `- ${this.wl('Persona')} · ${this.wl('Laws')} · ${this.wl('Learnings')}\n`;
    this.write('Home.md', home);
  }

  /** A minimal .obsidian config so the folder opens cleanly as a vault (never overwrites the user's). */
  private ensureObsidianConfig(): void {
    const cfgDir = path.join(this.dir, '.obsidian');
    const appJson = path.join(cfgDir, 'app.json');
    if (fs.existsSync(appJson)) return;
    try {
      fs.mkdirSync(cfgDir, { recursive: true });
      fs.writeFileSync(appJson, JSON.stringify({ alwaysUpdateLinks: true, newFileLocation: 'root' }, null, 2), 'utf8');
    } catch {
      /* best-effort */
    }
  }

  /** List every managed note (for the desktop app), grouped by section. */
  list(): VaultNote[] {
    const out: VaultNote[] = [];
    const walk = (rel: string, section: string) => {
      const abs = path.join(this.dir, rel);
      let names: string[] = [];
      try {
        names = fs.readdirSync(abs);
      } catch {
        return;
      }
      for (const n of names.sort()) {
        if (!n.endsWith('.md')) continue;
        out.push({ title: n.replace(/\.md$/, ''), rel: path.posix.join(rel.replace(/\\/g, '/'), n), section });
      }
    };
    if (fs.existsSync(path.join(this.dir, 'Home.md'))) out.push({ title: 'Home', rel: 'Home.md', section: 'Home' });
    walk('Profile', 'Profile');
    walk('Memory', 'Memory');
    walk('Agents', 'Agents');
    walk('System', 'System');
    return out;
  }

  /** Read one note by its vault-relative path (guards against escaping the vault). */
  read(rel: string): string | null {
    const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '');
    if (clean.includes('..')) return null;
    const abs = path.join(this.dir, clean);
    if (!abs.startsWith(this.dir)) return null;
    try {
      return fs.readFileSync(abs, 'utf8');
    } catch {
      return null;
    }
  }

  /** Add a memory entry from the UI, then resync. scope: 'memory' (default) or 'profile'. */
  addNote(text: string, scope: 'memory' | 'profile' = 'memory'): { ok: boolean; message: string } {
    const t = (text || '').trim();
    if (!t) return { ok: false, message: 'Empty note.' };
    const r = scope === 'profile' ? this.mem.addUser(t) : this.mem.add(t);
    if (r.ok) this.sync();
    return r;
  }

  /** Resolve a wiki-link title to a vault-relative path (for click-through in the app). */
  resolve(title: string): string | null {
    const want = title.replace(/\|.*$/, '').trim(); // strip alias
    const hit = this.list().find((n) => n.title === want);
    return hit ? hit.rel : null;
  }

  /** An obsidian:// deep link that opens this vault's Home note if Obsidian is installed. */
  obsidianUri(): string {
    return `obsidian://open?path=${encodeURIComponent(path.join(this.dir, 'Home.md'))}`;
  }
}
