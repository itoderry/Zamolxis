---
name: rvsq-appointments
description: Watch Quebec's Rendez-vous santé Québec (RVSQ, rvsq.gouv.qc.ca) for available walk-in / urgent-consultation medical appointments for one or more people (you + family), and alert the moment a slot opens. Windows-only, runs entirely locally (Node + Zamolxis's playwright-core + your installed Chrome — no cloud, no extra install). Backs the rvsq-watch agent. Use when the user asks to find / watch / get alerted about RVSQ or Quebec doctor appointments.
---

# RVSQ Appointment Watch (Windows)

Finds free RVSQ medical-appointment slots — for **one or more people** (yourself, a spouse, kids) —
instead of you refreshing the site by hand. Reproduces the flow of the open-source Meulade_RVSQ
project (github.com/tony-png/Meulade_RVSQ) as a headless-capable runner that checks each configured
person in their own browser session, driven by the **rvsq-watch** agent on a schedule.

**Everything runs locally on your Windows machine.** It reuses Zamolxis's own `playwright-core`
and your installed **Google Chrome** (no browser download), talks only to the official RVSQ site,
and stores nothing in the cloud.

## Your data stays yours

The runner needs the details from each person's **RAMQ health card** (name, NAM/health-insurance
number, card sequential number, birth date, postal code). You put them in a **local config file
that you fill in yourself** — Zamolxis (and this assistant) never enter, read out, log, or transmit
them. They are sent only to the official `rvsq.gouv.qc.ca` form, exactly as if you typed them.

- Config file: `%USERPROFILE%\.zamolxis\rvsq-config.json` (or set `RVSQ_CONFIG` to another path).
- Template: `rvsq-config.example.json` in this skill folder — copy it and add one entry per person.
- It is outside the repo and never committed. Screenshots of found slots go to
  `%USERPROFILE%\.zamolxis\rvsq-screenshots\` (named per person).

## Multiple people

The config holds a `users` array — **one entry per person** you want watched, each with its own
`label` (e.g. "Me", "Spouse", "Kid") and `personal_info`. Each is checked in its own browser
session per run, and alerted separately by name. `headless` / `radius_km` set at the top level are
defaults for everyone; any entry can override them, or set `"disabled": true` to skip it. (A single
top-level `personal_info` — the old one-person format — still works.)

## One-time setup

1. Copy `rvsq-config.example.json` to `%USERPROFILE%\.zamolxis\rvsq-config.json` and fill in one
   `users` entry per person. RVSQ's login needs name + `nam` (health-insurance number) +
   `card_seq_number` (the small **sequential** number on the card) + **date of birth** — there is
   **no card-expiry field**. `birth_month` accepts `1`–`12` or the French month name (e.g. `mars`).
2. That's it — Node and Chrome are already present via Zamolxis. Verify with a self-test (it opens
   the page and confirms the RAMQ form loads for each person, then stops WITHOUT submitting anything):

   ```
   node "<Zamolxis>\skills-seed\rvsq-appointments\rvsq_check.mjs" --selftest
   ```

## How the runner works

`rvsq_check.mjs` checks every configured person and prints a single JSON line, e.g.:

```
{ "ok": true, "any_available": true, "checked_at": "…", "results": [
    { "user": "Me",     "available": true,  "clinics": ["…"], "screenshot": "…\\slot_Me_….png", "step": "done", "error": null },
    { "user": "Spouse", "available": false, "clinics": [],    "screenshot": null,               "step": "done", "error": null } ] }
```

- a result with `available:true` → a clinic is offering slots for THAT person right now (screenshot
  saved; a beep sounds once if anyone has a hit).
- `available:false` with `error:null` → checked fine, nothing open for that person.
- a result with `error` set → that person's check failed (`step` says where — often wrong RAMQ
  details for that person, or the RVSQ site changed a field/label); other people still get checked.

The **rvsq-watch** agent runs this on a schedule; for each person with `available:true` it messages
you their name + clinics + screenshot path (and can speak/notify via the OS). It stays quiet when
nothing's open for anyone.

## Be a good citizen

This checks slots for *your own* health card at a polite interval (a few minutes) — it is not a
scraper or a booking bot. Don't hammer the government site (keep the schedule sane), and book the
appointment yourself on the site once alerted.

## When it breaks

RVSQ is an ASP.NET site that changes selectors/labels from time to time (and the "Consultation
Urgente" option id can change). If `ok:false` starts appearing at a specific `step`, the runner's
selectors for that step need a refresh; `consulting_reason` and `radius_km` are overridable in the
config without touching code.
