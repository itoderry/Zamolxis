---
name: open-in-powerpoint
description: Build a PowerPoint .pptx and open it with the open_in_powerpoint tool. Use when the user wants a slide deck / presentation.
---
# Open in PowerPoint
Call `open_in_powerpoint` with `title` and `slides` — an array where each slide is `{title, bullets:[...]}` (or `{title, text}`). It creates a real .pptx and opens PowerPoint. One idea per slide; 3-6 concise bullets each. To open an existing deck, pass `file`.
