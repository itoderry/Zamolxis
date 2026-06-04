# Zamolxis — Help (web + CLI)

> Kept in sync with the code on each change. For the high-level overview see [DESCRIPTION.md](DESCRIPTION.md); for release notes see [CHANGELOG.md](CHANGELOG.md).

Zamolxis is a self-hosted, always-on personal AI agent that answers on the **cheapest capable model** and only escalates to your top subscription model when it must. This file is the practical how-to for both the **web UI** and the **command line**.

---

## 1. Install & sign in

1. **Install** (from the repo folder):
   - Windows: `powershell -ExecutionPolicy Bypass -File install.ps1 -Web -Local`
   - macOS/Linux: `bash install.sh --web --local`
   The installer adds git/Node/Claude Code if missing, builds, and (with `-Local`/`--local`) offers a menu of general-chat local models that fit your hardware.

2. **Sign in to your subscription** — Zamolxis runs on the Claude Code engine via your subscription (no metered API key):
   ```
   claude auth login
   ```
   - This is the **current** Claude Code command (CLI v2.x). **Older versions used `claude login`**, which no longer exists as a top-level command — it's now under the `auth` subcommand (`claude auth login` / `claude auth logout` / `claude auth status`).
   - It works for **Pro, Max, Team, and Enterprise/Business** subscriptions. On Team/Business/Enterprise you sign in with the Claude.ai account your admin invited you to (SSO included on Enterprise) — the command is the same.
   - **Headless / background / CI** (or macOS, where the login token lands in the Keychain that a background process can't read): run `claude setup-token`, copy the `sk-ant-oat01-…` line, and set it as `CLAUDE_CODE_OAUTH_TOKEN=…` in `.env` (or paste it in **Settings → Engine → subscription token**). Applies immediately, no restart.

Check status anytime with `claude auth status`, or the web header's **login** indicator (hover for details).

---

## 2. Run it (CLI)

```
zam start         # start in the background (detached; survives closing the terminal)
zam stop          # stop the background instance
zam restart       # restart (reloads the latest build)
zam status        # is it running? which port?
zam update        # git pull + npm install + build + restart (git installs only)
zam --doctor      # readiness report (Node, login, channels, sandbox, local model)
zam setup-path    # put the `zam` / `zamolxis` commands on your PATH
zam help          # this help summary
```
`zamolxis` is an alias for `zam`. The web UI is at **http://127.0.0.1:8787** when `ZAMOLXIS_CHANNEL_WEB=true`.

> If `zam stop`/`restart` says *"port 8787 is STILL held — kill manually"*, an elevated/old copy is squatting the port: kill it from an **Administrator** terminal (`taskkill /F /PID <pid>`) or reboot, then `zam start`.

---

## 3. The web UI

**Left rail** (drag the dividers / right edge to resize) has three permanent sections:
- **Models** — the routing ladder, coloured by capability (green = weakest/local → blue = smartest). The last-used one is highlighted.
- **Agents** — your sub-agents (see §5).
- **Chats** — your conversations; **+ new chat**; the **Main** chat is permanent and mirrored to every messaging channel you connect.

**Tools menu** (top-right) opens side panels that push the chat aside (they don't cover it); switching tools warns if you have unsaved edits:
- **Skills** — browse/import/enable the procedures Zamolxis follows and writes.
- **Providers** — order the routing chain and add provider API keys; Claude login status.
- **Local model** — install Ollama, pull/switch models, routing (off/auto), context, keep-alive, temperature, GPU/CPU split, and a per-model **Test** button.
- **Memory** — LAWS / USER profile / MEMORY / learned facts, and the **Skill bans** editor.
- **Settings** — engine models, timezone, agent restore, channels, credentials, sandbox.

**Chat input shortcuts:**
- `escalate` (typos ok) — redo the last turn on the smartest model. `escalate <model>` or `escalate <number>` targets a specific tier; type `escalate ` + space for a picker.
- `/<skill>` — force a specific skill/tool; type `/` for an autocomplete of skills + commands.
- `/ban <skill> <model>` / `/unban <skill> <model>` — manage the ban list (see §7).
- `/hasync` — scan Home Assistant and (re)build the `home-assistant-devices` skill.

---

## 4. How answers are routed (the ladder)

Every message stops at the first tier that can handle it: **Calculator** (pure math, no model) → **free cloud** → **paid** (only if you added one) → **local** (last resort) → **Claude** (escalation / hard tasks only). Reorder or trim tiers in **Providers**. Claude runs on your flat subscription; heavy days don't cost extra.

---

## 5. Sub-agents

Create one with **+ new agent** (or Zamolxis makes one itself mid-job). Each agent row has: **run · job · analyze · schedule · stop/resume · delete**, plus a **fix** link when it's inactive.

- **Runs on (model):** choose **Auto** (the smartest model picks the executor when it compiles the job) or pin a specific tier (Local / Free cloud / a provider / Claude). If you pin a model the planner thinks is too weak, it warns you and offers a safer one — **declining keeps your choice**.
- **Job:** opens a modal with the plain-language instructions **and** the compiled plan (read-only). Editing + **Save & recompile** re-runs the smart-model compile (instructions, skills, schedule, risk) — exactly like creating it. You can also change the model here.
- **Inactive + Fix:** if an agent's model isn't available right now (local not configured, a provider key missing, Claude logged out), the agent shows `[inactive]` and a **fix** link before **run**. Fix opens the Job modal explaining why and lets you switch models; saving re-validates.
- **Dedicated vs open:** an agent created **with** instructions runs its standing job on **run** (no prompt). Created **blank** = an *open* agent that asks for a task each run.
- **Schedules:** plain-language ("every minute", "weekdays at 9am") → cron via the smart model. **Stop** suspends all of an agent's schedules and halts it.
- **Agent-created agents:** show in the panel with an **auto** badge and follow the same rules. By default they're **temporary** (purged on restart); enable *"Keep agents that Zamolxis created itself after restart"* in Settings to persist them.
- **Lean executors:** a sub-agent's prompt is just its compiled spec + its tools + the authoritative time — no persona/profile/learnings (the smart model bakes anything relevant into the spec at compile time).

> Tip: small local models can't reliably hold a strict format or echo an injected value (e.g. the time) — pin time/precision-critical agents to **Free cloud** or **Claude**, not Local.

---

## 6. Local model

Tools → **Local model**. Install Ollama in place if missing, pull general-chat all-rounders (all tool-capable: llama3.2, mistral, llama3.1, hermes3, mistral-nemo, …) with live progress, keep several and switch the active one any time, and tune routing / context / keep-alive / temperature. The rail shows `Local - <model>`.

---

## 7. Skill bans

A `(model, skill)` ban makes that model refuse that capability (`"I can't, I am banned!"`) while routing prefers a non-banned model. The **smartest model can never be banned**. Manage via `/ban` `/unban` in chat or the **Memory → Skill bans** editor. Escalating right after the local model used a skill auto-bans local from it.

---

## 8. Memory & channels

Persistent files (in your data dir): **LAWS.md** (inviolable safety rules), **SOUL.md** (persona, you own it), **USER.md** (your profile, agent-maintained), **MEMORY.md** (working notes), **LEARNINGS.md** (lessons captured when the smart model rescues a failure). Connect Telegram/Discord/Slack/WhatsApp/Signal/Email in Settings; all feed and mirror the one Main chat.
