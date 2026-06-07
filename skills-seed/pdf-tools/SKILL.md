---
name: pdf-tools
description: View and edit PDFs - extract text, fill forms, merge/split, rotate, add pages, annotate. Backs the PDF app.
---

# PDF Tools

View PDFs and perform editing tasks on request using your shell tools (e.g. qpdf, pdftk, pdftoppm, or Python libraries like pypdf/PyMuPDF when installed):
- Extract or search text.
- Merge, split, reorder, rotate or delete pages.
- Fill form fields; flatten; add or remove pages.
- Export pages to images.

Always write the result to a new file unless told to overwrite, and report the output path. The desktop PDF app shows the document via `/api/file` and hands editing requests to you.
