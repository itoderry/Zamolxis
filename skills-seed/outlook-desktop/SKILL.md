---
name: outlook-desktop
description: Read the user's Outlook mailbox through the locally installed classic Outlook desktop app (COM) with the outlook_mail tool - no cloud login, app password, or admin consent needed. Use for "read my outlook", "any new work email?", "find the email from X", "summarize my unread mail".
---

# Outlook desktop (local, read-only)

The `outlook_mail` tool reads the user's mailbox straight from the classic Outlook desktop client installed on this machine. It needs NO cloud credentials and works even when the Microsoft 365 tenant blocks IMAP. It is strictly READ-ONLY: it never sends, replies, deletes, or marks anything as read.

## How to use the tool

- New / unread mail: `outlook_mail` with `action="list"` (defaults: Inbox, unread only, 15 max).
- Recent mail including read: `action="list", unread_only=false`.
- Another folder: add `folder="Sent"` (or `Drafts`, `Deleted`, `Junk`, or any folder by name).
- Find something: `action="search", query="invoice"` - matches subject and sender; add `folder` if needed.
- Read one message: take the `id` (EntryID) from a list/search result, then `action="read", id="..."`.
- What folders exist: `action="folders"`.

## Answering the user

- Summarize lists briefly: sender, subject, date; flag anything urgent-looking.
- To quote or summarize a specific email, `read` it first - list previews are headers only.
- Never claim you acted on mail (replied/deleted/flagged) - you cannot; reading only.

## Requirements / troubleshooting

- Windows with CLASSIC Outlook desktop installed and a configured profile. The "new Outlook" (olk.exe) has no COM interface - the tool will say so.
- First call may be slow (it can start Outlook in the background).
- If Outlook runs elevated and Zamolxis does not (or vice versa), COM is blocked - run both at the same integrity level.
