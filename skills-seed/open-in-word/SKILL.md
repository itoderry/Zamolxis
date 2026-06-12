---
name: open-in-word
description: Create a Word .docx from text/HTML and open it in Word with the open_in_word tool, or open an existing .docx. Use for letters, reports, memos, meeting notes, any formatted document the user wants in Word.
---
# Open in Word
Call `open_in_word` with `text` (plain, newlines = paragraphs) or `html` (for headings/bold/lists/tables), plus a `title`. It writes a real .docx and opens Word. To open an existing doc, pass `file`. Prefer HTML when the user wants structure (headings, bullet lists, tables).
