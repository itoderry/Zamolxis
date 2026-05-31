---
name: pptx
description: Build PowerPoint (.pptx) presentations — title/content slides, bullets, images, tables, speaker notes. Uses Python (python-pptx) via the shell. Needs Claude (shell); on-device model should ESCALATE.
---

# Presentations (.pptx)

Use `python-pptx` via the shell. Install on first use: `pip install python-pptx`.

## Build a deck
```python
from pptx import Presentation
from pptx.util import Inches, Pt
prs = Presentation()
# Title slide
s = prs.slides.add_slide(prs.slide_layouts[0])
s.shapes.title.text = "Quarterly Review"
s.placeholders[1].text = "Prepared for the team"
# Bullet slide
s = prs.slides.add_slide(prs.slide_layouts[1])
s.shapes.title.text = "Highlights"
tf = s.placeholders[1].text_frame; tf.text = "First point"
for t in ["Second point","Third point"]:
    p = tf.add_paragraph(); p.text = t; p.level = 0
# Image + notes
s = prs.slides.add_slide(prs.slide_layouts[5])
s.shapes.add_picture("chart.png", Inches(1), Inches(1.5), width=Inches(8))
s.notes_slide.notes_text_frame.text = "Talk through the trend here."
prs.save("out.pptx")
```

## Rules
- One idea per slide; short bullets, not paragraphs. Generate charts as PNGs (matplotlib) and embed them.
- Save into the workspace and report the path.
