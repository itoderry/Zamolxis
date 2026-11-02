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
zam run-agent <name>        # run one agent now (what each Windows agent task calls)
zam install-agent-tasks     # Windows: let Task Scheduler trigger your scheduled agents
zam remove-agent-tasks      # Windows: delete those tasks, back to the in-process timer
zam list-agent-tasks        # Windows: list the agent tasks under Task Scheduler \ Zamolxis
zam help          # this help summary
```
`zamolxis` is an alias for `zam`. The web UI is at **http://127.0.0.1:8787** when `ZAMOLXIS_CHANNEL_WEB=true`.

`install-agent-tasks` creates one task per scheduled agent (folder **Zamolxis** in Task Scheduler) and sets `ZAMOLXIS_AGENT_TRIGGER=windows` in `.env`, so agents fire even when Zamolxis is closed and the in-process timer doesn't double-fire them. `remove-agent-tasks` reverses it.

> **Separate OS user (enhanced security):** `scripts\service-install.ps1 -RunAsUser <account>` runs the background service under a dedicated low-privilege Windows account (starts at boot; that account needs its own `claude setup-token` token in `.env` and its own `ZAMOLXIS_DATA_DIR`). On Linux, set `User=` plus the hardening lines in `scripts/zamolxis.service`. See the README.

> **Long tasks:** the per-message wall-clock timeout defaults to **30 minutes** (`ZAMOLXIS_TURN_TIMEOUT_SECONDS=1800`), so long autonomous jobs (research, building a document, multi-tool chains) aren't cut short. Raise it in Settings → Engine → *Turn timeout* (e.g. 3600 = 1 hour) for exceptionally long work.

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

**Permissions:** in the `default` permission mode Zamolxis **asks before using a tool or resource**: an inline card in the chat with **Allow once · Always allow · Deny · Always deny** (the CLI asks `[y] [a] [n] [d]`). "Always" answers are remembered per **chat**, per **skill** (when you forced one with `/skill`), and per **sub-agent**, and can be reviewed/revoked in **Settings → Permissions**. Grants persist in `<data dir>/permissions.json`. Scheduled/unattended runs follow the remembered grants and otherwise proceed, so they never wait on a prompt; an unanswered prompt (5 minutes, or the tab closed) denies just that one call. Switch the posture in **Settings → Engine → Permission mode** or `ZAMOLXIS_PERMISSION_MODE` in `.env` (acceptEdits / bypassPermissions skip asking).

**Desktop alerts:** every proactive alert (watchers, Site Sentinel, Jira, triggers) also pops a **native OS notification** (Windows toast / macOS / Linux notify-send). Turn it off in **Settings → System → Proactive**.

---

## 4. How answers are routed (the ladder)

Every message stops at the first tier that can handle it: **Calculator** (pure math, no model) → **free cloud** → **paid** (only if you added one) → **local** (last resort) → **Claude** (escalation / hard tasks only). Reorder or trim tiers in **Providers**. Claude runs on your flat subscription; heavy days don't cost extra.

---

## 5. Sub-agents

The **pre-made agents** (Mail Sentinel, Jira Sentinel, Jira Watcher, News Brief, Chief of Staff, ...) are seeded once and run **headless by default**: each has its own schedule and an activity feed, and you flip the **Chat window** toggle in its app if you want to talk to one directly.

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

Persistent files (in your data dir): **LAWS.md** (inviolable safety rules, applied to every chat and agent run on every model, local and provider models included), **SOUL.md** (persona, you own it), **USER.md** (your profile, agent-maintained), **MEMORY.md** (working notes), **LEARNINGS.md** (lessons captured when the smart model rescues a failure). Connect Telegram/Discord/Slack/WhatsApp/Signal/Email in Settings; all feed and mirror the one Main chat.

**Slack** runs in Socket Mode (no public URL). Quick path: create an app at api.slack.com/apps → enable Socket Mode (gives the `xapp-` App-Level token, scope `connections:write`) → add bot scopes `app_mentions:read`, `chat:write`, `im:history`, `im:read`, `im:write` → subscribe to events `app_mention` + `message.im` → Install to Workspace (gives the `xoxb-` Bot token). Paste `SLACK_BOT_TOKEN` (xoxb-) and `SLACK_APP_TOKEN` (xapp-) in Settings → Channels → Slack, enable the Slack channel, restart. Then DM the bot or `/invite @Zamolxis` to a channel and @-mention it. Ask Zamolxis **"connect slack"** to be walked through it (the connect-slack skill).

**Jira** is configured in Settings → Integrations → Jira (base URL, account email, API token from id.atlassian.com, optional default project key); the Jira tools and the Jira Sentinel / Jira Watcher agents use it.
