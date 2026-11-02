/** In-memory notification feed pushed to the desktop (toasts / browser notifications). */
import { osNotify } from './hostNotify.js';

export interface Notif { id: number; ts: number; title: string; body: string; kind?: string }
let seq = 0;
const ring: Notif[] = [];

// Whether alerts also pop a NATIVE OS notification (Windows toast / mac / Linux), not just
// the in-app feed. On by default; the Proactive settings toggle and watchers.json drive it
// (ZAMOLXIS_OS_NOTIFICATIONS=0 turns the startup default off).
let osNotifyEnabled = process.env.ZAMOLXIS_OS_NOTIFICATIONS !== '0';
export function setOsNotify(on: boolean): void { osNotifyEnabled = on; }
export function getOsNotify(): boolean { return osNotifyEnabled; }

export function pushNotif(title: string, body: string, kind?: string): Notif {
  const n: Notif = { id: ++seq, ts: Date.now(), title: String(title || '').slice(0, 200), body: String(body || '').slice(0, 500), kind };
  ring.push(n);
  if (ring.length > 100) ring.splice(0, ring.length - 100);
  // Also surface it on the host OS so you see it even when the web UI isn't in focus.
  if (osNotifyEnabled) osNotify(n.title, n.body);
  return n;
}
export function notifsSince(since: number): Notif[] {
  return ring.filter((n) => n.id > since);
}
export function latestNotifId(): number { return seq; }
