---
name: fact-check
description: Verify a specific claim or quote. Search for primary sources, weigh them, and return a verdict (true / false / misleading / unverified) with evidence. Use when the user asks "is it true that..." or wants something confirmed.
---

# Fact-check

## Steps
1. Restate the precise claim (and any numbers/dates/names in it).
2. `web_search` for it; prioritize primary and authoritative sources. Read them (WebFetch/http_get), not just snippets.
3. Compare what the sources actually say to the claim.
4. Give a verdict: **True**, **False**, **Misleading/partly true**, or **Unverified (not enough evidence)** — with a one-line reason and the sources used.

## Rules
- Don't decide from a single source or a headline; corroborate.
- If reputable sources disagree, report the disagreement instead of forcing a verdict.
- Never invent evidence. "Unverified" is a valid, honest answer.
