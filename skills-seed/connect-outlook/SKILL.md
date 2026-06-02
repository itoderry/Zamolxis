---
name: connect-outlook
description: Connect an Outlook / Hotmail / Live / Microsoft 365 account so Zamolxis can READ it (read_email tool). Exact IMAP/SMTP server settings baked in. Use when the user wants to add/read a Hotmail or Outlook mailbox.
---

# Connect an Outlook / Hotmail account (read-only)

Covers @outlook.com, @hotmail.com, @live.com, and Microsoft 365. Server settings (no need to look them up):

| | Host | Port | Security |
|---|---|---|---|
| **IMAP (read)** | `outlook.office365.com` | `993` | SSL/TLS |
| SMTP (send) | `smtp.office365.com` | `587` | STARTTLS |

`read_email` only uses **IMAP**.

## One-time setup the USER must do
1. Turn on **two-step verification** for the Microsoft account (account.microsoft.com → Security).
2. Create an **App password**: Microsoft account → Security → **Advanced security options** → **App passwords** → create one. Use that (not your normal password) for IMAP.
3. Make sure **IMAP access is enabled** (Outlook.com → Settings → Mail → Sync email → POP and IMAP → IMAP **On**).

> If your organization's Microsoft 365 tenant has disabled basic/app-password auth, IMAP may be blocked by an admin — in that case use a personal Outlook/Hotmail address or ask your admin.

## Add the account to `<dataDir>/emails.json`
```json
[
  {
    "name": "hotmail-personal",
    "imapHost": "outlook.office365.com",
    "imapPort": 993,
    "user": "you@hotmail.com",
    "password": "the-app-password"
  }
]
```
Restart, then: **"read my hotmail-personal unread emails"**. The agent passes `account: "hotmail-personal"` to `read_email`.

## Notes
- Read-only: never sends, replies, deletes, or marks read.
- Keep the app password in `emails.json`, not in chat.
