#!/usr/bin/env node
// RVSQ appointment checker — a single headless-capable check of Quebec's "Rendez-vous santé Québec"
// (rvsq.gouv.qc.ca) for available walk-in / urgent-consultation slots, driven by Zamolxis's
// rvsq-watch agent on a schedule. Windows-first, runs entirely locally: it reuses Zamolxis's own
// playwright-core + your installed Google Chrome (channel:'chrome') — no extra install, no browser
// download, no cloud. Flow + selectors reproduced from the Meulade_RVSQ project (github.com/tony-png).
//
// It reads your RAMQ health-insurance details from a LOCAL config file you fill in yourself
// (%USERPROFILE%\.zamolxis\rvsq-config.json, or $RVSQ_CONFIG). Those details are NEVER printed,
// logged, or sent anywhere but the official RVSQ site. Output is one JSON object on stdout:
//   { "ok": bool, "available": bool, "clinics": [..], "screenshot": path|null, "step": str,
//     "checked_at": iso, "error": null|str }
// Exit code is always 0 (parse the JSON) unless the config is missing (exit 2).
//
// Usage:  node rvsq_check.mjs            # one real check
//         node rvsq_check.mjs --selftest # navigate + confirm the RAMQ form loads, then STOP (never submits)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const SELFTEST = process.argv.includes('--selftest');
const RVSQ_URL = 'https://rvsq.gouv.qc.ca/prendrerendezvous/Principale.aspx';
const REASON_URGENT = 'ac2a5fa4-8514-11ef-a759-005056b11d6c'; // "Consultation Urgente" option value (may change server-side)

function out(o) { process.stdout.write(JSON.stringify({ checked_at: new Date().toISOString(), ...o }) + '\n'); }

function loadConfig() {
  const p = process.env.RVSQ_CONFIG || path.join(os.homedir(), '.zamolxis', 'rvsq-config.json');
  if (!fs.existsSync(p)) {
    out({ ok: false, available: false, step: 'config', error: `No config at ${p}. Copy rvsq-config.example.json there and fill in your RAMQ details.` });
    process.exit(2);
  }
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  const pi = cfg.personal_info || {};
  const required = ['first_name', 'last_name', 'nam', 'card_seq_number', 'birth_day', 'birth_month', 'birth_year', 'postal_code'];
  const missing = required.filter((k) => !String(pi[k] || '').trim());
  if (missing.length && !SELFTEST) { out({ ok: false, available: false, step: 'config', error: `Config is missing: ${missing.join(', ')}` }); process.exit(2); }
  return cfg;
}

