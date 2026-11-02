import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.js';

/**
 * Start-on-login (autostart) registration. Windows uses the per-user "Run" registry key
 * (HKCU\...\Run) so no elevation is needed; the entry runs `zamolxis start`, which spawns the
 * daemon detached and exits. macOS/Linux are not wired yet (reported as unsupported).
 */
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const VALUE = 'Zamolxis';

/** `"<node>" "<bin>" start` — absolute paths so it works at login regardless of PATH. */
function startCommand(): string {
  const node = process.execPath;
  const bin = fileURLToPath(new URL('../../bin/zamolxis.mjs', import.meta.url));
  return `"${node}" "${bin}" start`;
}

export function autostartStatus(): { supported: boolean; enabled: boolean; note: string } {
  if (process.platform !== 'win32') {
    return { supported: false, enabled: false, note: 'Start-on-login is currently supported on Windows only.' };
  }
  try {
    // stderr is dropped: when the value is absent `reg query` prints "unable to find the specified
    // registry key" to the parent's stderr (execFileSync inherits stderr unless told otherwise).
    const out = execFileSync('reg', ['query', RUN_KEY, '/v', VALUE], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    return { supported: true, enabled: new RegExp(VALUE, 'i').test(out), note: 'Zamolxis starts when you log in.' };
  } catch {
    // `reg query` exits non-zero when the value is absent.
    return { supported: true, enabled: false, note: 'Not set to start at login.' };
  }
}

export function setAutostart(enabled: boolean): { ok: boolean; enabled: boolean; note: string } {
  if (process.platform !== 'win32') {
    return { ok: false, enabled: false, note: 'Start-on-login is supported on Windows only for now.' };
  }
  try {
    if (enabled) {
      execFileSync('reg', ['add', RUN_KEY, '/v', VALUE, '/t', 'REG_SZ', '/d', startCommand(), '/f'], { stdio: 'ignore' });
      logger.info('autostart enabled (HKCU Run)');
      return { ok: true, enabled: true, note: 'Zamolxis will start automatically when you log in.' };
    }
    try {
      execFileSync('reg', ['delete', RUN_KEY, '/v', VALUE, '/f'], { stdio: 'ignore' });
    } catch {
      /* value already absent — fine */
    }
    logger.info('autostart disabled');
    return { ok: true, enabled: false, note: 'Start-on-login turned off.' };
  } catch (err) {
    logger.warn({ err: String(err) }, 'autostart change failed');
    return { ok: false, enabled: autostartStatus().enabled, note: 'Could not change start-on-login: ' + String(err) };
  }
}
