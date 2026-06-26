// Xchange Rate API client — builds the per-request auth token exactly as the service's
// "Examples" page prescribes and fetches USD-based currency rates. Shared by the /api/xchange
// proxy (for the desktop app) and the `exchange_rates` agent tool. `rest.upclick.com` is the
// live API host this talks to — the one fixed external endpoint.

import { createHash } from 'node:crypto';

export interface XchangeRow { name: string; iso: string; symbol: string; rate: number; }
export interface XchangeResult { ok: boolean; rows?: XchangeRow[]; error?: string; }

const md5u = (s: string) => createHash('md5').update(Buffer.from(s, 'utf16le')).digest('hex').toUpperCase();

/** Fetch exchange rates. Pass an ISO 4217 code to get a single currency; omit for all. */
export async function fetchXchangeRates(opts: { uid: string; password: string; isocode?: string }): Promise<XchangeResult> {
  const uid = String(opts.uid || '').trim();
  const password = String(opts.password || '');
  const isocode = String(opts.isocode || '').trim();
  if (!uid || !password) return { ok: false, error: 'UID and password are required.' };
  const d = new Date(Date.now() - 3600 * 1000); // UTC now minus one hour
  const p = (n: number) => String(n).padStart(2, '0');
  const ts = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  const method = 'tools.xchangerate';
  const token = Buffer.from(`${uid}|${ts}|${md5u(md5u(password) + ts + method)}`, 'utf8').toString('base64');
  let target = `https://rest.upclick.com/json/${token}/tools/xchangerate`;
  if (isocode) target += `?isocode=${encodeURIComponent(isocode)}`;
  let text: string; let r: Response;
  try { r = await fetch(target, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30000) }); text = await r.text(); }
  catch (err) { return { ok: false, error: String((err as Error)?.message || err) }; }
  let data: any;
  try { data = JSON.parse(text); } catch { return { ok: false, error: 'Non-JSON response from the exchange-rate API.' }; }
  // Peel the { tools_xchangerate: … } envelope.
  let payload = data;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    if (payload.tools_xchangerate !== undefined) payload = payload.tools_xchangerate;
    else { const ks = Object.keys(payload); if (ks.length === 1) payload = payload[ks[0] as string]; }
  }
  const eo = (payload && typeof payload === 'object' && !Array.isArray(payload)) ? (payload.errors || payload.error) : null;
  if (eo) return { ok: false, error: eo.description || eo.Description || JSON.stringify(eo) };
  const isCur = (v: any) => v && typeof v === 'object' && ('ISOCode' in v || 'USRate' in v || 'UsRate' in v);
  let arr: any[] = [];
  if (Array.isArray(payload)) arr = payload;
  else if (isCur(payload)) arr = [payload];
  else if (payload && typeof payload === 'object') {
    for (const k of ['xchange', 'Xchange']) { const v = payload[k]; if (Array.isArray(v)) { arr = v; break; } if (isCur(v)) { arr = [v]; break; } }
    if (!arr.length) { const ak = Object.keys(payload).find((k) => Array.isArray(payload[k])); if (ak) arr = payload[ak]; }
  }
  const rows: XchangeRow[] = arr.map((x: any) => ({ name: x.Name ?? '', iso: x.ISOCode ?? '', symbol: x.Symbol ?? '', rate: Number(x.USRate ?? x.UsRate ?? x.usRate) }));
  if (!rows.length) return { ok: false, error: 'No exchange rates in the response.' };
  return { ok: true, rows };
}

/** Render rows as a Markdown table (for the agent tool's text output). */
export function xchangeTable(rows: XchangeRow[]): string {
  const head = '| Currency | ISO | Symbol | Rate (per USD) |\n| --- | --- | --- | --- |';
  const body = rows
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((r) => `| ${r.name} | ${r.iso} | ${r.symbol} | ${Number.isFinite(r.rate) ? r.rate : ''} |`)
    .join('\n');
  return `${head}\n${body}`;
}
