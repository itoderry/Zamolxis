---
name: currency
description: Convert money between currencies at the current rate. ANY model — http_get https://open.er-api.com/v6/latest/<BASE> (free, no key) returns rates; multiply. Use for "convert 100 USD to EUR", "exchange rate".
---

# Currency conversion

- `http_get https://open.er-api.com/v6/latest/<BASE>` (e.g. `USD`) → JSON; `rates.<TARGET>` is the multiplier. result = amount × `rates[TARGET]`.
- Example: 100 USD → EUR = `100 * rates.EUR`.

## Rules
- State the rate used and that rates fluctuate. Report only the real returned rate — don't invent one.
- If the API fails, `web_search "<amount> <BASE> to <TARGET>"`.
