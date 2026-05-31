---
name: pdf
description: Work with PDF files — extract text/tables, split/merge/rotate pages, fill forms, convert pages to images. Uses Python (pypdf, pdfplumber) run through the shell tool. Needs Claude (shell); on-device model should ESCALATE.
---

# PDF processing

Operate on PDFs with Python via the shell (`sandbox_exec`). Install libs on first use:
`pip install pypdf pdfplumber` (add `reportlab` to create PDFs, `pdf2image` for rasterizing).

## Extract text
```python
import pdfplumber
with pdfplumber.open("in.pdf") as pdf:
    for p in pdf.pages:
        print(p.extract_text() or "")
```
Tables: `page.extract_tables()`. For scanned/image PDFs there is no text layer — say so (OCR is a separate step).

## Merge / split / rotate
```python
from pypdf import PdfReader, PdfWriter
r = PdfReader("in.pdf"); w = PdfWriter()
for i in [0,1,2]: w.add_page(r.pages[i])   # select pages
with open("out.pdf","wb") as f: w.write(f)
```
Merge: add pages from several readers. Rotate: `page.rotate(90)`.

## Fill a form
Inspect fields with `reader.get_fields()`, then
`writer.update_page_form_field_values(writer.pages[0], {"FieldName": "value"})`.

## Rules
- Read the actual file; never invent contents. Report the real page count.
- Write outputs into the current workspace and tell the user the path.
- Large PDFs: process page-by-page; don't load everything into one string.
