import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.js';

// The Butler engine (a rebranded native maintenance core) lives in the repo's bin/ as two builds:
//  - butler-scan.exe  : standard-user (asInvoker) - read-only SCANS run with NO UAC prompt.
//  - butler-core.exe  : elevated (requireAdministrator) - used by the scheduled task and for FIXES.
// John drives these headlessly; every scan flag writes a JSON file we parse deterministically, so
// the model never has to plan the scan - it only decides which scan to run and phrases the result.
const DIST_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // dist/
const BIN_DIR = path.join(path.dirname(DIST_DIR), 'bin');
const SCAN_EXE = path.join(BIN_DIR, 'butler-scan.exe');
const CORE_EXE = path.join(BIN_DIR, 'butler-core.exe');
const TASK_NAME = 'Butler_Health'; // elevated scheduled task that produces the periodic report
const REPORT_FILE = path.join(process.env.ProgramData || 'C:/ProgramData', 'Butler', 'reports', 'health.json');

export function butlerAvailable(): boolean {
  return process.platform === 'win32' && fs.existsSync(SCAN_EXE);
}

// ── John's autonomous duties: which maintenance areas he handles on his own during the weekly
//    round, chosen by the user on John's dashboard. `applyFixes` is a separate master opt-in (off
//    by default) that lets the round APPLY safe fixes instead of only reporting. Stored in the
//    Zamolxis data dir; read by John's job and by the dashboard, written by the dashboard/tool. ──
export const BUTLER_DUTIES = ['drivers', 'apps', 'network', 'system', 'cleanup', 'duplicates'] as const;
export type ButlerDuty = (typeof BUTLER_DUTIES)[number];
export interface ButlerConfig {
  duties: Record<ButlerDuty, boolean>;
  duplicatesFolder?: string;
  applyFixes: boolean;
}
function defaultConfig(): ButlerConfig {
  return { duties: { drivers: false, apps: false, network: false, system: false, cleanup: false, duplicates: false }, applyFixes: false };
}
function cfgPath(dataDir: string): string {
  return path.join(dataDir, 'butler-duties.json');
}
export function readButlerConfig(dataDir: string): ButlerConfig {
  const base = defaultConfig();
  try {
    const saved = JSON.parse(fs.readFileSync(cfgPath(dataDir), 'utf8')) as Partial<ButlerConfig>;
    return { duties: { ...base.duties, ...(saved.duties || {}) }, duplicatesFolder: saved.duplicatesFolder, applyFixes: !!saved.applyFixes };
  } catch {
    return base;
  }
}
export function writeButlerConfig(dataDir: string, patch: Partial<ButlerConfig>): ButlerConfig {
  const cur = readButlerConfig(dataDir);
  const next: ButlerConfig = {
    duties: { ...cur.duties, ...(patch.duties || {}) },
    duplicatesFolder: patch.duplicatesFolder !== undefined ? patch.duplicatesFolder : cur.duplicatesFolder,
    applyFixes: patch.applyFixes !== undefined ? !!patch.applyFixes : cur.applyFixes,
  };
  try { fs.writeFileSync(cfgPath(dataDir), JSON.stringify(next, null, 2)); } catch (err) { logger.warn({ err: String(err) }, 'could not save butler duties'); }
  return next;
}

/** One headless scan via the standard-user engine (butler-scan.exe): run with `flag` (+ optional
 *  positional like a folder), let it write its output to a temp file, and return the RAW string.
 *  UAC-free - every on-demand scan works without an elevation prompt (drivers, system health, apps,
 *  network, duplicates all read fine as a standard user; deep disk S.M.A.R.T. is the only thing that
 *  benefits from the elevated weekly task). */
async function runRaw(flag: string, positional?: string): Promise<{ ok: boolean; raw?: string; error?: string }> {
  if (!butlerAvailable()) return { ok: false, error: 'The Butler engine is only available on this Windows machine (bin/butler-scan.exe missing).' };
  const outFile = path.join(os.tmpdir(), `butler-${flag.replace(/[^a-z]/gi, '')}-${process.pid}-${Date.now()}.out`);
  const args = positional ? [flag, positional, outFile] : [flag, outFile];
  const code = await new Promise<number>((resolve) => {
    const child = spawn(SCAN_EXE, args, { windowsHide: true });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve(-2); }, 150_000);
    child.on('error', () => { clearTimeout(timer); resolve(-1); });
    child.on('close', (c) => { clearTimeout(timer); resolve(c ?? 0); });
  });
  try {
    const raw = fs.readFileSync(outFile, 'utf8');
    fs.unlinkSync(outFile);
    return { ok: true, raw };
  } catch {
    return { ok: false, error: code === -1 ? 'Could not launch the Butler engine.' : code === -2 ? 'The scan timed out.' : 'The scan produced no readable result.' };
  }
}

/** A scan whose output is JSON (--dumpapps / --dumpnet / --dumpsys / --dumpdup). */
async function runScan(flag: string, positional?: string): Promise<Record<string, unknown>> {
  const r = await runRaw(flag, positional);
  if (!r.ok) return { error: r.error };
  try { return JSON.parse(r.raw!) as Record<string, unknown>; } catch { return { error: 'The scan produced an unreadable result.' }; }
}

/** Strip an HTML report down to readable plain text (the engine's --export driver report is HTML). */
function stripHtml(html: string): string {
  return html
    .replace(/^\uFEFF/, '')
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, '')
    .replace(/<\s*(tr|h1|h2|h3|p|div|br)[^>]*>/gi, '\n')
    .replace(/<\s*\/\s*(td|th)\s*>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '');
}

