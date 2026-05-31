import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';

/**
 * Portable "setup pack": bundles the current Zamolxis structure so a NEW install
 * can be seeded from it. ALWAYS includes all skills (including ones the models
 * created over time); optionally includes the persona (SOUL.md), the user profile
 * (USER.md), and the learned facts / teachings (LEARNINGS.md). It's a single JSON
 * file (no zip dependency) — readable and easy to apply on the other end.
 */

export interface PackParts {
  soul?: string;
  user?: string;
  learnings?: string;
}

interface SkillEntry {
  slug: string;
  files: Record<string, string>; // relative path -> text content
}

interface Bundle {
  zamolxis_pack: 1;
  created: string;
  skills: SkillEntry[];
  soul?: string;
  user?: string;
  learnings?: string;
}

function readSkillFiles(skillDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r);
      else {
        try {
          out[r] = fs.readFileSync(abs, 'utf8');
        } catch {
          /* skip unreadable/binary */
        }
      }
    }
  };
  walk(skillDir, '');
  return out;
}

/** Build a pack bundle and write it to <outDir>/zamolxis-pack-<stamp>.json. */
export function packSetup(skillsDir: string, outDir: string, parts: PackParts, stamp: string): { path: string; skills: number; included: string[] } {
  const skills: SkillEntry[] = [];
  try {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const files = readSkillFiles(path.join(skillsDir, entry.name));
      if (Object.keys(files).length) skills.push({ slug: entry.name, files });
    }
  } catch {
    /* no skills dir */
  }
  const bundle: Bundle = { zamolxis_pack: 1, created: stamp, skills };
  const included: string[] = [`${skills.length} skill(s)`];
  if (parts.soul !== undefined) {
    bundle.soul = parts.soul;
    included.push('SOUL.md');
  }
  if (parts.user !== undefined) {
    bundle.user = parts.user;
    included.push('USER.md');
  }
  if (parts.learnings !== undefined) {
    bundle.learnings = parts.learnings;
    included.push('teachings (LEARNINGS.md)');
  }
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `zamolxis-pack-${stamp.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(bundle, null, 2));
  logger.info({ file, skills: skills.length, included }, 'setup packed');
  return { path: file, skills: skills.length, included };
}

/** Apply a pack bundle into a (new) install: writes skills + any included files. */
export function unpackSetup(
  skillsDir: string,
  dataDir: string,
  bundle: Bundle,
): { skills: number; applied: string[] } {
  if (!bundle || bundle.zamolxis_pack !== 1) throw new Error('not a valid Zamolxis pack file');
  const applied: string[] = [];
  fs.mkdirSync(skillsDir, { recursive: true });
  for (const s of bundle.skills ?? []) {
    const dir = path.join(skillsDir, s.slug);
    for (const [rel, content] of Object.entries(s.files)) {
      const dest = path.join(dir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content);
    }
  }
  if ((bundle.skills ?? []).length) applied.push(`${bundle.skills.length} skill(s)`);
  if (typeof bundle.soul === 'string') {
    fs.writeFileSync(path.join(dataDir, 'SOUL.md'), bundle.soul);
    applied.push('SOUL.md');
  }
  if (typeof bundle.user === 'string') {
    fs.writeFileSync(path.join(dataDir, 'USER.md'), bundle.user);
    applied.push('USER.md');
  }
  if (typeof bundle.learnings === 'string') {
    fs.writeFileSync(path.join(dataDir, 'LEARNINGS.md'), bundle.learnings);
    applied.push('teachings (LEARNINGS.md)');
  }
  logger.info({ applied }, 'setup unpacked');
  return { skills: (bundle.skills ?? []).length, applied };
}
