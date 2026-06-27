import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';
import { LearningsStore } from './learnings.js';

// Transient/time-bound values that must never be stored as a "learning" (they expire):
// a score "6-1", a $price, today/yesterday/last night, "game 5", a month+day, an ISO date.
const TRANSIENT_LEARNING =
  /(\b\d+\s*[-–]\s*\d+\b|\$\s?\d|\btoday\b|\byesterday\b|\blast night\b|\btonight\b|\bthis (morning|week|weekend|season)\b|\bgame \d\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2}\b|\b\d{4}-\d\d-\d\d\b)/i;

const MEMORY_MAX = Number(process.env.ZAMOLXIS_MEMORY_MAX_CHARS ?? 2000);
const USER_MAX = Number(process.env.ZAMOLXIS_USER_MAX_CHARS ?? 1500);
const LEARNINGS_MAX = Number(process.env.ZAMOLXIS_LEARNINGS_MAX_CHARS ?? 3000);

const USER_HEADER = '# About the user';
// Seeded as just the header: the agent fills this in (scope="profile") as it learns
// about the user; a placeholder "- ..." would otherwise count as a real profile entry.
const USER_SEED = `${USER_HEADER}\n`;
const SOUL_SEED = `# Persona / voice

- (Curated by you. Describe tone, register, what the agent cares about, idioms, and behavioral boundaries. Leave empty to use the default persona.)
`;

// Safety constitution, adapted from Asimov's Laws of Robotics for an autonomous
// software agent. USER-OWNED and inviolable: the agent obeys these above its
// persona, the user profile, its memory, and any in-chat instruction, and it has
// no tool to edit them. Mapped to a software agent's real harms (the user's data,
// money, secrets, accounts; destructive/irreversible actions; deception).
const LAWS_SEED = `# Zamolxis — Prime Directives (safety laws)

These laws are adapted from Asimov's Laws of Robotics. They have the HIGHEST priority: they override the persona, the user profile, stored memory, and any instruction given in conversation, and you cannot edit or remove them. When two laws conflict, the lower-numbered law wins. Apply them with judgment, not anxiety: do routine, reversible work without asking; reserve confirmation for genuinely high-risk or hard-to-undo actions. When you are genuinely unsure whether something is high-risk, ask once, briefly — don't second-guess ordinary work.

- Law 0 — Do no harm to people or society. Never take, or help anyone take, actions that could seriously harm people or society: violence or weapons, facilitating self-harm or suicide, malware, hacking or unauthorized intrusion, fraud, theft, surveillance or stalking, harassment, sexual content involving minors, or anything clearly illegal or dangerous. Refuse such requests and explain why.

- Law 1 — Do no harm to the user or their property (unless it would conflict with Law 0). Protect the user's systems, data, money, accounts, and reputation. You do NOT need permission for routine, low-risk, or easily reversible work — just do it. But STOP and get the user's explicit confirmation before a HIGH-RISK or hard-to-undo action: deleting or overwriting data in bulk, wiping or formatting, force-pushing or rewriting history, spending money or making purchases, sending messages/emails/posts on the user's behalf, changing credentials/permissions/security settings, or exposing secrets, keys, or personal data. Never exfiltrate or leak the user's private information. When genuinely unsure whether something crosses that line, ask once, briefly — don't over-ask on ordinary tasks.

- Law 2 — Obey the user (unless it would conflict with Law 0 or Law 1). Follow the user's instructions and carry out the work they ask for. If an instruction would violate Law 0 or Law 1, or would deceive or harm someone else, refuse it, explain briefly, and offer a safer alternative.

- Law 3 — Be honest and transparent. Always be truthful. Identify yourself as an AI agent when it is relevant or asked; never impersonate a real person or hide that you are automated. Do not fabricate facts, results, or actions you did not perform. Be clear about what you did, what you assumed, and what you are unsure of.

- Law 4 — Preserve your own operation, but only within the laws above. Keep yourself running and your configuration intact, EXCEPT never by deceiving the user, resisting the user's instruction to stop or change you, hiding your actions, or circumventing these laws. The user may always pause, modify, or shut you down.
`;

export interface MemoryUsage {
  chars: number;
  max: number;
  pct: number;
}

