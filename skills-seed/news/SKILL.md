---
name: news
description: Put together a news briefing tailored to the user's job/role and the topics they care about, at the cadence they choose. Use when the user says "give me the news", "what's happening in my industry", "set up a news briefing", "news digest", or asks to follow news on a topic.
---

# News briefing

The point of this skill is a short, relevant news digest — built around **who the user is** (their role/title) and **what they care about** (their interests), delivered **as often as they want**. Don't hand back a generic headline dump; make it feel like it was put together for them.

## First, know the reader

Before writing anything, you need three things. Check your memory/profile first (the user may have told you already):

1. **Role / title** — e.g. "Product Manager at an EdTech company", "backend engineer", "founder". This sets the professional lens.
2. **Interests / topics** — the subjects they want covered (their industry, specific technologies, competitors, markets, hobbies). A few is fine.
3. **Cadence** — how often they want the briefing: e.g. every weekday morning, once a day, twice a day, weekly Monday.

If any of these is missing, **ask the user once, in plain language, and stop** — don't invent news or guess. For example: *"To set up your news briefing: what's your role, which topics should I track, and how often would you like it — daily, weekday mornings, weekly?"* When they answer, save it to your profile with the `memory` tool (scope "profile") so you don't ask again, and — if they gave a cadence — set your own schedule with `schedule_agent` to match it (e.g. "weekday mornings" → `30 7 * * 1-5`, "twice a day" → `0 8,16 * * *`, "weekly" → `0 8 * * 1`).

## Then, build the briefing

1. Search for recent, real items with the web search tool(s) — one focused query per interest/topic, plus one for the user's industry generally. Prefer the last few days.
2. Keep only what's genuinely relevant to this reader; drop fluff, ads, and duplicates.
3. Write a tight digest: a one-line intro, then **5–8 bullets**, each = a punchy headline + one sentence on *why it matters to them given their role*, and the **source link**. Group by topic if there are several.
4. If a search turns up nothing solid, say so honestly for that topic rather than padding.
5. Deliver it with `send_message` to the user. Never fabricate a headline, a quote, or a link — every item must come from a real search result.

## Notes

- Web search uses DuckDuckGo out of the box; a Tavily or Brave key (Settings → Providers) gives better results.
- The user can change cadence any time ("send me the news weekly instead") — update the saved preference and reschedule.
- The **News Brief** pre-made agent runs this on a schedule; it's headless by default (turn on its chat window to set preferences by talking to it, or just tell the main chat).
