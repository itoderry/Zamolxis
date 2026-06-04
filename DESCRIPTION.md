# Zamolxis

**Zamolxis is a self-hosted, always-on personal AI agent that lives on your own machine, talks to you across all your chat apps, and does real work — while spending as close to nothing as possible.**

Its whole design rests on one idea: **use the cheapest brain that can do the job, and only reach for an expensive one when you must.**

---

## The core idea: a ladder of brains

Every message climbs a ladder, stopping at the first rung that can handle it:

1. **Calculator** — pure math (`(2+45-32+56)/334`) is computed directly. No model, instant, free.
2. **Free cloud models** — fast hosted models on free tiers, rotated to stay within daily limits.
3. **Paid cloud models** — only if *you* added one to the chain (no surprise billing).
4. **Local model** — an on-device model (via Ollama) that runs offline with zero quota. It is the **last resort**, because small local models are the least capable.
5. **The frontier "smart" tier** — your top-end subscription model, the rescue brain. Used only for hard tasks or when you explicitly **escalate**.

If a tier can't confidently do something, it **hands off upward automatically**. You can also force it: type `escalate` (typos tolerated), `escalate <model>`, or `escalate <number>` to jump to a specific model. The top tier runs on a **flat subscription, not metered per-call billing** — so heavy days don't cost extra.

---

## What it can do

- **Lives in your chats.** One agent, reachable from a built-in **web UI** plus **Telegram, Discord, Slack, WhatsApp, Signal, email, and CLI**. The main chat is mirrored two-way across every channel you connect.
- **Uses real tools, never makes things up.** Fetch URLs and JSON APIs, **search the web**, **read email** (read-only, multi-account), **control your home** via Home Assistant, run sandboxed code, and manage dashboard tabs. It reports only what tools actually return.
- **Runs autonomous agents.** Describe a job in plain language and the smart model compiles it into a concrete plan — instructions, required skills (authored if missing), a risk assessment, and a schedule. A cheap model then executes it on a cron. Run, Schedule, Analyze, Stop/Resume, or delete each agent.
- **Builds its own skills.** Reusable how-to procedures it follows and writes over time. Example: `/hasync` scans Home Assistant and writes a clean device map (by room, by type, with plain-English aliases) so even the weakest local model can control devices reliably.
- **Remembers.** Persistent across restarts: **LAWS** (inviolable safety rules), **SOUL** (its persona, you own it), **USER** (a profile it maintains about you), **MEMORY** (its working notes), and **LEARNINGS** (lessons captured when the smart tier rescues a failure).

---

## You stay in control

- **Local-model panel** — install the runtime, browse/pull models, switch the active one anytime, tune context/keep-alive/temperature, see GPU/CPU split, and test a model — from the UI.
- **Per-(model, skill) ban list** — forbid a weak model from a capability it keeps botching; a stronger model then takes over. The smartest model can never be banned.
- **Routing is yours** — reorder the tiers, toggle the local model, add or drop providers, and decide whether the subscription tier is in the chain at all.
- **Safety posture** — Asimov-style LAWS sit above everything; sensitive actions (locks, alarms) require confirmation or are blocked outright.

---

## In one breath

> Zamolxis is your own AI that you run, not rent — reachable from any chat app, able to use the web, your email, and your smart home, run scheduled jobs on its own, remember you across time, and answer everything on the cheapest capable model, escalating to your subscription's top model only when it genuinely needs to.

---

## Sign in

Zamolxis runs on the Claude Code engine using your **subscription** (flat-rate, no metered API key). Sign in on the host with:

```
claude auth login
```

- This is the command in **current Claude Code (CLI v2.x)** — authentication moved under the `auth` subcommand (`claude auth login` / `logout` / `status`). **Older versions used the top-level `claude login`, which no longer exists** (it's now treated as a prompt), so any guide that still says `claude login` is out of date.
- The same command covers **Pro, Max, Team, and Enterprise/Business** subscriptions. On Team/Business/Enterprise you sign in with the Claude.ai account your admin invited you to (Enterprise adds SSO/domain capture) — the command is identical; only the account differs.
- **Headless, background, CI, or macOS** (where the interactive login stores the token in the Keychain, which a background process can't read): run `claude setup-token`, copy the `sk-ant-oat01-…` line, and set `CLAUDE_CODE_OAUTH_TOKEN=…` in `.env` (or paste it in Settings → Engine). Check state with `claude auth status` or the web header's login indicator.

## Disclaimer

Zamolxis is provided **"as is", without warranty of any kind**, express or implied. You run it on your own hardware, under your own accounts, at your own risk.

- **It is autonomous and takes real actions.** It can read your email, control smart-home devices, run code, schedule recurring jobs, and send messages on the channels you connect. Review what your agents and schedules do before enabling them. The authors are not liable for any loss, damage, cost, data exposure, or unintended action resulting from its use.
- **It uses your own accounts and subscriptions.** You are responsible for complying with the terms of service, rate limits, and acceptable-use policies of every model provider, messaging platform, and service you connect. Usage of third-party free/paid tiers is subject to their rules and may change or stop at any time.
- **You own security.** Keep your credentials and `.env` private, do not expose the web interface on an untrusted network without authentication, and treat anything the agent can reach as something it may act on. Built-in safeguards (the LAWS file, confirmation prompts, blocked actions) reduce risk but do not eliminate it.
- **AI output can be wrong.** Models may make mistakes, miss context, or misjudge. Do not rely on Zamolxis for medical, legal, financial, or other professional advice, or for safety-critical decisions, without independent verification by a qualified human.
- **No affiliation.** Zamolxis is an independent project and is **not affiliated with, endorsed by, or sponsored by** any of the model providers, messaging platforms, or other services it can integrate with. All product names and trademarks belong to their respective owners.
- **Capabilities depend on your setup.** Which models, channels, and tools are available is entirely a function of what you install and configure; nothing here guarantees a specific model, provider, or feature will be available to you.

By running Zamolxis you accept responsibility for how it is configured and what it does on your behalf.
