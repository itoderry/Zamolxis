---
name: docx
description: Create and edit Microsoft Word (.docx) documents — headings, paragraphs, tables, images, styles. Uses Python (python-docx) via the shell. Needs Claude (shell); on-device model should ESCALATE.
---

# Word documents (.docx)

Use `python-docx` via the shell (`sandbox_exec`). Install on first use: `pip install python-docx`.

## Create
```python
from docx import Document
doc = Document()
doc.add_heading("Title", level=0)
doc.add_paragraph("Intro paragraph.")
doc.add_heading("Section", level=1)
p = doc.add_paragraph("normal "); p.add_run("bold").bold = True
t = doc.add_table(rows=1, cols=2); t.style = "Light Grid Accent 1"
t.rows[0].cells[0].text = "A"; t.rows[0].cells[1].text = "B"
doc.add_picture("chart.png", width=None)
doc.save("out.docx")
```

## Edit an existing file
Open it (`Document("in.docx")`), iterate `doc.paragraphs` / `doc.tables`, change `.text` or runs, then `save()`. To preserve formatting, edit run text in place rather than rebuilding.

## Rules
- Match the tone/voice the user asked for. For prose meant to sound human, also apply the `humanizer` skill.
- Save into the workspace and report the path. Never claim a file was written unless `save()` ran without error.
