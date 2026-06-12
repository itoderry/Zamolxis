import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, openWithOs, dataDir } from './localApps.js';

/**
 * Bridges to more installed apps (all read-only or user-initiated, both model tiers):
 *  - open_in_word / open_in_powerpoint — generate a real .docx/.pptx and open it
 *  - open_app — open a file in VS Code / Notepad++ / WinMerge / Acrobat / VLC / default
 *  - scan_document — acquire a page from a scanner (Windows WIA)
 *  - itunes — control / search the iTunes music library (COM)
 *  - system_status — GPU (nvidia-smi), VPN (netbird), RAM
 *  - steam_games — list installed Steam games
 *  - sticky_notes — read Windows Sticky Notes
 *  - autohotkey — run an AutoHotkey script (user-requested desktop automation)
 * COM/PowerShell bridges pass args via env + -EncodedCommand (no shell string-splicing).
 */

const WIN = process.platform === 'win32';
function exportsDir(): string { const d = path.join(dataDir() || os.tmpdir(), 'exports'); fs.mkdirSync(d, { recursive: true }); return d; }
function stampFile(name: string, ext: string): string { return path.join(exportsDir(), (name || 'file').replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 50) + '-' + Date.now() + ext); }
function escHtml(s: string): string { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function runPs(script: string, env: Record<string, string>, timeout = 50_000): Promise<{ out: string; err: string; code: number | null }> {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], env, timeout);
}

// ── Word ──
export async function openInWord(args: { html?: string; text?: string; title?: string; file?: string }): Promise<string> {
  if (args.file) { try { fs.accessSync(args.file); } catch { return 'File not found: ' + args.file; } openWithOs(args.file); return 'Opened ' + args.file + ' in Word.'; }
  const bodyHtml = args.html || ('<p>' + escHtml(String(args.text || '')).replace(/\n/g, '</p><p>') + '</p>');
  try {
    const mod = (await import('html-to-docx')) as unknown as { default?: unknown };
    const fn = ((mod.default || mod) as (h: string) => Promise<Buffer | ArrayBuffer>);
    const buf = await fn('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>' + bodyHtml + '</body></html>');
    const file = stampFile(args.title || 'document', '.docx');
    fs.writeFileSync(file, Buffer.isBuffer(buf) ? buf : Buffer.from(buf as ArrayBuffer));
    openWithOs(file);
    return 'Created ' + file + ' and opened it in Word.';
  } catch (e) { return 'Could not create the document: ' + String((e as Error)?.message || e); }
}

// ── PowerPoint ──
export async function openInPowerpoint(args: { title?: string; slides?: Array<{ title?: string; bullets?: string[]; text?: string }>; file?: string }): Promise<string> {
  if (args.file) { try { fs.accessSync(args.file); } catch { return 'File not found: ' + args.file; } openWithOs(args.file); return 'Opened ' + args.file + ' in PowerPoint.'; }
  const slides = args.slides || [];
  if (!slides.length) return 'Pass slides (array of {title, bullets|text}) or a file path.';
  try {
    const mod = (await import('pptxgenjs')) as unknown as { default?: unknown };
    const Pptx = (mod.default || mod) as new () => { addSlide: () => { addText: (t: unknown, o: unknown) => void }; writeFile: (o: { fileName: string }) => Promise<string> };
    const p = new Pptx();
    slides.forEach((s) => {
      const sl = p.addSlide();
      if (s.title) sl.addText(String(s.title), { x: 0.5, y: 0.3, w: 9, h: 0.8, fontSize: 28, bold: true });
      const lines = s.bullets && s.bullets.length ? s.bullets.map((b) => ({ text: String(b), options: { bullet: true } })) : (s.text ? [{ text: String(s.text) }] : []);
      if (lines.length) sl.addText(lines, { x: 0.7, y: 1.3, w: 8.6, h: 5, fontSize: 18, valign: 'top' });
    });
    const file = stampFile(args.title || 'presentation', '.pptx');
    await p.writeFile({ fileName: file });
    openWithOs(file);
    return 'Created ' + file + ' (' + slides.length + ' slides) and opened it in PowerPoint.';
  } catch (e) { return 'Could not create the presentation: ' + String((e as Error)?.message || e); }
}

