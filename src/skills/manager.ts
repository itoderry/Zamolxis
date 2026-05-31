import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';

export interface SkillDetail {
  name: string;
  description: string;
  body: string;
  enabled: boolean;
  source: 'own' | 'external';
  file: string; // absolute path to the SKILL.md (so any tier can read the full body)
  category?: string; // for external skills: the top-level folder under the root (e.g. "finance")
}

/**
 * Skills store. Zamolxis writes its own skills as `<skillsDir>/<slug>/SKILL.md` (flat). It ALSO
 * discovers skills from EXTRA roots (e.g. a Hermes install's `skills/` tree) — these use the same
 * SKILL.md format (frontmatter name/description + markdown body) but are nested in category folders,
 * so we scan them recursively and treat them as read-only. Because external libraries can be huge,
 * the engine injects only the skills RELEVANT to each request (see `relevant()`), not the whole list.
 */
export class SkillsManager {
  private readonly extraDirs: string[];

  constructor(
    private readonly skillsDir: string,
    extraDirs: string[] = [],
  ) {
    fs.mkdirSync(this.skillsDir, { recursive: true });
    this.extraDirs = extraDirs.filter((d) => {
      try {
        return fs.existsSync(d);
      } catch {
        return false;
      }
    });
    if (this.extraDirs.length) logger.info({ extraDirs: this.extraDirs }, 'external skill roots registered (e.g. Hermes)');
  }

  private slug(name: string): string {
    return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  }

  /** Create or overwrite an OWN skill. Returns the created slug. */
  write(name: string, description: string, body: string): string {
    const slug = this.slug(name);
    if (!slug) throw new Error('invalid skill name');
    const dir = path.join(this.skillsDir, slug);
    fs.mkdirSync(dir, { recursive: true });
    const frontmatter = `---\nname: ${slug}\ndescription: ${description.replace(/\n/g, ' ').trim()}\n---\n\n`;
    fs.writeFileSync(path.join(dir, 'SKILL.md'), frontmatter + body.trim() + '\n');
    logger.info({ slug }, 'skill written');
    return slug;
  }

  private disabledMarker(slug: string): string {
    return path.join(this.skillsDir, slug, '.disabled');
  }

