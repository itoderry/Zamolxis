---
name: browser-history
description: Search the user's local Chrome/Edge/Firefox browsing history and bookmarks with the browser_history tool. Use for "what was that site about X I visited", "find my bookmark for Y", "what did I read about Z last week".
---

# Browser history & bookmarks (local, read-only)

The `browser_history` tool searches the browser profile files on this machine directly. READ-ONLY; nothing leaves the computer.

- History: `browser_history` with `query="topic"` (matches title and URL, newest first, all browsers merged).
- Bookmarks: add `what="bookmarks"`.
- One browser only: `browser="chrome"|"edge"|"firefox"`.

Answer with the page titles + URLs and when they were visited. If nothing matches, suggest a broader query.