// ── open_app ──
function appPath(app: string): string | null {
  const m: Record<string, string[]> = {
    'notepad++': ['C:\\Program Files\\Notepad++\\notepad++.exe', 'C:\\Program Files (x86)\\Notepad++\\notepad++.exe'],
    winmerge: ['C:\\Program Files\\WinMerge\\WinMergeU.exe'],
    acrobat: ['C:\\Program Files\\Adobe\\Acrobat DC\\Acrobat\\Acrobat.exe', 'C:\\Program Files (x86)\\Adobe\\Acrobat DC\\Acrobat\\Acrobat.exe'],
    vlc: ['C:\\Program Files\\VideoLAN\\VLC\\vlc.exe', 'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe', '/Applications/VLC.app/Contents/MacOS/VLC'],
  };
  for (const c of (m[app] || [])) { try { fs.accessSync(c); return c; } catch { /* next */ } }
  return null;
}
export async function openApp(args: { app?: string; file?: string; file2?: string }): Promise<string> {
  const app = (args.app || 'default').toLowerCase();
  if (app === 'default' || app === 'explorer' || app === 'finder') { if (!args.file) return 'Pass file.'; openWithOs(args.file); return 'Opened ' + args.file + '.'; }
  if (app === 'vscode' || app === 'code') {
    const a = args.file ? [args.file] : [];
    try { spawn(WIN ? 'code.cmd' : 'code', a, { detached: true, windowsHide: true, shell: WIN }).unref(); return 'Opened ' + (args.file || 'VS Code') + ' in VS Code.'; } catch (e) { return 'VS Code launch failed: ' + String(e); }
  }
  const p = appPath(app);
  if (!p) return 'App not found/supported: ' + app + '. Supported: vscode, notepad++, winmerge, acrobat, vlc, default.';
  const a = app === 'winmerge' ? [args.file, args.file2].filter(Boolean) as string[] : (args.file ? [args.file] : []);
  spawn(p, a, { detached: true, windowsHide: true }).unref();
  return 'Opened ' + (args.file || app) + ' in ' + app + '.';
}

// ── Scanner (WIA) ──
const SCAN_PS = `
$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8
function J($o){ Write-Output (ConvertTo-Json $o -Compress) }
try { $d = New-Object -ComObject WIA.CommonDialog } catch { J @{error='WIA scanning unavailable.'}; exit 0 }
try {
  $img = $d.ShowAcquireImage()
  if($null -eq $img){ J @{error='No image acquired (no scanner, or cancelled).'}; exit 0 }
  $out=$env:ZXSCAN_OUT
  if(Test-Path $out){ Remove-Item $out -Force }
  $img.SaveFile($out)
  J @{ok=$true; file=$out}
} catch { J @{error=[string]$_.Exception.Message} }
`;
export async function scanDocument(args: { dest?: string }): Promise<string> {
  if (!WIN) return 'Scanning is Windows-only (WIA).';
  const out = args.dest || stampFile('scan', '.jpg');
  const r = await runPs(SCAN_PS, { ZXSCAN_OUT: out }, 90_000);
  let d: { ok?: boolean; error?: string; file?: string };
  try { d = JSON.parse(r.out.trim()); } catch { return 'Scan bridge error: ' + (r.err || r.out).slice(0, 200); }
  if (d.error) return 'Scanner: ' + d.error;
  openWithOs(out);
  return 'Scanned to ' + out + ' and opened it.';
}

// ── iTunes (COM) ──
const ITUNES_PS = `
$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8
function J($o){ Write-Output (ConvertTo-Json $o -Depth 4 -Compress) }
try { $it = New-Object -ComObject iTunes.Application } catch { J @{error='iTunes is not available.'}; exit 0 }
try {
  $a=$env:ZXIT_ACTION
  if($a -eq 'play'){ $it.Play() } elseif($a -eq 'pause'){ $it.Pause() } elseif($a -eq 'next'){ $it.NextTrack() } elseif($a -eq 'previous'){ $it.PreviousTrack() }
  elseif($a -eq 'search'){
    $q=$env:ZXIT_QUERY; $out=@(); $i=0
    foreach($t in $it.LibraryPlaylist.Tracks){ if((''+$t.Name+' '+$t.Artist) -imatch [regex]::Escape($q)){ $out+=[pscustomobject]@{name=[string]$t.Name;artist=[string]$t.Artist;album=[string]$t.Album}; $i++; if($i -ge 25){break} } }
    J @{tracks=$out}; exit 0
  }
  $cur=$it.CurrentTrack; $tk=''
  if($cur){ $tk = [string]$cur.Artist + ' - ' + [string]$cur.Name }
  J @{ state=[string]$it.PlayerState; track=$tk }
} catch { J @{error=[string]$_.Exception.Message} }
`;
export async function itunes(args: { action?: string; query?: string }): Promise<string> {
  if (!WIN) return 'iTunes control is Windows-only.';
  const action = ['play', 'pause', 'next', 'previous', 'search', 'status'].includes(args.action || '') ? args.action! : 'status';
  if (action === 'search' && !args.query) return 'Pass query to search the library.';
  const r = await runPs(ITUNES_PS, { ZXIT_ACTION: action, ZXIT_QUERY: args.query || '' });
  let d: { error?: string; tracks?: Array<{ name: string; artist: string; album: string }>; state?: string; track?: string };
  try { d = JSON.parse(r.out.trim()); } catch { return 'iTunes bridge error: ' + (r.err || r.out).slice(0, 200); }
  if (d.error) return 'iTunes: ' + d.error;
  if (d.tracks) return d.tracks.length ? d.tracks.map((t, i) => `${i + 1}. ${t.artist} — ${t.name}${t.album ? ' (' + t.album + ')' : ''}`).join('\n') : `No tracks matching "${args.query}".`;
  return (action === 'status' ? 'iTunes' : action) + ': ' + (d.track || '(no track)') + (d.state ? ' [' + d.state + ']' : '');
}

