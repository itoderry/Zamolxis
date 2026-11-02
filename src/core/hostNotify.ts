import { spawn } from 'node:child_process';
import { logger } from '../logger.js';

/**
 * Pop a native notification on the machine Zamolxis runs on — a Windows toast, a macOS
 * notification, or a Linux notify-send bubble. This is what makes a watcher alert (new
 * mail, a Jira assignment, a site going down) actually surface on your screen instead of
 * living only in the web UI's toast feed.
 *
 * Best-effort by design: it never throws and never blocks the caller. The title/body are
 * handed over as environment variables / separate argv, never spliced into a shell string,
 * so a subject line full of quotes can't break out.
 */

// A Windows 10/11 toast via WinRT. If that's unavailable (older box, locked-down WinRT) we
// fall back to a classic tray balloon, which works essentially everywhere. The text comes
// in through $env:ZM_TITLE / $env:ZM_BODY so nothing in it is ever interpreted as code.
const WIN_PS = `
$ErrorActionPreference = 'Stop'
try {
  $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $tpl = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
  $t = $tpl.GetElementsByTagName('text')
  $t.Item(0).AppendChild($tpl.CreateTextNode($env:ZM_TITLE)) | Out-Null
  $t.Item(1).AppendChild($tpl.CreateTextNode($env:ZM_BODY)) | Out-Null
  $toast = [Windows.UI.Notifications.ToastNotification]::new($tpl)
  $aid = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aid).Show($toast)
} catch {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $ni = New-Object System.Windows.Forms.NotifyIcon
  $ni.Icon = [System.Drawing.SystemIcons]::Information
  $ni.Visible = $true
  $ni.ShowBalloonTip(6000, $env:ZM_TITLE, $env:ZM_BODY, [System.Windows.Forms.ToolTipIcon]::Info)
  Start-Sleep -Milliseconds 7000
  $ni.Dispose()
}
`;
const WIN_PS_B64 = Buffer.from(WIN_PS, 'utf16le').toString('base64');

export function osNotifyAvailable(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux';
}

export function osNotify(title: string, body: string): void {
  const t = String(title || '').slice(0, 120);
  const b = String(body || '').slice(0, 300);
  if (!t && !b) return;
  try {
    if (process.platform === 'win32') {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', WIN_PS_B64],
        { env: { ...process.env, ZM_TITLE: t, ZM_BODY: b }, windowsHide: true, stdio: 'ignore' },
      );
      child.on('error', () => {}); // best-effort; ignore if powershell isn't reachable
      child.unref();
    } else if (process.platform === 'darwin') {
      // JSON.stringify gives a valid AppleScript double-quoted literal (escapes quotes/backslashes).
      const script = `display notification ${JSON.stringify(b || t)} with title ${JSON.stringify(t || 'Zamolxis')}`;
      const child = spawn('osascript', ['-e', script], { stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
    } else {
      const child = spawn('notify-send', [t || 'Zamolxis', b], { stdio: 'ignore' });
      child.on('error', () => {}); // notify-send may not be installed; that's fine
      child.unref();
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'host OS notification failed');
  }
}
