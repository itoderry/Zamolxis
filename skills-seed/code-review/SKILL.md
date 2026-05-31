---
name: code-review
description: Review code for bugs, security issues, and clarity, with concrete fixes. PASTE the code (or a diff) and ANY model can review it — no tools needed. (Claude can also read files / run git diff directly.) Use for "review/check this code".
---

# Code review

Works on code the user **pastes** — no tools required, so any model can do it. Claude can additionally read files or run `git diff` to review changes in place.

## Review for, in priority order
1. **Correctness** — logic errors, off-by-one, null/undefined, bad async/await, unhandled errors, races.
2. **Security** — injection (SQL/shell/HTML), secrets in code, missing authz/validation, path traversal.
3. **Resources/perf** — leaks, N+1 queries, needless O(n²), unbounded growth.
4. **Clarity** — naming, dead code, duplication, missing edge cases.

## Output
Per finding: where (function/line) — what's wrong — why it matters — the fix (show the corrected snippet). Lead with the most serious; note what's good too. Separate "bug" (will break) from "style" (preference).

## Rules
- Only comment on code you can actually see. Don't invent code you weren't shown.
- For pasted code you need NO tool — just analyze and answer.
