---
name: weather
description: Get current weather or a forecast for a place. ANY model can do this — http_get https://wttr.in/<place>?format=j1 (JSON), or web_search "weather <place> <when>". Use for "what's the weather in X", "will it rain tomorrow".
---

# Weather

Usable by any model with its tools (no shell needed). URL-encode the place (e.g. `New%20York`):

- **Quick (best):** `http_get https://wttr.in/<place>?format=3` → one line like `Toronto: ⛅️ +5°C`. Tiny, never truncated.
- **More detail:** `http_get https://wttr.in/<place>?format="%l:+%c+%t+feels+%f,+wind+%w,+humidity+%h"` for a custom one-liner, or `?format=j1` for full JSON (`current_condition[0].temp_C/.weatherDesc`; daily in `weather[]`) — note j1 is large and may be truncated, but current conditions are near the top.
- **Or:** `web_search` "weather <place> <today/tomorrow/date>".

## Rules
- State the place, the time/date, temperature, and conditions plainly. Report only what the tool returned — don't invent numbers.
- If the place is ambiguous, say which one you used.
