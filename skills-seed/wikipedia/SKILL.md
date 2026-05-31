---
name: wikipedia
description: Look up a topic on Wikipedia. ANY model — http_get https://en.wikipedia.org/api/rest_v1/page/summary/<Title> returns JSON with an "extract" summary (no key). Use for "who/what is X", background facts.
---

# Wikipedia lookup

- `http_get https://en.wikipedia.org/api/rest_v1/page/summary/<Title>` → JSON; `extract` is a plain-text summary, `title`/`description` name the topic. Use `_` or `%20` for spaces (e.g. `Montreal_Canadiens`).
- Unsure of the exact title? `web_search "<topic> wikipedia"` first, or read the whole article with `read_url https://en.wikipedia.org/wiki/<Title>`.

## Rules
- Answer from the `extract`; for more detail, `read_url` the full article. Report only what the API returns — don't invent.
- Wikipedia lags on very recent events — use `web_search` for those.
