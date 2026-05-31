/**
 * Temporary display-name override. When the user asks the agent to go by another
 * name for a while ("your name is Charlie for two minutes"), the agent sets this;
 * the engine's persona and the web UI use the EFFECTIVE name until it expires, then
 * everything reverts to the configured agentName. Process-global (it's the agent's
 * identity, shared across conversations/surfaces).
 */
let temp: { name: string; until: number } | null = null;

export function setTempName(name: string, minutes: number): { name: string; until: number } {
  const mins = Math.min(Math.max(Number(minutes) || 2, 1), 1440);
  const clean = String(name || '').replace(/[<>'"`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Zamolxis';
  temp = { name: clean, until: Date.now() + mins * 60_000 };
  return temp;
}

export function clearTempName(): void {
  temp = null;
}

/** The active temporary name (or null if none / expired). */
export function tempName(): { name: string; until: number } | null {
  if (temp && Date.now() < temp.until) return temp;
  if (temp) temp = null;
  return null;
}

/** Effective name to show/use right now: the temporary one if active, else `base`. */
export function effectiveName(base: string): string {
  const t = tempName();
  return t ? t.name : base;
}
