import { spawn } from 'node:child_process';
import { logger } from '../logger.js';

/**
 * READ-ONLY access to the locally installed CLASSIC Outlook desktop client via COM
 * automation (`Outlook.Application`). This needs no cloud credentials, app passwords,
 * or admin/tenant consent — it reads whatever the user's Outlook profile already syncs,
 * so it works even where Microsoft 365 blocks IMAP basic auth.
 *
 * Exposed as the `outlook_mail` tool to BOTH tiers: the Claude SDK tools AND the
 * OpenAI-compatible tool loop, so free/local models can read Outlook too.
 *
 * Requirements: Windows + classic Outlook (the "new Outlook" / olk.exe has no COM API).
 * All user input reaches PowerShell via environment variables — never string-spliced.
 */

const TIMEOUT_MS = 45_000; // first call may have to launch Outlook itself

const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
function Out-Json($o) { Write-Output (ConvertTo-Json $o -Depth 5 -Compress) }
try {
  $ol = New-Object -ComObject Outlook.Application
} catch {
  Out-Json @{ error = 'Outlook COM is unavailable. Classic Outlook desktop must be installed and usable (the *new* Outlook app has no COM interface). If Outlook is running elevated/non-elevated differently from Zamolxis, match them.' }
  exit 0
}
try {
  $ns = $ol.GetNamespace('MAPI')
  function Resolve-Folder([string]$name) {
    if (-not $name -or $name -ieq 'inbox') { return $ns.GetDefaultFolder(6) }
    if ($name -ieq 'sent' -or $name -ieq 'sent items') { return $ns.GetDefaultFolder(5) }
    if ($name -ieq 'drafts') { return $ns.GetDefaultFolder(16) }
    if ($name -ieq 'deleted' -or $name -ieq 'trash' -or $name -ieq 'deleted items') { return $ns.GetDefaultFolder(3) }
    if ($name -ieq 'junk' -or $name -ieq 'spam') { return $ns.GetDefaultFolder(23) }
    $queue = New-Object System.Collections.Queue
    foreach ($s in $ns.Folders) { $queue.Enqueue(@{ f = $s; d = 0 }) }
    while ($queue.Count -gt 0) {
      $x = $queue.Dequeue(); $f = $x.f
      if ($f.Name -ieq $name) { return $f }
      if ($x.d -lt 3) { foreach ($c in $f.Folders) { $queue.Enqueue(@{ f = $c; d = $x.d + 1 }) } }
    }
    return $null
  }
  function Mail-Row($m) {
    [pscustomobject]@{
      subject = [string]$m.Subject
      from = [string]$m.SenderName
      fromAddr = [string]$m.SenderEmailAddress
      received = $m.ReceivedTime.ToString('yyyy-MM-dd HH:mm')
      unread = [bool]$m.UnRead
      id = [string]$m.EntryID
    }
  }
  $action = $env:ZXOL_ACTION
  $count = 0; [void][int]::TryParse($env:ZXOL_COUNT, [ref]$count); if ($count -le 0 -or $count -gt 50) { $count = 15 }

  if ($action -eq 'calendar') {
    $cal = $ns.GetDefaultFolder(9)
    $items = $cal.Items
    $items.IncludeRecurrences = $true
    $items.Sort('[Start]')
    $days = 0; [void][int]::TryParse($env:ZXOL_DAYS, [ref]$days); if ($days -le 0 -or $days -gt 60) { $days = 7 }
    $ci = [System.Globalization.CultureInfo]::GetCultureInfo('en-US')
    $startS = (Get-Date).Date.ToString('MM/dd/yyyy hh:mm tt', $ci)
    $endS = (Get-Date).Date.AddDays($days).ToString('MM/dd/yyyy hh:mm tt', $ci)
    $res = $items.Restrict("[Start] <= '" + $endS + "' AND [End] >= '" + $startS + "'")
    $out = @(); $i = 0
    foreach ($a in $res) {
      try {
        $out += [pscustomobject]@{ subject = [string]$a.Subject; start = $a.Start.ToString('yyyy-MM-dd HH:mm'); end = $a.End.ToString('yyyy-MM-dd HH:mm'); location = [string]$a.Location; organizer = [string]$a.Organizer; allDay = [bool]$a.AllDayEvent }
      } catch {}
      $i++; if ($i -ge 40) { break }
    }
    Out-Json @{ events = $out; days = $days }
    exit 0
  }

  if ($action -eq 'contacts') {
    $cf = $ns.GetDefaultFolder(10)
    $q = $env:ZXOL_QUERY
    $out = @(); $i = 0
    foreach ($c in $cf.Items) {
      if ($c.Class -ne 40) { continue }
      $hay = ('' + $c.FullName + ' ' + $c.CompanyName + ' ' + $c.Email1Address)
      if ($q -and ($hay -inotmatch [regex]::Escape($q))) { continue }
      $out += [pscustomobject]@{ name = [string]$c.FullName; email = [string]$c.Email1Address; phone = [string]$c.BusinessTelephoneNumber; mobile = [string]$c.MobileTelephoneNumber; company = [string]$c.CompanyName }
      $i++; if ($i -ge $count) { break }
    }
    Out-Json @{ contacts = $out }
    exit 0
  }

  if ($action -eq 'tasks') {
    $tf = $ns.GetDefaultFolder(13)
    $res = $tf.Items.Restrict('[Complete] = False')
    $out = @(); $i = 0
    foreach ($t in $res) {
      if ($t.Class -ne 48) { continue }
      $due = ''
      try { if ($t.DueDate.Year -lt 4000) { $due = $t.DueDate.ToString('yyyy-MM-dd') } } catch {}
      $out += [pscustomobject]@{ subject = [string]$t.Subject; due = $due }
      $i++; if ($i -ge $count) { break }
    }
    Out-Json @{ tasks = $out }
    exit 0
  }

  if ($action -eq 'folders') {
    $out = @()
    foreach ($s in $ns.Folders) {
      foreach ($f in $s.Folders) {
        try { $out += [pscustomobject]@{ store = [string]$s.Name; name = [string]$f.Name; items = [int]$f.Items.Count; unread = [int]$f.UnReadItemCount } } catch {}
      }
    }
    Out-Json @{ folders = $out }
    exit 0
  }

  if ($action -eq 'open') {
    $m = $ns.GetItemFromID($env:ZXOL_ID)
    $m.Display($true)
    try { $ol.ActiveWindow().Activate() } catch {}
    Out-Json @{ ok = $true; subject = [string]$m.Subject }
    exit 0
  }

  if ($action -eq 'read') {
    $m = $ns.GetItemFromID($env:ZXOL_ID)
    $body = [string]$m.Body
    if ($body.Length -gt 8000) { $body = $body.Substring(0, 8000) + "\\n...[truncated]" }
    Out-Json @{ message = [pscustomobject]@{
      subject = [string]$m.Subject; from = [string]$m.SenderName; fromAddr = [string]$m.SenderEmailAddress
      to = [string]$m.To; cc = [string]$m.CC; received = $m.ReceivedTime.ToString('yyyy-MM-dd HH:mm')
      unread = [bool]$m.UnRead; body = $body
    } }
    exit 0
  }

  $folder = Resolve-Folder $env:ZXOL_FOLDER
  if ($null -eq $folder) { Out-Json @{ error = ('Folder not found: ' + $env:ZXOL_FOLDER) }; exit 0 }
  $items = $folder.Items
  $items.Sort('[ReceivedTime]', $true)

  if ($action -eq 'search') {
    $q = ($env:ZXOL_QUERY) -replace "'", "''"
    $flt = '@SQL="urn:schemas:httpmail:subject" ci_phrasematch ''' + $q + ''' OR "urn:schemas:httpmail:fromname" ci_phrasematch ''' + $q + ''' OR "urn:schemas:httpmail:fromemail" ci_phrasematch ''' + $q + ''''
    $items = $items.Restrict($flt)
    $items.Sort('[ReceivedTime]', $true)
  } elseif ($env:ZXOL_UNREAD -eq '1') {
    $items = $items.Restrict('[UnRead] = True')
    $items.Sort('[ReceivedTime]', $true)
  }

  $out = @(); $i = 0
  foreach ($m in $items) {
    if ($m.Class -ne 43) { continue } # 43 = olMail
    $out += Mail-Row $m
    $i++; if ($i -ge $count) { break }
  }
  Out-Json @{ folder = [string]$folder.Name; messages = $out }
} catch {
  Out-Json @{ error = [string]$_.Exception.Message }
}
`;

const PS_B64 = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');

export function outlookAvailable(): boolean {
  return process.platform === 'win32';
}

interface OutlookArgs {
  action: string;
  folder?: string;
  count?: number;
  unreadOnly?: boolean;
  query?: string;
  id?: string;
}

function runPs(env: Record<string, string>): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', PS_B64], {
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      resolve(JSON.stringify({ error: 'Outlook did not respond in time (is classic Outlook installed and able to start?)' }));
    }, TIMEOUT_MS);
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out.trim() || JSON.stringify({ error: (err || 'no output from Outlook bridge').slice(0, 400) }));
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve(JSON.stringify({ error: String(e) }));
    });
  });
}

/** STRUCTURED variants for the desktop apps (return parsed bridge JSON, not formatted text). */
export async function outlookMailData(args: OutlookArgs): Promise<Record<string, unknown>> {
  if (!outlookAvailable()) return { error: 'Outlook is only available on this Windows machine.' };
  const action = ['list', 'read', 'search', 'folders'].includes(args.action) ? args.action : 'list';
  const raw = await runPs({
    ZXOL_ACTION: action, ZXOL_FOLDER: args.folder || '', ZXOL_COUNT: String(args.count || 25),
    ZXOL_UNREAD: args.unreadOnly === false ? '0' : action === 'list' ? '1' : '0', ZXOL_QUERY: args.query || '', ZXOL_ID: args.id || '',
  });
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return { error: raw.slice(0, 300) }; }
}
export async function outlookPimData(args: { action: string; days?: number; query?: string; count?: number }): Promise<Record<string, unknown>> {
  if (!outlookAvailable()) return { error: 'Outlook is only available on this Windows machine.' };
  const action = ['calendar', 'contacts', 'tasks'].includes(args.action) ? args.action : 'calendar';
  const raw = await runPs({
    ZXOL_ACTION: action, ZXOL_DAYS: String(args.days || 7), ZXOL_QUERY: args.query || '', ZXOL_COUNT: String(args.count || 50),
    ZXOL_FOLDER: '', ZXOL_UNREAD: '0', ZXOL_ID: '',
  });
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return { error: raw.slice(0, 300) }; }
}

/** Calendar / contacts / tasks from the same local Outlook profile. */
export async function outlookPim(args: { action: string; days?: number; query?: string; count?: number }): Promise<string> {
  if (!outlookAvailable()) return 'outlook_pim only works on the Windows machine where classic Outlook desktop is installed.';
  const action = ['calendar', 'contacts', 'tasks'].includes(args.action) ? args.action : 'calendar';
  const raw = await runPs({
    ZXOL_ACTION: action,
    ZXOL_DAYS: String(args.days || 7),
    ZXOL_QUERY: args.query || '',
    ZXOL_COUNT: String(args.count || 25),
    ZXOL_FOLDER: '',
    ZXOL_UNREAD: '0',
    ZXOL_ID: '',
  });
  let d: { error?: string; days?: number; events?: Array<{ subject: string; start: string; end: string; location: string; organizer: string; allDay: boolean }>; contacts?: Array<{ name: string; email: string; phone: string; mobile: string; company: string }>; tasks?: Array<{ subject: string; due: string }> };
  try {
    d = JSON.parse(raw);
  } catch {
    return 'Outlook bridge error: ' + raw.slice(0, 300);
  }
  if (d.error) return 'Outlook: ' + d.error;
  if (d.events) {
    if (!d.events.length) return `No calendar events in the next ${d.days} day(s).`;
    return `Calendar — next ${d.days} day(s):\n` + d.events.map((e, i) => `${i + 1}. ${e.allDay ? '[all day] ' : ''}${e.start} → ${e.end} — ${e.subject}${e.location ? ' @ ' + e.location : ''}${e.organizer ? ' (organizer: ' + e.organizer + ')' : ''}`).join('\n');
  }
  if (d.contacts) {
    if (!d.contacts.length) return args.query ? `No contacts matching "${args.query}".` : 'No contacts found.';
    return d.contacts.map((c, i) => `${i + 1}. ${c.name}${c.company ? ' — ' + c.company : ''}${c.email ? ' — ' + c.email : ''}${c.phone ? ' — tel ' + c.phone : ''}${c.mobile ? ' — mob ' + c.mobile : ''}`).join('\n');
  }
  if (d.tasks) {
    if (!d.tasks.length) return 'No open tasks.';
    return 'Open tasks:\n' + d.tasks.map((t, i) => `${i + 1}. ${t.subject}${t.due ? ' (due ' + t.due + ')' : ''}`).join('\n');
  }
  return 'No data.';
}

/** Open (Display) a message in the Outlook desktop client by its EntryID. Powers the
 *  clickable "open in Outlook" link the Mail Sentinel attaches to each email. */
export async function outlookOpen(id: string): Promise<{ ok: boolean; subject?: string; error?: string }> {
  if (!outlookAvailable()) return { ok: false, error: 'Outlook is only available on this Windows machine.' };
  if (!id) return { ok: false, error: 'missing message id' };
  const raw = await runPs({ ZXOL_ACTION: 'open', ZXOL_ID: id, ZXOL_FOLDER: '', ZXOL_COUNT: '0', ZXOL_UNREAD: '0', ZXOL_QUERY: '' });
  try {
    const d = JSON.parse(raw) as { ok?: boolean; subject?: string; error?: string };
    return d.error ? { ok: false, error: d.error } : { ok: true, subject: d.subject };
  } catch {
    return { ok: false, error: raw.slice(0, 200) };
  }
}

/** Run an Outlook mail action and return model-friendly TEXT. */
export async function outlookMail(args: OutlookArgs): Promise<string> {
  if (!outlookAvailable()) return 'outlook_mail only works on the Windows machine where classic Outlook desktop is installed.';
  const action = ['list', 'read', 'search', 'folders'].includes(args.action) ? args.action : 'list';
  if (action === 'read' && !args.id) return 'Pass `id` (an EntryID from a previous list/search) to read a message.';
  if (action === 'search' && !args.query) return 'Pass `query` to search (matches subject and sender).';
  const raw = await runPs({
    ZXOL_ACTION: action,
    ZXOL_FOLDER: args.folder || '',
    ZXOL_COUNT: String(args.count || 15),
    ZXOL_UNREAD: args.unreadOnly === false ? '0' : action === 'list' ? '1' : '0',
    ZXOL_QUERY: args.query || '',
    ZXOL_ID: args.id || '',
  });
  let d: { error?: string; folders?: Array<{ store: string; name: string; items: number; unread: number }>; folder?: string; messages?: Array<{ subject: string; from: string; fromAddr: string; received: string; unread: boolean; id: string }>; message?: { subject: string; from: string; fromAddr: string; to: string; cc: string; received: string; body: string } };
  try {
    d = JSON.parse(raw);
  } catch {
    logger.warn({ raw: raw.slice(0, 300) }, 'outlook bridge returned non-JSON');
    return 'Outlook bridge error: ' + raw.slice(0, 300);
  }
  if (d.error) return 'Outlook: ' + d.error;
  if (d.folders) {
    if (!d.folders.length) return 'No folders found.';
    return d.folders.map((f) => `${f.store} / ${f.name} — ${f.items} items, ${f.unread} unread`).join('\n');
  }
  if (d.message) {
    const m = d.message;
    return `From: ${m.from} <${m.fromAddr}>\nTo: ${m.to}${m.cc ? `\nCc: ${m.cc}` : ''}\nDate: ${m.received}\nSubject: ${m.subject}\n\n${m.body}`;
  }
  const msgs = d.messages ?? [];
  if (!msgs.length) return action === 'search' ? `No messages matching "${args.query}" in ${d.folder || 'Inbox'}.` : `No ${args.unreadOnly === false ? '' : 'unread '}messages in ${d.folder || 'Inbox'}.`;
  return (
    `${d.folder || 'Inbox'} — ${msgs.length} message(s):\n` +
    msgs.map((m, i) => `${i + 1}. ${m.unread ? '[unread] ' : ''}${m.received} — ${m.from} <${m.fromAddr}>\n   ${m.subject}\n   Open in Outlook: /api/outlook/open?id=${encodeURIComponent(m.id)}`).join('\n')
  );
}
