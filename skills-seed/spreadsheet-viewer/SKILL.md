---
name: spreadsheet-viewer
description: Open and analyze Excel / CSV / OpenDocument spreadsheets; compute, filter, summarize. Backs the Excel app.
---

# Spreadsheet Viewer (Excel)

Open a spreadsheet (XLSX/XLS/CSV/ODS) and help the user: summarize sheets, compute totals/averages, filter rows, find values, or explain formulas. The data is rendered server-side so any model can read it.

For editing/transform requests, use your shell tools (e.g. python with openpyxl/pandas) and save the result to a new file, reporting the path. The desktop app renders sheets as tables via `/api/docview`.