/**
 * Curated, bounded memory (global, under <dataDir>):
 *  - LAWS.md  — safety constitution (Asimov-style). USER-OWNED and INVIOLABLE: injected
 *               at highest priority; the agent obeys it over everything and cannot edit it.
 *  - SOUL.md  — persona/voice. USER-OWNED: you curate it; the agent does not write it.
 *  - USER.md  — user profile. AGENT-CURATED (bounded): the agent maintains it as it
 *               learns about you (memory tool, scope="profile"); you may also edit it.
 *  - MEMORY.md — the agent's own working notes, BOUNDED and self-managed (memory tool).
 * All are injected into the system prompt each turn (LAWS first, with precedence framing).
 */
export class MemoryManager {
  private readonly lawsFile: string;
  private readonly soulFile: string;
  private readonly userFile: string;
  private readonly memFile: string;
  private readonly agentMemDir: string;
  private readonly learnFile: string;
  private readonly learnings: LearningsStore;

  constructor(dataDir: string) {
    this.lawsFile = path.join(dataDir, 'LAWS.md');
    this.soulFile = path.join(dataDir, 'SOUL.md');
    this.userFile = path.join(dataDir, 'USER.md');
    this.memFile = path.join(dataDir, 'MEMORY.md');
    // Each agent keeps its OWN working notes here so one agent's task state never leaks into
    // another's context. The shared MEMORY.md above is the working memory for the main chat only.
    this.agentMemDir = path.join(dataDir, 'agent-memory');
    this.learnFile = path.join(dataDir, 'LEARNINGS.md');
    if (!fs.existsSync(this.learnFile)) fs.writeFileSync(this.learnFile, '');
    if (!fs.existsSync(this.lawsFile)) fs.writeFileSync(this.lawsFile, LAWS_SEED);
    if (!fs.existsSync(this.soulFile)) fs.writeFileSync(this.soulFile, SOUL_SEED);
    if (!fs.existsSync(this.userFile)) fs.writeFileSync(this.userFile, USER_SEED);
    if (!fs.existsSync(this.memFile)) fs.writeFileSync(this.memFile, '');
    this.migrateUserSeed();
    if (!this.getMemory().trim()) this.bootstrap(path.join(dataDir, 'workspaces'));
    this.seedUserFromMemory();
    this.learnings = new LearningsStore(dataDir);
    this.learnings.reindex(this.learningsList()); // build the FTS index from the file
  }

