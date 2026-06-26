#!/usr/bin/env node
// Xchange Rate "tools.xchangerate" caller — fetches USD-based exchange rates and prints a table.
//
// It reproduces, byte-for-byte, the authentication scheme from the API's "Examples" page (the C#
// sample). Getting any of these details wrong yields an "invalid token" response, so they matter:
//   - MD5 is computed over the UTF-16LE bytes of the string (C# Encoding.Unicode),
//     and rendered as UPPERCASE hex (C# ToString("X2")).
//   - hashedpassword = MD5(password)
//   - token = base64( utf8( UID + "|" + ts + "|" + MD5(hashedpassword + ts + method) ) )
//   - ts    = current UTC time minus one hour, formatted "yyyy-MM-dd HH:mm:ss"
//   - URL   = https://rest.upclick.com/json/<token>/tools/xchangerate  (the live API host)
//
// Credentials are read from the environment and never logged. Usage:
//   XCHANGE_UID=17172 XCHANGE_PASSWORD=secret node xchangerates.mjs [ISOCODE] [--json]

import crypto from 'node:crypto';

// MD5 of the UTF-16LE bytes of `str`, uppercase hex — matches the C# CalculateMD5Hash().
function md5(str) {
  return crypto.createHash('md5').update(Buffer.from(str, 'utf16le')).digest('hex').toUpperCase();
}

// "yyyy-MM-dd HH:mm:ss" of (now - 1h) in UTC, exactly like DateTime.UtcNow.AddHours(-1).
function timestamp() {
  const d = new Date(Date.now() - 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function buildToken(method, uid, ts, hashedPassword) {
  const inner = md5(hashedPassword + ts + method);
  return Buffer.from(`${uid}|${ts}|${inner}`, 'utf8').toString('base64');
}

// The API wraps the payload in a method-named envelope, e.g.
//   { "tools_xchangerate": [ {Name,ISOCode,Symbol,UsRate}, ... ] }            (success)
//   { "tools_xchangerate": { "errors": { "type": "...", "description": "..." } } }  (error)
// Peel that envelope before looking at the contents.
function unwrap(data) {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    if (data.tools_xchangerate !== undefined) return data.tools_xchangerate;
    const keys = Object.keys(data);
    if (keys.length === 1) return data[keys[0]];
  }
  return data;
}

// Pull an API error message out of the (already unwrapped) payload, if any.
function findError(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const e = payload.errors || payload.error || payload.Errors || payload.Error;
  if (e) return e.description || e.Description || e.message || e.Message || JSON.stringify(e);
  return null;
}

const isCurrency = (v) => v && typeof v === 'object' && ('ISOCode' in v || 'USRate' in v || 'UsRate' in v);

function asRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (isCurrency(payload)) return [payload]; // already a single currency object
  if (payload && typeof payload === 'object') {
    // The list nests one more level under `xchange` (all currencies => array,
    // a single ?isocode= lookup => one object).
    for (const k of ['xchange', 'Xchange', 'items', 'Items', 'Currencies', 'currencies', 'data', 'Data', 'result', 'Result']) {
      const v = payload[k];
      if (Array.isArray(v)) return v;
      if (isCurrency(v)) return [v];
    }
    // Fallback: any single array-valued key.
    const arrKey = Object.keys(payload).find((k) => Array.isArray(payload[k]));
    if (arrKey) return payload[arrKey];
  }
  return [];
}

function table(rows) {
  rows = rows.slice().sort((a, b) => String(a.Name || '').localeCompare(String(b.Name || '')));
  const head = ['Currency', 'ISO', 'Symbol', 'Rate (per USD)'];
  const lines = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`];
  for (const r of rows) {
    const rate = (r.USRate ?? r.UsRate ?? r.usRate);
    const rateStr = (rate === null || rate === undefined || rate === '') ? '' : Number(rate).toLocaleString('en-US', { maximumFractionDigits: 6 });
    lines.push(`| ${[r.Name ?? '', r.ISOCode ?? '', r.Symbol ?? '', rateStr].map((c) => String(c).replace(/\|/g, '\\|')).join(' | ')} |`);
  }
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--json');
  const wantJson = process.argv.includes('--json');
  const uid = process.env.XCHANGE_UID || args[0];
  const password = process.env.XCHANGE_PASSWORD || args[1];
  const isocode = process.env.XCHANGE_ISOCODE || (process.env.XCHANGE_UID ? args[0] : args[2]) || '';

  if (!uid || !password) {
    console.error('Missing credentials. Set XCHANGE_UID and XCHANGE_PASSWORD (env), e.g.:');
    console.error('  XCHANGE_UID=17172 XCHANGE_PASSWORD=yourpass node xchangerates.mjs [ISOCODE]');
    process.exit(2);
  }

  const method = 'tools.xchangerate';
  const ts = timestamp();
  const hashedPassword = md5(password); // C#: hashedpassword = CalculateMD5Hash(password)
  const token = buildToken(method, uid, ts, hashedPassword);
  let url = `https://rest.upclick.com/json/${token}/${method.replace(/\./g, '/')}`;
  if (isocode) url += `?isocode=${encodeURIComponent(isocode)}`;

  let res, text;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000) });
    text = await res.text();
  } catch (e) {
    console.error('Request failed:', e?.message || e);
    process.exit(1);
  }

  let data;
  try { data = JSON.parse(text); }
  catch { console.error(`Non-JSON response (HTTP ${res.status}):`, text.slice(0, 600)); process.exit(1); }

  const payload = unwrap(data);
  const err = findError(payload);
  if (err) { console.error('API error:', err); process.exit(1); }

  const rows = asRows(payload);
  if (!rows.length) { console.error('No exchange rates in response:', text.slice(0, 600)); process.exit(1); }

  if (wantJson) { console.log(JSON.stringify(rows, null, 2)); return; }
  console.log(table(rows));
  console.error(`\n${rows.length} currencies · USD-based (source: XE.COM) · fetched ${new Date().toISOString()}`);
}

main();