  /** Seed bundled skills (skills-seed/<slug>/SKILL.md) into the live dir, once per slug. */
  seedFrom(seedDir: string): number {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(seedDir);
    } catch {
      return 0;
    }
    const marker = path.join(this.skillsDir, '.seeded');
    const seen = new Set<string>();
    try {
      for (const s of JSON.parse(fs.readFileSync(marker, 'utf8')) as string[]) seen.add(s);
    } catch {
      /* first run */
    }
    let copied = 0;
    for (const slug of entries) {
      const src = path.join(seedDir, slug, 'SKILL.md');
      if (!fs.existsSync(src)) continue;
      if (seen.has(slug)) continue;
      seen.add(slug);
      const destDir = path.join(this.skillsDir, slug);
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
        fs.copyFileSync(src, path.join(destDir, 'SKILL.md'));
        copied++;
      }
    }
    try {
      fs.writeFileSync(marker, JSON.stringify([...seen]));
    } catch {
      /* best-effort */
    }
    if (copied) logger.info({ copied }, 'seeded bundled skills');
    return copied;
  }

  private parse(file: string, fallbackName: string): { name: string; description: string; body: string } | null {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
    const nameM = /^name:\s*(.+)$/m.exec(text);
    const name = this.slug(nameM?.[1]?.trim() || fallbackName) || fallbackName;
    const description = /^description:\s*([\s\S]*?)\s*$/m.exec(text)?.[1]?.replace(/\n/g, ' ').trim() ?? '';
    const body = text.replace(/^---[\s\S]*?---\s*/, '').trim();
    return { name, description, body };
  }

  /** Recursively collect SKILL.md files under a root (bounded), depth-first. */
  private scanExternal(root: string, max = 400): SkillDetail[] {
    const out: SkillDetail[] = [];
    const walk = (dir: string, depth: number): void => {
      if (out.length >= max || depth > 4) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      const skillFile = path.join(dir, 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        const p = this.parse(skillFile, path.basename(dir));
        if (p && p.description) {
          const category = path.relative(root, dir).split(path.sep)[0] || path.basename(root);
          out.push({ ...p, enabled: true, source: 'external', file: skillFile, category });
        }
      }
      for (const e of entries) {
        if (out.length >= max) break;
        if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(path.join(dir, e.name), depth + 1);
      }
    };
    walk(root, 0);
    return out;
  }

  list(): Array<{ name: string; description: string }> {
    return this.detailsAll()
      .filter((s) => s.enabled)
      .map((s) => ({ name: s.name, description: s.description }));
  }

  /** Every discoverable skill (own flat + external nested), deduped by name (own wins). */
  detailsAll(): SkillDetail[] {
    const out: SkillDetail[] = [];
    const seen = new Set<string>();
    // Own skills (flat).
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(this.skillsDir, entry.name, 'SKILL.md');
      const p = this.parse(file, entry.name);
      if (!p) continue;
      seen.add(p.name);
      out.push({ ...p, enabled: !fs.existsSync(this.disabledMarker(entry.name)), source: 'own', file });
    }
    // External skills (nested), e.g. Hermes — own skills of the same name win.
    for (const root of this.extraDirs) {
      for (const s of this.scanExternal(root)) {
        if (seen.has(s.name)) continue;
        seen.add(s.name);
        out.push(s);
      }
    }
    return out;
  }

  /** Skills most RELEVANT to a request (term overlap on name+description). Empty query → first N. */
  relevant(query: string, limit = 8): Array<{ name: string; description: string }> {
    const all = this.list();
    const terms = (query ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2);
    if (!terms.length) return all.slice(0, limit);
    const scored = all
      .map((s) => {
        const name = s.name.toLowerCase();
        const hay = `${name} ${s.description.toLowerCase()}`;
        let score = 0;
        for (const t of terms) {
          if (name.includes(t)) score += 3;
          else if (hay.includes(t)) score += 1;
        }
        return { s, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((x) => x.s);
  }

  /** Copy an EXTERNAL (e.g. Hermes) skill into the own dir so it becomes a first-class,
   *  editable, packable skill. Returns true if found and imported. */
  importSkill(name: string): boolean {
    const want = this.slug(name);
    const ext = this.detailsAll().find((s) => s.source === 'external' && s.name === want);
    if (!ext) return false;
    this.write(ext.name, ext.description, ext.body);
    logger.info({ name: ext.name, from: ext.file }, 'imported external skill into own dir');
    return true;
  }

  /** Import several external skills at once (one scan). Returns how many were imported. */
  importMany(names: string[]): number {
    const wanted = new Set(names.map((n) => this.slug(n)));
    const ext = this.detailsAll().filter((s) => s.source === 'external' && wanted.has(s.name));
    let n = 0;
    for (const s of ext) {
      this.write(s.name, s.description, s.body);
      n++;
    }
    if (n) logger.info({ count: n }, 'imported external skills (bulk)');
    return n;
  }

  /** Delete an OWN skill folder. */
  remove(slug: string): boolean {
    const dir = path.join(this.skillsDir, this.slug(slug));
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    logger.info({ slug }, 'skill removed');
    return true;
  }

  /** Enable/disable an OWN skill (toggles a `.disabled` marker). */
  setEnabled(slug: string, enabled: boolean): boolean {
    const s = this.slug(slug);
    const dir = path.join(this.skillsDir, s);
    if (!fs.existsSync(dir)) return false;
    const marker = this.disabledMarker(s);
    if (enabled) {
      try {
        fs.rmSync(marker, { force: true });
      } catch {
        /* already enabled */
      }
    } else {
      fs.writeFileSync(marker, 'disabled');
    }
    logger.info({ slug: s, enabled }, 'skill enabled state changed');
    return true;
  }
}
