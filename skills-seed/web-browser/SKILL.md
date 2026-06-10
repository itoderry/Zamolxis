---
name: web-browser
description: Drive a real web browser (the user's Chrome) with the browser tool - navigate, read, click, type, search, screenshot. Use for interactive web tasks that read_url/web_search can't do: forms, multi-step flows, dynamic pages, sites needing clicks.
---

# Browser control (browser tool)

For interactive web work, use `browser` (a real visible Chrome). For a quick read of one static page, `read_url` is lighter; use `browser` when you must click/type or the page is dynamic.

Typical flow:
1. `goto` {url} - opens the page, returns title/url + visible text.
2. `snapshot` - lists the clickable/typeable elements by their text (so you know what to target).
3. `click` {text:"Sign in"} or `type` {text:"Search", value:"...", submit:true}.
4. `text` - re-read the page after it changes.
5. `screenshot` - capture the page onto the Canvas for the user to see.

Tips:
- After a click/submit, the tool returns the new page summary; read it before the next step.
- Prefer targeting by visible `text`; use `selector` (CSS) only when text is ambiguous.
- Do NOT enter the user's passwords yourself - if a login needs credentials, stop and ask the user to type them in the visible window.
- `close` when done with a long task. The browser idle-closes after 10 minutes anyway.
