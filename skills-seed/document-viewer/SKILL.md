---
name: document-viewer
description: Open and read Microsoft Word / OpenDocument text documents; summarize, search or extract content. Backs the Word document app.
---

# Document Viewer (Word)

Open a Word/ODT document and help the user: summarize it, find sections, extract text or tables, or answer questions about its contents. The text is extracted server-side so any model can read it.

For editing requests, use your shell tools (e.g. pandoc, python-docx) to modify the document and save the result to a new file, reporting the path. The desktop app renders the document to HTML via `/api/docview`.
