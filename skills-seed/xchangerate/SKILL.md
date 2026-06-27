---
name: xchangerate
description: Fetch current currency exchange rates from the Xchange Rate web API (the tools.xchangerate method) and present them as a clean table. Requires the user's account UID and password. Use when the user asks for exchange rates, currency rates, or "the xchange rates".
---

# Xchange Rate

Calls the Xchange Rate web API method **`tools.xchangerate`** and renders the returned
USD-based exchange rates (source: XE.COM) as a table. The endpoint needs a
per-request **authentication token** derived from the account's **UID** and
**password** — this skill builds that token exactly the way the API's own
"Examples" page prescribes.

## What you need from the user

- **UID** — the account UID (a number, e.g. `17172`).
- **Password** — the account password.

Ask for both each time. **Never store, echo, or log them**, and never write them
into the repo, a settings file, or a committed example. They're used only to build
one request token and then discarded.

## How to run it

The folder ships a ready-to-run script, `xchangerates.mjs`. Pass the credentials as
environment variables (so they don't show up in the process list / shell history)
and run it with Node:

```bash
XCHANGE_UID=<uid> XCHANGE_PASSWORD=<password> node xchangerates.mjs
```

- Add an ISO 4217 code to fetch a single currency, e.g. `node xchangerates.mjs EUR`
  (or `XCHANGE_ISOCODE=EUR`). Omit it to get all currencies.
- Add `--json` to get the raw rows instead of a table.

The script prints a Markdown table to stdout (and a one-line summary to stderr).
Show the table to the user as-is, or reformat it to match the surface you're on.

## The authentication scheme (for reference)

Implemented in `xchangerates.mjs`; documented here so it can be maintained. Each
piece must be exact or the API returns `"Invalid Token."`:

1. `method = "tools.xchangerate"`.
2. `ts` = current **UTC** time **minus one hour**, formatted `yyyy-MM-dd HH:mm:ss`.
3. `MD5(s)` = MD5 over the **UTF-16LE** bytes of `s`, as **UPPERCASE** hex
   (the C# sample uses `Encoding.Unicode` + `ToString("X2")`).
4. `hashedpassword = MD5(password)`.
5. `token = base64( utf8( UID + "|" + ts + "|" + MD5(hashedpassword + ts + method) ) )`.
6. `GET https://rest.upclick.com/json/<token>/tools/xchangerate` (optionally
   `?isocode=<CODE>`), with `Accept: application/json`. (`rest.upclick.com` is the
   live API host — it's the one fixed external endpoint this skill talks to.)

The response is wrapped as `{ "tools_xchangerate": [ … ] }`; each row has
`Name`, `ISOCode`, `Symbol`, and `UsRate` (rate per 1 USD).

## Limits & cautions

- The API allows **at most 10 requests per ~86,300 seconds (≈ a day)** for this
  method — don't poll it; cache the result if you need it again soon.
- The token embeds a timestamp and is short-lived, so build a fresh one per call
  (the script does this automatically).
