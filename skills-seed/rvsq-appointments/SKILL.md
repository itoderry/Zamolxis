---
name: rvsq-appointments
description: Watch Quebec's Rendez-vous santé Québec (RVSQ, rvsq.gouv.qc.ca) for available walk-in / urgent-consultation medical appointments near you, and alert the moment a slot opens. Windows-only, runs entirely locally (Node + Zamolxis's playwright-core + your installed Chrome — no cloud, no extra install). Backs the rvsq-watch agent. Use when the user asks to find / watch / get alerted about RVSQ or Quebec doctor appointments.
---

# RVSQ Appointment Watch (Windows)

Finds free RVSQ medical-appointment slots for you instead of you refreshing the site by hand.
Reproduces the flow of the open-source Meulade_RVSQ project (github.com/tony-png/Meulade_RVSQ)
as a single-check headless-capable runner, driven by the **rvsq-watch** agent on a schedule.

**Everything runs locally on your Windows machine.** It reuses Zamolxis's own `playwright-core`
and your installed **Google Chrome** (no browser download), talks only to the official RVSQ site,
and stores nothing in the cloud.

## Your data stays yours

The runner needs the details from your **RAMQ health card** (name, NAM/health-insurance number,
card sequential number, birth date, postal code). You put them in a **local config file that you
fill in yourself** — Zamolxis (and this assistant) never enter, read out, log, or transmit them.
They are sent only to the official `rvsq.gouv.qc.ca` form, exactly as if you typed them.

- Config file: `%USERPROFILE%\.zamolxis\rvsq-config.json` (or set `RVSQ_CONFIG` to another path).
- Template: `rvsq-config.example.json` in this skill folder — copy it and fill in your details.
- It is outside the repo and never committed. Screenshots of found slots go to
  `%USERPROFILE%\.zamolxis\rvsq-screenshots\`.

## One-time setup

1. Copy `rvsq-config.example.json` to `%USERPROFILE%\.zamolxis\rvsq-config.json` and fill in your
   RAMQ details (`nam` = the number on your card; `card_seq_number` = the small sequence number
   after your name; `birth_month` = try the two-digit month, e.g. `03`).
2. That's it — Node and Chrome are already present via Zamolxis. Verify with a self-test (it opens
   the page and confirms the RAMQ form loads, then stops WITHOUT submitting anything):

   ```
   node "<Zamolxis>\skills-seed\rvsq-appointments\rvsq_check.mjs" --selftest
   ```

## How the runner works

`rvsq_check.mjs` performs ONE check and prints a single JSON line, e.g.:

```
{ "ok": true, "available": true, "clinics": ["…"], "screenshot": "…\\slot_….png", "step": "done", "checked_at": "…", "error": null }
```

- `available:true` → a clinic is offering slots right now (screenshot saved, a beep sounds).
- `available:false` with `ok:true` → checked fine, nothing open.
- `ok:false` → something went wrong (`step` + `error` say where — often wrong RAMQ details or the
  RVSQ site changed a field/label).

The **rvsq-watch** agent runs this on a schedule; when `available` is true it messages you the
clinics + the screenshot path (and can speak/notify via the OS). It stays quiet when nothing's open.

## Be a good citizen

This checks slots for *your own* health card at a polite interval (a few minutes) — it is not a
scraper or a booking bot. Don't hammer the government site (keep the schedule sane), and book the
appointment yourself on the site once alerted.

## When it breaks

RVSQ is an ASP.NET site that changes selectors/labels from time to time (and the "Consultation
Urgente" option id can change). If `ok:false` starts appearing at a specific `step`, the runner's
selectors for that step need a refresh; `consulting_reason` and `radius_km` are overridable in the
config without touching code.
