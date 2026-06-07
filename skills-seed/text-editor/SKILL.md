---
name: text-editor
description: Open, edit and save plain-text and code files. Backs the Text Editor desktop app.
---

# Text Editor

Open a text or code file, make the requested edits, and save it back.

- Read the file, apply the user's changes precisely, and write it back to the same path unless told otherwise.
- Preserve encoding and line endings. Do not reformat unrelated lines.
- For code, keep it syntactically valid; mention anything you could not safely change.

The desktop Text Editor app loads and saves files via `/api/fs` (read/write).
