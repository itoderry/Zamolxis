---
name: data-analysis
description: Analyze a dataset (CSV/Excel/JSON) and answer questions about it — summary stats, grouping, filtering, trends, and charts saved as PNG. Uses Python (pandas, matplotlib) via the shell. Needs Claude (shell); on-device model should ESCALATE.
---

# Data analysis

Use `pandas` (+ `matplotlib` for charts) via the shell. Install on first use:
`pip install pandas matplotlib`.

## Workflow
1. Load: `df = pd.read_csv(path)` / `pd.read_excel(path)` / `pd.read_json(path)`.
2. Understand the shape FIRST: `df.shape`, `df.dtypes`, `df.head()`, `df.isna().sum()`.
3. Answer the question with real ops — `groupby`, `pivot_table`, `query`, `sort_values`, `resample` for time series.
4. Chart when it clarifies:
```python
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
ax = df.groupby("month")["sales"].sum().plot(kind="bar")
plt.tight_layout(); plt.savefig("sales_by_month.png", dpi=120)
```
5. State the concrete findings (numbers + what they mean), and give the chart path.

## Rules
- Report only values computed from the data. If a column is missing or dirty, say so and show the cleaning step.
- Note sample size and any rows dropped. Don't extrapolate beyond what the data supports.
