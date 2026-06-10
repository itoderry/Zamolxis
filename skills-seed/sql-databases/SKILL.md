---
name: sql-databases
description: Query local Microsoft SQL Server / LocalDB databases read-only with the sql_query tool (sqlcmd, Windows auth). Use for "what's in my X database", "how many rows/orders/users...", "show me the schema of table Y".
---

# Local SQL Server (read-only)

The `sql_query` tool runs ONE read-only SELECT (or WITH...SELECT) against a local SQL Server with Windows auth. Default instance: `(localdb)\MSSQLLocalDB`; pass `server` (e.g. `localhost`) for a full instance.

Useful first queries:
- Databases: `SELECT name FROM sys.databases`
- Tables: `SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES` (pass `database`)
- Columns: `SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '...'`

Rules: single statement only; no INSERT/UPDATE/DELETE/DDL (the tool refuses them); add TOP 50 to large selects; format results as a readable table or summary, not raw pipes.
