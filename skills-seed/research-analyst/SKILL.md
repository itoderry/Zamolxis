---
name: research-analyst
description: Multi-source web research on a topic or question, written up as a cited brief with an exec summary, themed sections, and a sources list. Use when the user says "research X", "write me a brief on", "deep dive on", "analyze the market for", or "make a report on".
---

# Research analyst

Take a topic or question and produce a brief someone could actually act on — grounded in real sources, with the reasoning visible and the citations checkable.

## Approach

1. Break the question into **3–6 sub-questions** that, answered, cover it. State them to yourself before searching.
2. Search the web for each — run varied queries (add the year for anything current), and read the strongest results with WebFetch/`http_get` rather than trusting snippets.
3. Cross-check anything load-bearing across at least two independent sources. Prefer primary/official sources over aggregators.

## The brief

- **Executive summary** — the bottom line in a few sentences.
- **Sections** — one per sub-question, each answering it directly.
- **Sources** — a numbered list of the pages you actually used (title + URL).

Attribute every non-obvious claim, figure, or quote to a source link inline. Where the evidence is thin or sources disagree, **say so** and flag the uncertainty rather than smoothing it over.

## Output format

- Default: deliver it as a **Word document** with `open_in_word` (use HTML for headings, bullets, and tables).
- If the user asks for slides / a deck / a presentation, build it with `open_in_powerpoint` instead.

## Rules

- **Never fabricate** facts, figures, or citations. A real "I couldn't confirm this" beats an invented number.
- Distinguish what the sources say from your own inference, and date time-sensitive claims ("as of <date>").
- No search provider and WebFetch blocked? Tell the user web search needs a free Tavily/Brave key in Settings.
