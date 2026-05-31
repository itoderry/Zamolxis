---
name: summarize
description: Summarize a long text, a web page, or a document into key points. PASTE text (any model, no tools) or give a URL (fetched with http_get / web_search). Use for "summarize this", "tl;dr", "what does this say". (PDF/Office FILES on disk need the pdf/docx/xlsx skills on Claude.)
---

# Summarize

- **Pasted text** → summarize directly — no tools needed, any model can do it.
- **A URL** → fetch it with `http_get` (or `web_search` to find it), then summarize.
- **A PDF/Office file on disk** → text must be extracted first (pdf/docx/xlsx skills, Claude).

## Output (fit to the content + the ask)
- a one-line **TL;DR**, then
- 3-7 key points, and
- **Action items / decisions** if there are any.

## Rules
- Summarize only what's actually in the source — never add facts or guess at omitted parts.
- Note if the source was truncated or unreadable. Match length to the need (a quick "tl;dr" = 1-2 lines).
