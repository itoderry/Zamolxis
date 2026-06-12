---
name: open-in-excel
description: Put tabular data into a real .xlsx and open it in the user's Excel with the open_in_excel tool. PREFERRED way to deliver query results, lists, reports and any table the user will want to sort, filter or compute on.
---

# Open in Excel (open_in_excel)

When the user asks for data "in Excel" / "as a spreadsheet" - or the result is a table they will want to work with - call `open_in_excel` with `columns` + `rows` (and a `title`). The tool writes a real .xlsx and launches Excel with it; reply with the saved path.

- For SQL results: run `sql_query` first, then pass the columns/rows straight through.
- To open an existing spreadsheet file, pass `file` with the path instead.
- Large data is fine (thousands of rows) - Excel handles it; don't paste the rows in chat too, just summarize.
- Use show_table/Canvas only for a quick glance; Excel is for data the user will actually manipulate.
