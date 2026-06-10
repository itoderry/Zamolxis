---
name: onenote-notes
description: Read and search the user's OneNote notebooks via the local desktop OneNote (onenote_read tool). Use for "what do my notes say about X", "find my note about Y", "read my <page> note".
---

# OneNote (local, read-only)

The `onenote_read` tool reads desktop OneNote's notebooks via COM - no cloud login. READ-ONLY.

- `action="notebooks"` - every page as notebook / section / page with its id.
- `action="search", query="..."` - find pages containing the text.
- `action="read", id="..."` - the full text of one page (id comes from notebooks/search).

To answer a question from notes: search first, then read the best 1-2 pages and answer from their text, citing the notebook/section/page name.
