---
name: xlsx
description: Read, create, and analyze Excel spreadsheets (.xlsx/.csv) — formulas, multiple sheets, formatting, summaries. Uses Python (openpyxl, pandas) via the shell. Needs Claude (shell); on-device model should ESCALATE.
---

# Spreadsheets (.xlsx / .csv)

Use `openpyxl` for cell-level control and `pandas` for analysis. Install on first use:
`pip install openpyxl pandas`.

## Read / analyze
```python
import pandas as pd
df = pd.read_excel("in.xlsx", sheet_name=0)   # or pd.read_csv("in.csv")
print(df.shape, list(df.columns))
print(df.describe(include="all"))
print(df.groupby("col").agg({"amount":"sum"}))
```

## Create with formatting and formulas
```python
from openpyxl import Workbook
from openpyxl.styles import Font
wb = Workbook(); ws = wb.active; ws.title = "Summary"
ws.append(["Item","Qty","Price","Total"])
for c in ws[1]: c.font = Font(bold=True)
ws.append(["Widget",3,9.5,"=B2*C2"])        # real formula, not a pre-computed value
ws.column_dimensions["A"].width = 18
wb.save("out.xlsx")
```

## Rules
- Inspect the real columns/dtypes before computing; report actual numbers, never invent figures.
- Prefer real Excel formulas (e.g. `=SUM(...)`) over hard-coded results when the user will keep editing.
- Save into the workspace and report the path.
