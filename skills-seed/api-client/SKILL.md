---
name: api-client
description: A built-in Postman-style HTTP client. Build and send requests (any method, query params, headers, auth, JSON/form/raw bodies), inspect the response (status, time, size, headers, pretty-printed body), and reuse them via saved collections, history, and environment variables. Use this when the user wants to test an API, hit an endpoint, debug a webhook, or check what a URL returns.
---

# API Client

Giskard ships with an **API Client** — a Postman-style tool for talking to HTTP
APIs. It lives in the desktop UI (Network category) and also backs this skill, so
you can drive it from chat or point the user at the app.

## What it does

- **Request builder** — pick a method (GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS),
  type a URL, and add:
  - **Params** — query-string key/value pairs (appended to the URL, URL-encoded).
  - **Headers** — arbitrary request headers.
  - **Authorization** — None, Bearer token, or Basic auth (username/password).
  - **Body** — None, JSON, raw text, or `x-www-form-urlencoded` form fields.
    Choosing JSON or form sets the matching `Content-Type` automatically.
- **Response viewer** — status code (colour-coded), round-trip time, and size,
  plus tabs for the **Body** (JSON is pretty-printed) and the response **Headers**.
- **Collections** — save a fully built request under a name and reload it later.
- **History** — the last 50 requests, click to refill the URL bar.
- **Environments** — define named sets of variables and reference them anywhere
  with `{{var}}` (e.g. `{{base_url}}/users`, header `Authorization: Bearer {{token}}`).
  Substitution happens in the URL, params, headers, auth fields and body at send time.

## How requests are sent

The browser can't call arbitrary hosts directly (CORS, restricted headers), so the
request goes through Giskard's own server-side proxy at `POST /api/http`, which
performs the call and returns `{ ok, status, statusText, headers, body, ms, size,
truncated, contentType }`. Requests time out after 30s; response bodies over ~2 MB
are truncated (the viewer marks this). Only `http`/`https` URLs are allowed.

## Driving it from chat

When the user asks you to call an endpoint, you can use your `http_get` /
HTTP tool for simple GETs, or describe the request so they can run it in the app.
For anything with auth, a JSON body, or repeated use, prefer the **API Client app**
so it can be saved to a collection and reused with environment variables.

Open it from the desktop launcher → **API Client** (Network), or tell the user:
"Open the API Client app, set the method and URL, add your headers/body, and press
Send." Saved requests, history and environments persist in the browser.

## Tips

- Use an environment for secrets/base URLs instead of hard-coding them — switch
  between `dev`/`prod` by changing the active environment in the sidebar footer.
- `{{var}}` that has no matching variable is left untouched, so you can spot typos.
- Basic auth is sent as a base64 `Authorization: Basic …` header; Bearer as
  `Authorization: Bearer …`. A header you set yourself always wins over the
  Authorization tab if you set `Authorization` manually.
