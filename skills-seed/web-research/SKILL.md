---
name: web-research
description: Research a topic or current question using web_search then read the best sources with WebFetch/http_get, and synthesize a sourced answer. Use whenever the request needs facts you don't already know or anything current/live.
---

# Web research

For anything you are unsure of or that is time-sensitive, search — do not guess.

## Steps
1. `web_search` with a focused query (add the year for current info). Run 2-3 varied queries rather than one.
2. Pick the most credible, on-topic results. Read them with WebFetch (Claude) or `http_get` (any model) — don't rely on the snippet alone for anything important.
3. Cross-check key claims across at least two independent sources. Prefer primary/official sources over aggregators.
4. Synthesize a direct answer, then list the sources (title + URL) you actually used.

## Rules
- Cite only pages you really fetched. Never fabricate a URL, quote, or statistic.
- Distinguish what the sources say from your own inference. Flag uncertainty and dates ("as of <date>").
- If sources conflict, say so and give the most likely answer with the caveat.
- No web search provider configured and WebFetch blocked? Tell the user web search needs a free Tavily/Brave key in Settings.