async function main() {
  const cfg = loadConfig();
  const pi = cfg.personal_info || {};
  const headless = cfg.headless === true; // default headed — the RVSQ ASP.NET flow is more reliable with a real window
  const radius = String(cfg.radius_km || '4'); // '4' == 50 km in RVSQ's perimeter combo
  const reason = String(cfg.consulting_reason || REASON_URGENT);
  const shotDir = path.join(os.homedir(), '.zamolxis', 'rvsq-screenshots');
  fs.mkdirSync(shotDir, { recursive: true });

  let browser;
  let step = 'launch';
  try {
    browser = await chromium.launch({ channel: 'chrome', headless, args: ['--disable-redirect-limits'] });
    const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36' });
    ctx.setDefaultTimeout(60000);
    const page = await ctx.newPage();

    step = 'navigate';
    await page.goto(RVSQ_URL, { timeout: 60000, waitUntil: 'networkidle' });
    step = 'cookies';
    try { await page.locator('#btnToutAccepter').click({ timeout: 8000 }); } catch { /* banner may not appear */ }

    step = 'form';
    await page.waitForSelector('#ctl00_ContentPlaceHolderMP_AssureForm_NAM', { timeout: 30000 });
    if (SELFTEST) {
      // Confirm the RAMQ form is present WITHOUT filling or submitting anything to the government site.
      const ready = await page.locator('#ctl00_ContentPlaceHolderMP_AssureForm_NAM').isVisible();
      await browser.close();
      out({ ok: true, available: false, step: 'selftest', form_ready: ready, error: null });
      return;
    }

    await page.fill('#ctl00_ContentPlaceHolderMP_AssureForm_FirstName', pi.first_name);
    await page.fill('#ctl00_ContentPlaceHolderMP_AssureForm_LastName', pi.last_name);
    await page.fill('#ctl00_ContentPlaceHolderMP_AssureForm_NAM', pi.nam);
    await page.fill('#ctl00_ContentPlaceHolderMP_AssureForm_CardSeqNumber', pi.card_seq_number);
    await page.fill('#ctl00_ContentPlaceHolderMP_AssureForm_Day', String(pi.birth_day));
    await page.selectOption('#ctl00_ContentPlaceHolderMP_AssureForm_Month', String(pi.birth_month));
    await page.fill('#ctl00_ContentPlaceHolderMP_AssureForm_Year', String(pi.birth_year));
    await page.check('#AssureForm_CSTMT');
    await page.waitForSelector('#ctl00_ContentPlaceHolderMP_myButton:not([disabled])');
    await page.click('#ctl00_ContentPlaceHolderMP_myButton');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    step = 'context';
    const hasFamilyDoctor = await page.locator("a.h-SelectAssureBtn.ctx-changer[data-type='1']").isVisible().catch(() => false);
    const noFamilyDoctor = await page.locator('text=pas de médecin de famille').isVisible().catch(() => false);
    if (noFamilyDoctor) await page.click("a.h-SelectAssureBtn.ctx-changer[data-type='3']");
    else if (hasFamilyDoctor) await page.click("a.h-SelectAssureBtn.ctx-changer[data-type='1']");
    else throw new Error('Could not determine family-doctor status (RVSQ login may have failed — check your RAMQ details).');

    step = 'reason';
    await page.waitForSelector('#consultingReason', { state: 'visible', timeout: 60000 });
    await page.waitForTimeout(2000);
    await page.click('#consultingReason');
    await page.selectOption('#consultingReason', reason);

    step = 'search-setup';
    await page.click('button:has-text("Rechercher")');
    await page.waitForLoadState('networkidle');
    if (hasFamilyDoctor) {
      await page.click('div.thumbnail.tmbArrow.tmbBtn.h-butType2dot2:has-text("groupe de médecine de famille (GMF)")');
      await page.click('button:has-text("Rechercher")');
      await page.waitForLoadState('networkidle');
      await page.click('div.thumbnail.tmbArrow.tmbBtn.h-butType3:has-text("clinique à proximité")');
    } else {
      await page.waitForLoadState('networkidle');
      await page.click('button:has-text("Rechercher")');
      await page.waitForLoadState('networkidle');
    }
    try { await page.selectOption('#perimeterCombo', radius); }
    catch { try { await page.evaluate((r) => { const e = document.getElementById('perimeterCombo'); if (e) e.value = r; }, radius); } catch { /* ignore */ } }

    step = 'search';
    await page.fill('#PostalCode', pi.postal_code);
    await page.click('button.h-SearchButton.btn.btn-primary:has-text("Rechercher")');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(5000);

    const negative = (await page.locator('text=Aucun rendez-vous').first().isVisible().catch(() => false))
      || (await page.locator('#clinicsWithNoDisponibilities').isVisible().catch(() => false));
    const positive = await page.locator('text=Les cliniques suivantes offrent des disponibilités').isVisible().catch(() => false);

    let clinics = [];
    let screenshot = null;
    if (positive && !negative) {
      try { clinics = (await page.locator('.clinic, .h-ClinicName, [class*=clinic]').allInnerTexts()).map((t) => t.trim()).filter(Boolean).slice(0, 20); } catch { /* best-effort */ }
      screenshot = path.join(shotDir, `slot_${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      if (process.platform === 'win32') { try { const cp = await import('node:child_process'); cp.spawn('powershell', ['-NoProfile', '-c', '[console]::beep(1000,400);[console]::beep(2000,400);[console]::beep(1000,400)'], { windowsHide: true }).unref(); } catch { /* beep is best-effort */ } }
    }
    await browser.close();
    out({ ok: true, available: !!(positive && !negative), clinics, screenshot, step: 'done', error: null });
  } catch (err) {
    try { if (browser) await browser.close(); } catch { /* */ }
    out({ ok: false, available: false, step, error: String((err && err.message) || err) });
  }
}

main();
