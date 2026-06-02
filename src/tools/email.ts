import fs from 'node:fs';
import path from 'node:path';
import { ImapFlow } from 'imapflow';

/**
 * READ-ONLY inbox access for the `read_email` tool. Supports MULTIPLE named accounts so
 * different agents can read different mailboxes (e.g. a Gmail, a Hotmail, a Yahoo).
 *
 * Accounts come from <dataDir>/emails.json:
 *   [ { "name": "gmail-personal", "imapHost": "imap.gmail.com", "imapPort": 993,
 *       "user": "me@gmail.com", "password": "APP-PASSWORD" }, ... ]
 * A single default account may also be set via EMAIL_USER / EMAIL_PASSWORD / EMAIL_IMAP_HOST.
 *
 * Strictly read-only: ENVELOPE-only fetch (does not set \Seen); never sends/replies/deletes.
 */
export interface EmailAccount {
  name: string;
  imapHost: string;
  imapPort?: number;
  user: string;
  password: string;
}

export interface InboxItem {
  from: string;
  subject: string;
  date: string;
}

interface Conn {
  host: string;
  port: number;
  user: string;
  pass: string;
}

/** IMAP presets so the user only provides email + app password for the common providers. */
const PRESETS: Record<string, { imapHost: string; imapPort: number }> = {
  gmail: { imapHost: 'imap.gmail.com', imapPort: 993 },
  googlemail: { imapHost: 'imap.gmail.com', imapPort: 993 },
  outlook: { imapHost: 'outlook.office365.com', imapPort: 993 },
  hotmail: { imapHost: 'outlook.office365.com', imapPort: 993 },
  live: { imapHost: 'outlook.office365.com', imapPort: 993 },
  office365: { imapHost: 'outlook.office365.com', imapPort: 993 },
  yahoo: { imapHost: 'imap.mail.yahoo.com', imapPort: 993 },
  icloud: { imapHost: 'imap.mail.me.com', imapPort: 993 },
  fastmail: { imapHost: 'imap.fastmail.com', imapPort: 993 },
  zoho: { imapHost: 'imap.zoho.com', imapPort: 993 },
};

/** Guess a provider from the email domain (so the user can skip even naming it). */
function presetFromEmail(user: string): { imapHost: string; imapPort: number } | undefined {
  const dom = (user.split('@')[1] || '').toLowerCase();
  if (/gmail|googlemail/.test(dom)) return PRESETS.gmail;
  if (/outlook|hotmail|live|msn/.test(dom)) return PRESETS.outlook;
  if (/yahoo|ymail/.test(dom)) return PRESETS.yahoo;
  if (/icloud|me\.com|mac\.com/.test(dom)) return PRESETS.icloud;
  if (/fastmail/.test(dom)) return PRESETS.fastmail;
  if (/zoho/.test(dom)) return PRESETS.zoho;
  return undefined;
}

/** Add (or replace) an account in <dataDir>/emails.json. Resolves host/port from a provider
 *  preset or the email domain when not given explicitly. Never logs/returns the password. */
export function addAccount(
  dataDir: string,
  input: { name?: string; provider?: string; user: string; password: string; imapHost?: string; imapPort?: number },
): { ok: boolean; name?: string; imapHost?: string; error?: string } {
  if (!input.user || !input.password) return { ok: false, error: 'user (email) and password are required' };
  let host = input.imapHost;
  let port = input.imapPort;
  if (!host && input.provider && PRESETS[input.provider.toLowerCase()]) {
    host = PRESETS[input.provider.toLowerCase()]!.imapHost;
    port = port ?? PRESETS[input.provider.toLowerCase()]!.imapPort;
  }
  if (!host) {
    const g = presetFromEmail(input.user);
    if (g) { host = g.imapHost; port = port ?? g.imapPort; }
  }
  if (!host) return { ok: false, error: 'Could not determine the IMAP server. Pass provider (gmail/outlook/yahoo/...) or imapHost.' };
  const name = (input.name || input.user.split('@')[0] || 'account').toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  const acct: EmailAccount = { name, imapHost: host, imapPort: port ?? 993, user: input.user, password: input.password };
  const file = path.join(dataDir, 'emails.json');
  const list = loadAccounts(dataDir).filter((a) => a.name !== name);
  list.push(acct);
  try {
    fs.writeFileSync(file, JSON.stringify(list, null, 2));
  } catch (err) {
    return { ok: false, error: String(err) };
  }
  return { ok: true, name, imapHost: host };
}

export function loadAccounts(dataDir: string): EmailAccount[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'emails.json'), 'utf8'));
    if (Array.isArray(raw)) {
      return raw.filter((a) => a && a.name && a.imapHost && a.user && a.password) as EmailAccount[];
    }
  } catch {
    /* no file / bad json */
  }
  return [];
}

function envAccount(): Conn | null {
  if (process.env.EMAIL_USER && process.env.EMAIL_PASSWORD && process.env.EMAIL_IMAP_HOST) {
    return {
      host: process.env.EMAIL_IMAP_HOST,
      port: Number(process.env.EMAIL_IMAP_PORT ?? 993),
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD,
    };
  }
  return null;
}

/** Names of all usable accounts (file accounts + a 'default' if EMAIL_* env is set). */
export function listAccountNames(dataDir: string): string[] {
  const names = loadAccounts(dataDir).map((a) => a.name);
  if (envAccount()) names.unshift('default');
  return names;
}

/** Resolve a connection for an (optional) account name. Returns null if it can't be determined. */
export function resolveAccount(dataDir: string, name?: string): Conn | null {
  const accts = loadAccounts(dataDir);
  const env = envAccount();
  if (name) {
    if (env && name.toLowerCase() === 'default') return env;
    const a = accts.find((x) => x.name.toLowerCase() === name.toLowerCase());
    return a ? { host: a.imapHost, port: Number(a.imapPort ?? 993), user: a.user, pass: a.password } : null;
  }
  // No name given: use the single account if there's exactly one, else null (ambiguous).
  if (accts.length === 1 && !env) return { host: accts[0]!.imapHost, port: Number(accts[0]!.imapPort ?? 993), user: accts[0]!.user, pass: accts[0]!.password };
  if (env && accts.length === 0) return env;
  return null;
}

export async function readInbox(conn: Conn, opts: { unreadOnly?: boolean; limit?: number; search?: string }): Promise<InboxItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 15, 1), 50);
  const client = new ImapFlow({ host: conn.host, port: conn.port, secure: true, auth: { user: conn.user, pass: conn.pass }, logger: false });
  const out: InboxItem[] = [];
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const criteria = opts.unreadOnly === false ? { all: true } : { seen: false };
    const uids = (await client.search(criteria, { uid: true })) || [];
    const pick = uids.slice(-limit).reverse(); // newest first
    if (pick.length) {
      // ENVELOPE-only fetch: headers without setting \Seen, so the inbox is unchanged.
      for await (const msg of client.fetch(pick.join(','), { envelope: true }, { uid: true })) {
        const env = msg.envelope;
        const f = env?.from?.[0];
        const from = (f?.name || f?.address || '(unknown sender)').trim();
        const subject = (env?.subject || '(no subject)').trim();
        const date = env?.date ? new Date(env.date).toISOString() : '';
        if (opts.search && !`${from} ${subject}`.toLowerCase().includes(opts.search.toLowerCase())) continue;
        out.push({ from, subject, date });
      }
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  return out;
}