// ── system_status ──
export async function systemStatus(): Promise<string> {
  const lines: string[] = [];
  lines.push('RAM: ' + Math.round(os.totalmem() / 1e9) + ' GB total, ~' + Math.round(os.freemem() / 1e9) + ' GB free; CPU load ' + os.loadavg().map((n) => n.toFixed(1)).join('/'));
  try {
    const g = await run('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits'], undefined, 8000);
    if (g.code === 0 && g.out.trim()) g.out.trim().split(/\r?\n/).forEach((l) => { const p = l.split(',').map((s) => s.trim()); lines.push(`GPU: ${p[0]} — ${p[1]}% util, ${p[2]}/${p[3]} MB, ${p[4]}°C`); });
  } catch { /* no gpu */ }
  try {
    const n = await run('netbird', ['status'], undefined, 8000);
    if (n.out) { const ip = /NetBird IP:\s*(\S+)/i.exec(n.out); const connected = /Management:\s*Connected|Status:\s*Connected|Daemon status:\s*Connected/i.test(n.out) || /\bConnected\b/i.test(n.out); lines.push('Netbird VPN: ' + (connected ? 'connected' : 'disconnected') + (ip ? ' (' + ip[1] + ')' : '')); }
  } catch { /* no netbird */ }
  return lines.join('\n');
}

// ── Steam ──
export function steamAvailable(): boolean {
  return ['C:\\Program Files (x86)\\Steam\\steamapps', 'C:\\Program Files\\Steam\\steamapps'].some((d) => { try { fs.accessSync(d); return true; } catch { return false; } });
}
export function steamGames(): string {
  const names: string[] = [];
  const scan = (dir: string): void => { try { fs.readdirSync(dir).filter((f) => /^appmanifest_.*\.acf$/.test(f)).forEach((f) => { const m = /"name"\s*"([^"]+)"/.exec(fs.readFileSync(path.join(dir, f), 'utf8')); if (m) names.push(m[1]!); }); } catch { /* */ } };
  const roots = ['C:\\Program Files (x86)\\Steam\\steamapps', 'C:\\Program Files\\Steam\\steamapps'];
  roots.forEach(scan);
  for (const r of roots) { try { const t = fs.readFileSync(path.join(r, 'libraryfolders.vdf'), 'utf8'); const re = /"path"\s*"([^"]+)"/g; let m; while ((m = re.exec(t))) scan(path.join(m[1]!.replace(/\\\\/g, '\\'), 'steamapps')); } catch { /* */ } }
  const uniq = [...new Set(names)].sort();
  return uniq.length ? `Installed Steam games (${uniq.length}):\n` + uniq.map((n) => '- ' + n).join('\n') : 'No installed Steam games found.';
}

// ── Sticky Notes ──
function stickyDb(): string | null {
  const p = path.join(process.env.LOCALAPPDATA || '', 'Packages', 'Microsoft.MicrosoftStickyNotes_8wekyb3d8bbwe', 'LocalState', 'plum.sqlite');
  try { fs.accessSync(p); return p; } catch { return null; }
}
export function stickyAvailable(): boolean { return !!stickyDb(); }
export async function stickyNotes(): Promise<string> {
  const db = stickyDb();
  if (!db) return 'No Sticky Notes database found (the app may not be set up).';
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const tmp = path.join(os.tmpdir(), 'zx-sn-' + Date.now() + '.db'); fs.copyFileSync(db, tmp);
    const d = new DatabaseSync(tmp, { readOnly: true });
    let rows: Array<{ Text: string }> = [];
    try { rows = d.prepare("SELECT Text FROM Note WHERE Text IS NOT NULL AND Text != '' ORDER BY UpdatedAt DESC LIMIT 50").all() as Array<{ Text: string }>; } catch { rows = []; }
    d.close(); try { fs.unlinkSync(tmp); } catch { /* */ }
    if (!rows.length) return 'No sticky notes.';
    return rows.map((r, i) => `${i + 1}. ${String(r.Text).replace(/\s+/g, ' ').slice(0, 200)}`).join('\n');
  } catch (e) { return 'Could not read sticky notes: ' + String((e as Error)?.message || e); }
}

// ── AutoHotkey ──
function ahkPath(): string | null {
  for (const c of ['C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey.exe', 'C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey64.exe', 'C:\\Program Files\\AutoHotkey\\AutoHotkey.exe', 'C:\\Program Files (x86)\\AutoHotkey\\AutoHotkey.exe']) { try { fs.accessSync(c); return c; } catch { /* */ } }
  return null;
}
export function ahkAvailable(): boolean { return !!ahkPath(); }
export async function autohotkey(args: { script?: string; file?: string }): Promise<string> {
  const exe = ahkPath();
  if (!exe) return 'AutoHotkey is not installed.';
  let file = args.file;
  if (!file) { if (!args.script) return 'Pass script (AHK code) or file (.ahk path).'; file = stampFile('zx', '.ahk'); fs.writeFileSync(file, args.script, 'utf8'); }
  try { spawn(exe, [file], { detached: true, windowsHide: true }).unref(); } catch (e) { return 'AutoHotkey launch failed: ' + String(e); }
  return 'Running AutoHotkey script (' + file + ').';
}
