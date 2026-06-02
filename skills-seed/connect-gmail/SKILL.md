---
name: connect-gmail
description: Connect a Gmail account so Zamolxis can READ it (read_email tool). Has the exact IMAP/SMTP server settings baked in — no need to look them up. Use when the user wants to add/read a Gmail / Google Workspace mailbox.
---

# Connect a Gmail account (read-only)

Gmail server settings (you do **not** need to search for these):

| | Host | Port | Security |
|---|---|---|---|
| **IMAP (read)** | `imap.gmail.com` | `993` | SSL/TLS |
| SMTP (send) | `smtp.gmail.com` | `465` | SSL/TLS |

`read_email` only uses **IMAP** — it never sends.

## One-time setup the USER must do
1. Turn on **2-Step Verification** on the Google account (myaccount.google.com → Security).
2. Create an **App Password**: Google Account → Security → **App passwords** → generate one for "Mail". It's a 16-character code. (A normal Google password will NOT work for IMAP.)
3. In Gmail → Settings → **Forwarding and POP/IMAP** → make sure **IMAP is enabled**.

## Add the account to Zamolxis
Add an entry to `<dataDir>/emails.json` (create the file if missing — it's a JSON array). `<dataDir>` is shown in Settings:

```json
[
  {
    "name": "gmail-personal",
    "imapHost": "imap.gmail.com",
    "imapPort": 993,
    "user": "you@gmail.com",
    "password": "the-16-char-app-password"
  }
]
```

Restart Zamolxis. Then in chat: **"summarize my unread emails in gmail-personal"**, or just "what's new in my gmail?". The agent calls `read_email` with `account: "gmail-personal"`.

You can list multiple Gmail (or other) accounts in the same array — each with its own `name`.

## Notes
- Strictly read-only: `read_email` returns sender / subject / date and never marks anything read, sends, or deletes.
- Keep the app password only in `emails.json` on this machine. Never paste it into chat.
