// Mirror Zamolxis's scheduled agents into the Windows Task Scheduler, so the OS itself is the
// trigger: each enabled agent schedule becomes a task "Zamolxis\Agent - <name>" whose action runs
// `zamolxis run-agent <name>`. Fires even when the Zamolxis window is closed (run-agent starts the
// service if needed). Only the common cron shapes the pre-made agents use are translated; an
// untranslatable pattern is reported so the caller can leave it on the in-process timer.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { logger } from '../logger.js';

const TN_PREFIX = '\\Zamolxis\\Agent - '; // Task Scheduler folder + name prefix
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface Plan { days: string[]; startH: number; startM: number; intervalMin: number | null; durationH: number; }

/** Translate a 5-field cron into a weekly Windows-task plan, or null if we can't represent it. */
export function cronToPlan(cron: string): Plan | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return null;
  const mn = parts[0]!, hr = parts[1]!, dom = parts[2]!, mon = parts[3]!, dow = parts[4]!;
  if (dom !== '*' || mon !== '*') return null; // day-of-month / month patterns not supported

  // Days of week → XML day names. '*' = every day.
  let days: string[];
  if (dow === '*') days = DOW.slice();
  else {
    const set = new Set<number>();
    for (const tok of dow.split(',')) {
      const m = /^(\d)(?:-(\d))?$/.exec(tok);
      if (!m) return null;
      const a = Number(m[1]) % 7, b = m[2] !== undefined ? Number(m[2]) % 7 : a;
      for (let d = a; ; d = (d + 1) % 7) { set.add(d); if (d === b) break; }
    }
    days = [...set].sort((x, y) => x - y).map((d) => DOW[d]!);
  }

  // Minute: fixed, */N step, or *.
  let minStep: number | null = null, minFixed: number | null = null;
  if (mn === '*') minStep = 1;
  else if (/^\*\/(\d+)$/.test(mn)) minStep = Number(RegExp.$1);
  else if (/^\d+$/.test(mn)) minFixed = Number(mn);
  else return null;

  // Hour: fixed, A-B range, */N step, or *.
  let hStart: number, hEnd: number, hStep: number | null = null;
  if (hr === '*') { hStart = 0; hEnd = 23; }
  else if (/^\*\/(\d+)$/.test(hr)) { hStart = 0; hEnd = 23; hStep = Number(RegExp.$1); } // every N hours, all day
  else if (/^(\d+)-(\d+)$/.test(hr)) { hStart = Number(RegExp.$1); hEnd = Number(RegExp.$2); }
  else if (/^\d+$/.test(hr)) { hStart = hEnd = Number(hr); }
  else return null;

  const startH = hStart;
  let startM = minFixed ?? 0;
  let intervalMin: number | null = null;
  let durationH = hEnd - hStart + 1;
  if (minStep != null) { intervalMin = minStep; }            // every N minutes within the hour window
  else if (hStep != null) { intervalMin = hStep * 60; startM = minFixed ?? 0; } // every N hours at minute M
  else if (hStart !== hEnd) { intervalMin = 60; startM = minFixed ?? 0; } // at minute M of each hour in range
  // else: a single daily time (no repetition)
  if (intervalMin == null) durationH = 1;
  return { days, startH, startM, intervalMin, durationH };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function taskXml(name: string, plan: Plan, nodeExe: string, binPath: string): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  const start = `2024-01-01T${p2(plan.startH)}:${p2(plan.startM)}:00`;
  const rep = plan.intervalMin
    ? `<Repetition><Interval>PT${plan.intervalMin}M</Interval><Duration>${plan.durationH >= 24 ? 'P1D' : `PT${plan.durationH}H`}</Duration><StopAtDurationEnd>true</StopAtDurationEnd></Repetition>`
    : '';
  const daysXml = plan.days.map((d) => `<${d} />`).join('');
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Zamolxis scheduled agent: ${esc(name)}</Description></RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>${start}</StartBoundary>
      <Enabled>true</Enabled>
      ${rep}
      <ScheduleByWeek><DaysOfWeek>${daysXml}</DaysOfWeek><WeeksInterval>1</WeeksInterval></ScheduleByWeek>
    </CalendarTrigger>
  </Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>${esc(nodeExe)}</Command><Arguments>${esc(`"${binPath}" run-agent ${name}`)}</Arguments></Exec>
  </Actions>
