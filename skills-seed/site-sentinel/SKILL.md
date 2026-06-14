---
name: site-sentinel
description: Watch a list of URLs and alert when one stops loading correctly (and when it recovers). Hourly checks by default, configurable. Use when the user says "watch this url", "monitor my site", "is my website up?", "stop monitoring X", "check my sites", or "check the sites every N minutes".
---

# Site Sentinel

Giskard keeps a list of URLs and checks them in the background on an interval (default **every 60 minutes**, configurable 1–1440). A URL is **loading correctly** when it answers 2xx/3xx within 20 seconds — and, when a `mustContain` text was set, the page body contains it. You get a toast alert when a site goes **down** and another when it **recovers**; healthy checks stay silent.

Everything is managed from chat with the `url_watch` tool:

- **Add**: `url_watch action="add" url="https://example.com"` — optional `name` (shown in alerts) and `mustContain` (e.g. a word that must appear on the page). Bare domains are accepted (`example.com` → `https://example.com`).
- **Remove**: `url_watch action="remove" url="example"` — by URL, by name, or by a unique fragment.
- **List**: `url_watch action="list"` — every watched URL with its last status (HTTP code, response time, last checked).
- **Check now**: `url_watch action="check"` — runs all checks immediately and reports.
- **Interval**: `url_watch action="interval" minutes=30` — how often the background check runs.

## How to respond

- "watch https://myshop.com and make sure it says 'Add to cart'" → add with `mustContain: "Add to cart"`.
- "are my sites up?" → `action="check"` and summarize: lead with anything DOWN (error + how long it has been failing), one line for the healthy rest.
- "stop monitoring the blog" → `action="remove" url="blog"`; if ambiguous, the tool lists the matches — ask the user which one.
- "check every 30 minutes" → `action="interval" minutes=30`.

The watcher toggle and interval also live in **Settings → System → Proactive** ("Watch site health"). The list persists in `~/.giskard/urlwatch.json`.
