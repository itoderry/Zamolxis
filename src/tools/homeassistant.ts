import { logger } from '../logger.js';

/** Is Home Assistant configured (a long-lived access token present)? */
export function haConfigured(): boolean {
  return !!process.env.ZAMOLXIS_HA_TOKEN;
}

export interface HaEntity {
  entity_id: string;
  area: string;
  name: string;
  state: string;
  domain: string;
}

/** Pull every HA entity with its AREA and friendly name in ONE call via the template API
 *  ({{ area_name(entity_id) }}), falling back to /api/states (no area) on older instances. */
export async function fetchHaInventory(): Promise<{ ok: boolean; error?: string; rows: HaEntity[] }> {
  const token = process.env.ZAMOLXIS_HA_TOKEN;
  if (!token) return { ok: false, error: 'Home Assistant is not configured (no ZAMOLXIS_HA_TOKEN).', rows: [] };
  const base = (process.env.ZAMOLXIS_HA_URL || 'http://homeassistant.local:8123').replace(/\/$/, '');
  const headers = { Authorization: `Bearer ${token}` };
  // Tab-delimited rows: entity_id <TAB> area <TAB> friendly_name <TAB> state
  const tmpl =
    "{%- for s in states %}{{ s.entity_id }}\t{{ area_name(s.entity_id) or '' }}\t{{ s.attributes.friendly_name or s.entity_id }}\t{{ s.state }}\n{% endfor -%}";
  const parseTsv = (body: string): HaEntity[] =>
    body
      .split('\n')
      .map((l) => l.replace(/\r$/, ''))
      .filter((l) => l.trim())
      .map((l) => {
        const parts = l.split('\t');
        const entity_id = (parts[0] || '').trim();
        return { entity_id, area: (parts[1] || '').trim(), name: (parts[2] || entity_id).trim(), state: (parts[3] || '').trim(), domain: (entity_id.split('.')[0] || '').trim() };
      })
      .filter((e) => e.entity_id.includes('.'));
  try {
    const r = await fetch(`${base}/api/template`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ template: tmpl }),
      signal: AbortSignal.timeout(25000),
    });
    if (r.ok) {
      const rows = parseTsv(await r.text());
      if (rows.length) return { ok: true, rows };
    } else {
      logger.warn({ status: r.status }, 'HA template API failed — falling back to /api/states');
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'HA template fetch failed — falling back to /api/states');
  }
  // Fallback: list states (no area registry).
  try {
    const r2 = await fetch(`${base}/api/states`, { headers, signal: AbortSignal.timeout(25000) });
    if (!r2.ok) return { ok: false, error: `Home Assistant HTTP ${r2.status}`, rows: [] };
    const states = (await r2.json()) as Array<{ entity_id: string; state: string; attributes?: { friendly_name?: string } }>;
    const rows = states
      .filter((s) => s && s.entity_id && s.entity_id.includes('.'))
      .map((s) => ({ entity_id: s.entity_id, area: '', name: s.attributes?.friendly_name || s.entity_id, state: s.state, domain: s.entity_id.split('.')[0] || '' }));
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, error: String(err), rows: [] };
  }
}
