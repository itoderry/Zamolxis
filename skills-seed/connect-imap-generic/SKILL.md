---
name: connect-imap-generic
description: Connect ANY other email provider (custom domain, ISP, Fastmail, Proton Bridge, etc.) so Zamolxis can READ it. Use when the provider isn't Gmail/Outlook/Yahoo and the user must supply the IMAP server settings.
---

# Connect any IMAP mailbox (read-only)

For providers without a built-in preset, the **user supplies the IMAP server settings**. `read_email` only needs IMAP (it never sends).

## What to find (from the provider's help, usually titled "IMAP settings" or "email client setup")
- **IMAP host** — e.g. `imap.fastmail.com`, `mail.yourdomain.com`, `127.0.0.1` (Proton Bridge).
- **IMAP port** — almost always **993** (SSL/TLS). Some use 143 (STARTTLS) — prefer 993 if offered.
- **Username** — usually the full email address.
- **Password** — an **app-specific password** if the provider supports 2FA; otherwise the mailbox password.

Common presets, if useful:
| Provider | IMAP host | Port |
|---|---|---|
| Fastmail | `imap.fastmail.com` | 993 |
| iCloud Mail | `imap.mail.me.com` | 993 |
| Proton (via Bridge) | `127.0.0.1` | 1143 |
| Zoho | `imap.zoho.com` | 993 |

## Add the account to `<dataDir>/emails.json`
```json
[
  {
    "name": "work-imap",
    "imapHost": "imap.yourprovider.com",
    "imapPort": 993,
    "user": "you@yourdomain.com",
    "password": "app-or-mailbox-password"
  }
]
```
Restart, then ask about `work-imap`. Run `list_email_accounts` to see all configured names.

## Notes
- Read-only (`read_email`): sender / subject / date only; never sends, replies, deletes, or marks read.
- This build supports IMAP (not legacy POP3). Almost every provider offers IMAP — use it.
- Keep passwords in `emails.json`, never in chat.