</Task>`;
}

/** Create/replace the Windows task for one agent schedule. Returns true on success. */
export function installAgentTask(name: string, cron: string, nodeExe: string, binPath: string): boolean {
  if (process.platform !== 'win32') return false;
  const plan = cronToPlan(cron);
  if (!plan) { logger.warn({ name, cron }, 'cron not translatable to a Windows task — left on the in-process timer'); return false; }
  const xml = taskXml(name, plan, nodeExe, binPath);
  const file = path.join(os.tmpdir(), `zamolxis-task-${name.replace(/[^a-z0-9_-]/gi, '_')}.xml`);
  // schtasks /XML wants UTF-16: write a real UTF-16LE BOM (0xFF 0xFE) followed by the UTF-16LE body.
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]));
  const r = spawnSync('schtasks', ['/Create', '/TN', TN_PREFIX + name, '/XML', file, '/F'], { encoding: 'utf8', windowsHide: true });
  try { fs.unlinkSync(file); } catch { /* temp */ }
  if (r.status !== 0) { logger.warn({ name, err: (r.stderr || r.stdout || '').trim() }, 'schtasks create failed'); return false; }
  return true;
}

export function removeAgentTask(name: string): void {
  if (process.platform !== 'win32') return;
  spawnSync('schtasks', ['/Delete', '/TN', TN_PREFIX + name, '/F'], { encoding: 'utf8', windowsHide: true });
}

/** Enable or DISABLE an agent's task in place (it stays visible in Task Scheduler, just won't
 *  fire) — used when an agent is paused/resumed. */
export function setAgentTaskEnabled(name: string, enabled: boolean): void {
  if (process.platform !== 'win32') return;
  spawnSync('schtasks', ['/Change', '/TN', TN_PREFIX + name, enabled ? '/ENABLE' : '/DISABLE'], { encoding: 'utf8', windowsHide: true });
}

/** Disable (or enable) every Zamolxis agent task at once — backs the "stop all schedules" control.
 *  Returns the affected task count. */
export function setAllAgentTasksEnabled(enabled: boolean): number {
  if (process.platform !== 'win32') return 0;
  const names = listAgentTasks();
  for (const n of names) setAgentTaskEnabled(n, enabled);
  return names.length;
}

/** Names of agents that currently have a Zamolxis task registered. */
export function listAgentTasks(): string[] {
  if (process.platform !== 'win32') return [];
  const r = spawnSync('schtasks', ['/Query', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return [];
  const out: string[] = [];
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    const m = /^"([^"]*\\Zamolxis\\Agent - ([^"]+))"/.exec(line);
    if (m) out.push(m[2]!);
  }
  return [...new Set(out)];
}

/** Sync the set of enabled agent schedules to Windows tasks: install/replace the wanted ones,
 *  remove any stale Zamolxis agent tasks. Returns a summary. */
export function syncAgentTasks(schedules: Array<{ agent: string; cron?: string }>, nodeExe: string, binPath: string): { installed: string[]; skipped: string[]; removed: string[] } {
  const installed: string[] = [], skipped: string[] = [];
  const wanted = new Map<string, string>();
  for (const s of schedules) if (s.agent && s.cron) wanted.set(s.agent, s.cron);
  for (const [name, cron] of wanted) { if (installAgentTask(name, cron, nodeExe, binPath)) installed.push(name); else skipped.push(name); }
  const removed: string[] = [];
  for (const existing of listAgentTasks()) if (!wanted.has(existing)) { removeAgentTask(existing); removed.push(existing); }
  return { installed, skipped, removed };
}

/** Remove every Zamolxis agent task (used when switching back to the in-process timer). */
export function removeAllAgentTasks(): string[] {
  const names = listAgentTasks();
  for (const n of names) removeAgentTask(n);
  return names;
}