// All read-only scans run as a standard user - no UAC prompt. JSON dumps parse; the driver report
// (--export) is an HTML document we return as readable text.
export const scanApps = () => runScan('--dumpapps');
export const scanNetwork = () => runScan('--dumpnet');
export const scanDuplicates = (folder: string) => runScan('--dumpdup', folder);
export const scanSystem = () => runScan('--dumpsys');
export async function driverReport(): Promise<{ ok: boolean; text?: string; error?: string }> {
  const r = await runRaw('--export');
  return r.ok ? { ok: true, text: stripHtml(r.raw!) } : { ok: false, error: r.error };
}

/** Read the most recent report produced by the elevated scheduled task (complete health scan with
 *  admin-only data like S.M.A.R.T.). Returns null if the task has never run. */
export function latestHealthReport(): { report: Record<string, unknown>; when: number } | null {
  try {
    const st = fs.statSync(REPORT_FILE);
    return { report: JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8')) as Record<string, unknown>, when: st.mtimeMs };
  } catch {
    return null;
  }
}

/** Is the elevated health task installed? */
export function healthTaskInstalled(): boolean {
  if (process.platform !== 'win32') return false;
  const r = spawnSync('schtasks', ['/Query', '/TN', TASK_NAME], { encoding: 'utf8', windowsHide: true });
  return r.status === 0;
}

/** Install the elevated (HIGHEST) weekly health task so the full, admin-level scan runs SILENTLY on
 *  a schedule (writing REPORT_FILE). Creating it needs elevation ONCE (a single UAC prompt); after
 *  that every run - scheduled or on-demand-triggered - is prompt-free. Returns a result + guidance. */
export function installHealthTask(cron: { day?: string; hour?: number } = {}): { ok: boolean; message: string } {
  if (process.platform !== 'win32' || !fs.existsSync(CORE_EXE)) return { ok: false, message: 'Windows only (and the elevated engine must be built).' };
  try { fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true }); } catch { /* the elevated run creates it */ }
  const dayMap: Record<string, string> = { SUN: 'Sunday', MON: 'Monday', TUE: 'Tuesday', WED: 'Wednesday', THU: 'Thursday', FRI: 'Friday', SAT: 'Saturday' };
  const day = dayMap[(cron.day || 'SUN').toUpperCase()] || 'Sunday';
  const hour = String(cron.hour ?? 12).padStart(2, '0');
  const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // Build the task as XML (RunLevel HighestAvailable = elevated) to avoid schtasks /TR quoting issues.
  const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>John the Butler: weekly PC health scan</Description></RegistrationInfo>
  <Triggers><CalendarTrigger><StartBoundary>2024-01-01T${hour}:00:00</StartBoundary><Enabled>true</Enabled>
    <ScheduleByWeek><DaysOfWeek><${day} /></DaysOfWeek><WeeksInterval>1</WeeksInterval></ScheduleByWeek></CalendarTrigger></Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><Enabled>true</Enabled><ExecutionTimeLimit>PT1H</ExecutionTimeLimit></Settings>
  <Actions Context="Author"><Exec><Command>${xmlEsc(CORE_EXE)}</Command><Arguments>--dumpsys "${xmlEsc(REPORT_FILE)}"</Arguments></Exec></Actions>
</Task>`;
  const xmlFile = path.join(os.tmpdir(), `butler-health-task-${process.pid}.xml`);
  fs.writeFileSync(xmlFile, '\uFEFF' + xml, { encoding: 'utf16le' as BufferEncoding });
  // Create it ELEVATED via ShellExecute RunAs, so the user is ASKED for permission once (a single
  // UAC prompt) for the scheduled task. Prompt-free on every run thereafter.
  const psArgs = ['/Create', '/TN', TASK_NAME, '/XML', xmlFile, '/F'].map((a) => `'${a.replace(/'/g, "''")}'`).join(',');
  const ps = `try { Start-Process -FilePath 'schtasks.exe' -ArgumentList ${psArgs} -Verb RunAs -WindowStyle Hidden -Wait -ErrorAction Stop } catch { exit 5 }`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true });
  try { fs.unlinkSync(xmlFile); } catch { /* temp */ }
  if (healthTaskInstalled()) return { ok: true, message: `Very good - a silent weekly health scan is scheduled (${day} ${hour}:00). It runs with the rights it needs and leaves its report where I can read it, no further prompts.` };
  return { ok: false, message: r.status === 5 ? 'The administrator approval was declined, so I could not schedule the weekly maintenance. Approve the prompt to enable it.' : `Could not schedule the weekly maintenance: ${(r.stderr || r.stdout || '').trim().slice(0, 160)}` };
}

/** Trigger the elevated health task now (prompt-free once installed) and wait briefly for its
 *  report. Falls back to a message if the task isn't installed yet. */
export async function runHealthTaskNow(): Promise<{ ok: boolean; report?: Record<string, unknown>; message: string }> {
  if (!healthTaskInstalled()) return { ok: false, message: 'The silent health task is not set up yet - ask me to "set up automatic maintenance" once (a one-time admin approval).' };
  const before = latestHealthReport()?.when ?? 0;
  spawnSync('schtasks', ['/Run', '/TN', TASK_NAME], { encoding: 'utf8', windowsHide: true });
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const cur = latestHealthReport();
    if (cur && cur.when > before) return { ok: true, report: cur.report, message: 'Fresh health report ready.' };
  }
  return { ok: false, message: 'The health scan is taking longer than expected; try reading the latest report shortly.' };
}