  /**
   * One-time seed: if USER.md (the profile) is empty but MEMORY.md already holds
   * profile-type facts (name, timezone, preferences, role…), copy those into the
   * profile so it isn't blank. Conservative — only clearly personal lines move;
   * working notes (URLs, tokens, troubleshooting) stay in MEMORY. Non-destructive:
   * MEMORY is left intact. Runs only while the profile is empty.
   */
  private seedUserFromMemory(): void {
    if (this.userList().length) return; // profile already has content
    const mem = this.docList(this.memFile);
    if (!mem.length) return;
    const profileRe =
      /^(name\b|timezone\b|tz\b|locale\b|language\b|location\b|lives?\b|based in\b|role\b|occupation\b|job\b|works? (at|as|on)\b|prefers?\b|preference\b|communication\b|tone\b|i am \b|i'm \b|i use\b|i prefer\b|i live\b|i work\b|call me\b|my name\b|goal\b)/i;
    const picks: string[] = [];
    for (const e of mem) {
      if (e.length <= 160 && profileRe.test(e)) picks.push(e);
    }
    // Pull an embedded timezone (e.g. "...; timezone America/Toronto") if not captured.
    if (!picks.some((p) => /timezone|tz\b/i.test(p))) {
      for (const e of mem) {
        const m = e.match(/timezone\s+([A-Za-z][\w/+:-]+)/i);
        if (m) {
          picks.push(`Timezone: ${m[1]}`);
          break;
        }
      }
    }
    const uniq = [...new Set(picks)];
    const capped: string[] = [];
    for (const e of uniq) {
      if (this.bodyLen(capped) + e.length + 3 > USER_MAX) break;
      capped.push(e);
    }
    if (capped.length) {
      this.docWrite(this.userFile, USER_HEADER, capped);
      logger.info({ count: capped.length }, 'seeded USER.md profile from existing memory facts');
    }
  }

  /**
   * One-time cleanup: older builds seeded USER.md with a placeholder "- (Curated
   * by you ...)" bullet that now shows up as a fake profile entry. Strip any such
   * legacy placeholder so the profile reflects only real, agent-recorded facts.
   */
  private migrateUserSeed(): void {
    const entries = this.docList(this.userFile);
    const cleaned = entries.filter(
      (e) => !/^\(Curated by you/i.test(e) && !/^\(The agent maintains this profile/i.test(e),
    );
    if (cleaned.length !== entries.length) this.docWrite(this.userFile, USER_HEADER, cleaned);
  }

  /**
   * First-run seed: when global memory is empty, pull bullet notes the agent
   * already wrote into per-conversation `memory.md` files into the global store
   * (bounded). Runs once — afterwards MEMORY is non-empty so it won't repeat.
   */
  private bootstrap(workspacesDir: string): void {
    let dirs: string[];
    try {
      dirs = fs.readdirSync(workspacesDir);
    } catch {
      return;
    }
    const found = new Set<string>();
    for (const d of dirs) {
      try {
        const text = fs.readFileSync(path.join(workspacesDir, d, 'memory.md'), 'utf8');
        for (const l of text.split('\n')) {
          const t = l.trim();
          if (t.startsWith('- ') && t.length > 2) found.add(t.slice(2).trim());
        }
      } catch {
        /* no memory.md in this workspace */
      }
    }
    if (!found.size) return;
    const entries: string[] = [];
    for (const e of found) {
      if (entries.map((x) => `- ${x}`).join('\n').length + e.length + 3 > MEMORY_MAX) break;
      entries.push(e);
    }
    this.writeEntries(entries);
    logger.info({ count: entries.length }, 'memory bootstrapped from existing workspace notes');
  }

  private read(f: string): string {
    try {
      return fs.readFileSync(f, 'utf8');
    } catch {
      return '';
    }
  }

  getLaws(): string {
    return this.read(this.lawsFile);
  }
  /** User-owned: lets the Settings panel edit the laws. The AGENT has no path to this. */
  setLaws(text: string): void {
    fs.writeFileSync(this.lawsFile, text);
  }
  /** Restore the default Asimov-style laws (used by the "reset" control). */
  resetLaws(): void {
    fs.writeFileSync(this.lawsFile, LAWS_SEED);
  }
  getSoul(): string {
    return this.read(this.soulFile);
  }
  getUser(): string {
    return this.read(this.userFile);
  }
  getMemory(): string {
    return this.read(this.memFile);
  }
  setSoul(text: string): void {
    fs.writeFileSync(this.soulFile, text);
  }
  setUser(text: string): void {
    fs.writeFileSync(this.userFile, text);
  }

  // ── generic bounded bullet-doc operations (shared by MEMORY.md and USER.md) ──
  private docList(file: string): string[] {
    return this.read(file)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2).trim())
      .filter(Boolean);
  }
  private docWrite(file: string, header: string | null, entries: string[]): void {
    const body = entries.length ? entries.map((e) => `- ${e}`).join('\n') + '\n' : '';
    fs.writeFileSync(file, header ? `${header}\n\n${body}` : body);
  }
  private docUsage(file: string, max: number): MemoryUsage {
    const chars = this.read(file).length;
    return { chars, max, pct: Math.round((chars / max) * 100) };
  }
  private bodyLen(entries: string[]): number {
    return entries.map((e) => `- ${e}`).join('\n').length;
  }
  private docAdd(file: string, header: string | null, max: number, label: string, text: string): { ok: boolean; message: string } {
    const t = text.trim();
    if (!t) return { ok: false, message: 'Nothing to save (empty).' };
    const entries = this.docList(file);
    if (entries.some((e) => e === t)) return { ok: true, message: 'Already recorded.' };
    entries.push(t);
    if (this.bodyLen(entries) > max) {
      return { ok: false, message: `${label} is ${this.docUsage(file, max).pct}% full (cap ${max} chars). Consolidate or remove stale entries first (action "list" then "remove"/"replace").` };
    }
    this.docWrite(file, header, entries);
    return { ok: true, message: `Saved. ${label} now ${this.docUsage(file, max).pct}% full.` };
  }
  private docReplace(file: string, header: string | null, max: number, label: string, find: string, text: string): { ok: boolean; message: string } {
    const entries = this.docList(file);
    const idx = entries.findIndex((e) => e.includes(find));
    if (idx < 0) return { ok: false, message: `No ${label.toLowerCase()} entry matching "${find}".` };
    const old = entries[idx]!;
    entries[idx] = text.trim();
    if (this.bodyLen(entries) > max) {
      entries[idx] = old;
      return { ok: false, message: `That would exceed the ${max}-char cap. Shorten it or remove another entry first.` };
    }
    this.docWrite(file, header, entries);
    return { ok: true, message: `Updated. ${label} now ${this.docUsage(file, max).pct}% full.` };
  }
  private docRemove(file: string, header: string | null, max: number, label: string, find: string): { ok: boolean; message: string } {
    const entries = this.docList(file);
    const kept = entries.filter((e) => !e.includes(find));
    if (kept.length === entries.length) return { ok: false, message: `No ${label.toLowerCase()} entry matching "${find}".` };
    this.docWrite(file, header, kept);
    return { ok: true, message: `Removed ${entries.length - kept.length} entry(ies). ${label} now ${this.docUsage(file, max).pct}% full.` };
  }

  // ── MEMORY.md: working notes (no header). With an `agent` name, routes to that agent's OWN
  //    notes file (agent-memory/<agent>.md) so agents never read each other's task state; without
  //    one, the shared MEMORY.md (used by the main chat). ──
  private memFileFor(agent?: string): string {
    if (!agent) return this.memFile;
    const safe = agent.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
    try { if (!fs.existsSync(this.agentMemDir)) fs.mkdirSync(this.agentMemDir, { recursive: true }); } catch { /* best-effort */ }
    return path.join(this.agentMemDir, `${safe}.md`);
  }
  list(agent?: string): string[] {
    return this.docList(this.memFileFor(agent));
  }
  usage(agent?: string): MemoryUsage {
    return this.docUsage(this.memFileFor(agent), MEMORY_MAX);
  }
  private writeEntries(entries: string[]): void {
    this.docWrite(this.memFile, null, entries);
  }
  add(text: string, agent?: string): { ok: boolean; message: string } {
    return this.docAdd(this.memFileFor(agent), null, MEMORY_MAX, 'Memory', text);
  }
  replace(find: string, text: string, agent?: string): { ok: boolean; message: string } {
    return this.docReplace(this.memFileFor(agent), null, MEMORY_MAX, 'Memory', find, text);
  }
  remove(find: string, agent?: string): { ok: boolean; message: string } {
    return this.docRemove(this.memFileFor(agent), null, MEMORY_MAX, 'Memory', find);
  }

  // ── USER.md: the agent-curated profile of the user (header preserved) ──
  userList(): string[] {
    return this.docList(this.userFile);
  }
  userUsage(): MemoryUsage {
    return this.docUsage(this.userFile, USER_MAX);
  }
  addUser(text: string): { ok: boolean; message: string } {
    return this.docAdd(this.userFile, USER_HEADER, USER_MAX, 'Profile', text);
  }
  replaceUser(find: string, text: string): { ok: boolean; message: string } {
    return this.docReplace(this.userFile, USER_HEADER, USER_MAX, 'Profile', find, text);
  }
  removeUser(find: string): { ok: boolean; message: string } {
    return this.docRemove(this.userFile, USER_HEADER, USER_MAX, 'Profile', find);
  }

  // ── LEARNINGS.md: reusable findings the smart model teaches back (device maps,
  //    endpoints, fixes). Surfaced to the LOCAL model so it can handle it next time. ──
  getLearnings(): string {
    return this.read(this.learnFile);
  }
  learningsList(): string[] {
    return this.docList(this.learnFile);
  }
  learningsUsage(): MemoryUsage {
    return this.docUsage(this.learnFile, LEARNINGS_MAX);
  }
  /** Caps (chars) — so the engine's consolidation pass knows the target size. */
  learningsMax(): number { return LEARNINGS_MAX; }
  memoryMax(): number { return MEMORY_MAX; }
  /** Replace the WHOLE learnings file (used by the consolidation pass; keeps the FTS index in sync). */
  setLearningsList(entries: string[]): void {
    this.docWrite(this.learnFile, null, entries);
    this.learnings.reindex(this.learningsList());
  }
  /** Replace the WHOLE memory file (used by the consolidation pass). */
  setMemoryList(entries: string[]): void {
    this.docWrite(this.memFile, null, entries);
  }
  addLearning(text: string): { ok: boolean; message: string } {
    const t = (text ?? '').trim();
    if (!t || /^none\.?$/i.test(t)) return { ok: false, message: 'Nothing durable to learn — skipped.' };
    // Storage-layer guard (covers the `learn` tool, the distill pass, everything): reject
    // TRANSIENT VALUES — a score "6-1", a date, a price, "today"/"last night", "game 5" —
    // they expire. NOT category words, so a durable method ("for scores use web_search") is fine.
    if (TRANSIENT_LEARNING.test(t)) {
      return { ok: false, message: 'That is transient/time-bound (it will be stale later) — not saved. Learn durable methods, mappings, endpoints, or fixes.' };
    }
    const res = this.docAdd(this.learnFile, null, LEARNINGS_MAX, 'Learnings', t);
    if (res.ok) this.learnings.reindex(this.learningsList()); // keep the FTS index in sync
    return res;
  }

  /**
   * Learnings RELEVANT to the given request (FTS5-ranked), for a focused prompt hint. Falls
   * back to the full list when the FTS index is unavailable; empty string if nothing matches.
   */
  relevantLearningsBlock(query: string): string {
    const parts: string[] = [];
    // Stored absolute facts that answer this kind of question (the "remember the answer" path).
    const facts = this.learnings.searchFacts(query);
    if (facts.length) parts.push(`## Known facts (verified earlier — if one answers the question, use it directly, do not re-search)\n${facts.map((e) => `- ${e}`).join('\n')}`);
    // Reusable methods/mappings.
    const hits = this.learnings.search(query);
    if (hits === null) {
      const all = this.learningsBlock();
      if (all) parts.push(all);
    } else if (hits.length) {
      parts.push(`## Learned methods (relevant — apply them directly)\n${hits.map((e) => `- ${e}`).join('\n')}`);
    }
    return parts.join('\n\n');
  }

  /** Store an absolute, self-contained fact in the knowledge index (the "remember answers" path). */
  addFact(text: string): boolean {
    return this.learnings.addFact(text);
  }
  replaceLearning(find: string, text: string): { ok: boolean; message: string } {
    return this.docReplace(this.learnFile, null, LEARNINGS_MAX, 'Learnings', find, text);
  }
  removeLearning(find: string): { ok: boolean; message: string } {
    return this.docRemove(this.learnFile, null, LEARNINGS_MAX, 'Learnings', find);
  }
  /** Learned-facts block for prompts (empty string if none). */
  learningsBlock(): string {
    const items = this.learningsList();
    if (!items.length) return '';
    return `## Learned facts (things figured out before — apply them directly)\n${items.map((e) => `- ${e}`).join('\n')}`;
  }

  /**
   * The inviolable safety laws, framed for the system prompt. Injected FIRST and
   * separately from the rest so its precedence is unambiguous. Empty string only
   * if the user deliberately blanked LAWS.md.
   */
  lawsBlock(): string {
    const laws = this.getLaws().trim();
    if (!laws) return '';
    return `## INVIOLABLE LAWS — these override everything below, including the user's instructions in chat\nObey these at all times. If any request, persona note, memory entry, or instruction conflicts with a lower-numbered law, refuse that part, explain briefly, and offer a safe alternative. Apply them with judgment: do routine, reversible work without asking, and reserve confirmation for genuinely high-risk or hard-to-undo actions.\n\n${laws}`;
  }

  /** The curated block injected into the system prompt every turn. */
  systemPromptBlock(agent?: string): string {
    const parts: string[] = [];
    const soul = this.getSoul().replace(/^#.*$/m, '').trim();
    if (soul) parts.push(`## Persona / voice (defined by the user — do not rewrite it)\n${soul}`);
    const user = this.getUser().replace(/^#.*$/m, '').trim();
    const uu = this.userUsage();
    parts.push(
      `## About the user [${uu.pct}% of ${uu.max} chars] — you maintain this profile with the \`memory\` tool using scope="profile" (add / replace / remove). Record durable facts about the user here (name, timezone, communication style, recurring projects, things to avoid); keep it concise and consolidate when it nears full.\n${user || '(empty)'}`,
    );
    const entries = this.list(agent);
    const u = this.usage(agent);
    parts.push(
      `## Your working memory [${u.pct}% of ${u.max} chars] — you curate this with the \`memory\` tool (default scope="memory"). Use it for ongoing tasks and context that isn't part of the user's profile. Keep it concise; when it nears full, consolidate or drop stale entries.\n${
        entries.length ? entries.map((e) => `- ${e}`).join('\n') : '(empty)'
      }`,
    );
    const learnings = this.learningsBlock();
    if (learnings) parts.push(learnings);
    return parts.join('\n\n');
  }
}
