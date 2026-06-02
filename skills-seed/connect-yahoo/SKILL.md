---
name: connect-yahoo
description: Connect a Yahoo Mail account so Zamolxis can READ it (read_email tool). Exact IMAP/SMTP server settings baked in. Use when the user wants to add/read a Yahoo mailbox.
---

# Connect a Yahoo Mail account (read-only)

Yahoo server settings (no need to look them up):

| | Host | Port | Security |
|---|---|---|---|
| **IMAP (read)** | `imap.mail.yahoo.com` | `993` | SSL/TLS |
| SMTP (send) | `smtp.mail.yahoo.com` | `465` | SSL/TLS |

`read_email` only uses **IMAP**.

## One-time setup the USER must do
Yahoo **requires an app password** for IMAP (your normal password will be rejected):
1. Yahoo Account → **Account security**.
2. **Generate app password** → choose "Other app", name it (e.g. "Zamolxis"). Copy the generated password.

(IMAP is enabled by default on Yahoo Mail.)

## Add the account to `<dataDir>/emails.json`
```json
[
  {
    "name": "yahoo-personal",
    "imapHost": "imap.mail.yahoo.com",
    "imapPort": 993,
    "user": "you@yahoo.com",
    "password": "the-app-password"
  }
]
```
Restart, then: **"any important mail in yahoo-personal today?"** — the agent uses `read_email` with `account: "yahoo-personal"`.

## Notes
- Read-only: never sends, replies, deletes, or marks read.
- Keep the app password in `emails.json`, not in chat.
