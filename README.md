# Zamolxis

A self-hosted, multi-channel **autonomous agent** built on the **Claude Agent SDK** — persistent memory, self-authored skills, scheduling, subagent delegation, shell + web access — funded entirely by your **Claude Pro/Max subscription** rather than the metered API.

## Disclaimer

> **Use at your own risk.** Zamolxis is provided "as is", without warranty of any kind, express or implied. The authors and contributors accept **no liability** for any damage, data loss, cost, account action, or other harm arising from its use.
>
> - **It is an autonomous agent that can run shell commands, access the web, and act on your behalf.** Run it only in an environment you trust, review what it's configured to do, and keep backups. The built-in safety **`LAWS.md`** is a best-effort *prompt-level* safeguard, **not** a hard security guarantee.
> - **You are responsible for compliance** with the terms of service of Anthropic and any model/API/messaging providers you connect, including all rate-limit and acceptable-use rules. Do not use it to violate any provider's ToS (e.g. stacking multiple accounts on one provider) or any applicable law.
> - **Not affiliated with, endorsed by, or sponsored by Anthropic** or any other provider. "Claude" and other names are trademarks of their respective owners and are referenced only for interoperability.
> - **You manage your own secrets.** Keys and tokens live in your local `.env` / settings and are never committed; keep them private.

## Why the subscription matters

A Claude subscription does not grant metered Messages-API access. What it *does* power is the **Claude Code engine**, which the Agent SDK drives using the OAuth credentials stored by `claude login`. Zamolxis is built on that engine, so:

- The whole agent runs on your subscription. **Never set `ANTHROPIC_API_KEY`** — if present, it's hidden from the engine so the subscription is used (override with `ZAMOLXIS_ALLOW_API_KEY=1`).
- You're governed by **subscription rate limits** (rolling windows), not pay-as-you-go. Zamolxis throttles concurrent turns (`ZAMOLXIS_MAX_CONCURRENT`) so an always-on agent doesn't burn the quota.
- Two features can't be subscription-funded and are optional, key-gated plugins that degrade gracefully without keys: **cross-provider model routing** and **image generation**. Routing *within* the Claude family (Opus/Sonnet/Haiku) is free.

## Install

**Prerequisites:** [Node.js](https://nodejs.org) ≥ 20, [git](https://git-scm.com), and a logged-in Claude Code with a Pro/Max subscription. Authenticate once so the agent can use your subscription:

```
claude login
```

Then **clone the repository and run the installer** for your OS. The installer checks prerequisites, installs dependencies, builds, scaffolds `.env`, and runs a readiness check. (Click the copy icon on any block.)

**Windows** — PowerShell:

```powershell
git clone https://github.com/halusc/Zamolxis.git; cd Zamolxis; powershell -ExecutionPolicy Bypass -File .\install.ps1
```

**macOS** — Terminal:

```bash
git clone https://github.com/halusc/Zamolxis.git && cd Zamolxis && bash install.sh
```

**Linux** — shell:

```bash
git clone https://github.com/halusc/Zamolxis.git && cd Zamolxis && bash install.sh
```

Useful flags (append to the installer): `-Web` / `--web` (browser UI), `-Web -Open` / `--web --open` (UI + launch now), `-Service` / `--service` (auto-start at logon), `-Local` / `--local` (offer a menu of on-device models that fit your hardware — see below).

After install, start the browser UI any time with `npm run web`, then open `http://127.0.0.1:8787`. Talk to it with `npm run cli` and try *"create a skill called morning-brief"* or *"schedule a reminder every weekday at 9am"*. For messaging channels, enable them in `.env` and restart.

**Updating** — because you installed from git, updates are a pull + reinstall:

```bash
git pull && bash install.sh          # macOS/Linux
```
```powershell
git pull; powershell -ExecutionPolicy Bypass -File .\install.ps1   # Windows
```

Verify any time with `npm run doctor`:

```
Zamolxis doctor
===============
[OK  ] Node v24.16.0 (need >= 20)
[OK  ] Claude subscription credentials (subscription (OAuth))
[OK  ] Build present
[OK  ] Channels enabled: cli
[OK  ] Sandbox backends: local, modal (default: local)
Ready. Start with:  npm run cli
```

### Manual setup (if you prefer)
```bash
git clone https://github.com/halusc/Zamolxis.git && cd Zamolxis
npm install && npm run build
cp .env.example .env   # optional — defaults are fine
npm run cli
```

## Local model (optional, easy-task offload)

Zamolxis's brain is Claude (via the subscription) — that can't be swapped. But a small **on-device model** can be wired in as a free offload target the agent hands *trivial* subtasks to (summarize, classify, extract, reformat, draft boilerplate) to conserve subscription quota.

The installer detects your hardware — RAM **and any dedicated GPU** (NVIDIA/AMD/Arc via `nvidia-smi`/registry on Windows, `nvidia-smi`/`lspci` on Linux, Apple Silicon Metal on macOS) — and only offers a local model if the machine is **powerful enough** (a dedicated GPU, or ≥ 8 GB RAM). With one flag it presents a **menu of models that fit your hardware**, each with its strength, and **asks before installing** your pick (then installs Ollama, pulls the model, configures `.env`, and verifies it):

```
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Local    # Windows
bash install.sh --local                                          # macOS/Linux
```

```
Local models that fit this machine (~8GB budget):
  [1] qwen2.5:1.5b      tiny & fast - fine for routing / simple offload
  [2] llama3.2:3b       fast, lightweight general chat; broad knowledge
  [3] qwen2.5:3b        strong tool use for its size - solid small default
  [4] qwen2.5-coder:7b  tuned for code: generation, review, refactors
  [5] qwen2.5:7b        best all-round: instruction following + tool use   <- recommended
  [6] deepseek-r1:8b    step-by-step reasoning & math (thinks first, slower)
Pick a model [1-6, Enter = 'qwen2.5:7b', or 's' to skip]:
```

Flags: `-Yes`/`--yes` installs the recommended model unattended (no prompt); `-Bigger`/`--bigger` defaults the menu to the largest model that still fits; `-Force`/`--force` offers a small model even on an under-spec machine. With a CUDA/ROCm GPU (or Apple Silicon) the model is GPU-accelerated automatically.

Without `-Local`, the installer just reports the menu of models it *would* offer for your hardware. `zamolxis doctor` shows the status.

**How it saves the subscription — routing.** Once a local model is configured, `ZAMOLXIS_LOCAL_ROUTING` controls how it's used:
- **`auto`** (default when a local model exists): Zamolxis answers **simple turns** (short, no tools/web/scheduling/memory/code) **entirely on the local model — the Claude subscription is never touched** for those. Anything that needs tools, the web, scheduling, memory writes, or real reasoning is **automatically escalated to Claude** (the local model can also defer by emitting `<ESCALATE>`). Local failures fall back to Claude too.
- **`off`**: every turn uses Claude; the local model stays available only as the `ask_local_model` offload tool.

**Local model tools (it can reach the internet).** The local model runs a small tool-use loop with real tools your machine executes: **`http_get`** (fetch any URL — public APIs, websites, or your LAN like Home Assistant) and, if a search key is set, **`web_search`** (Tavily or Brave via `TAVILY_API_KEY` / `BRAVE_API_KEY`). So a **skill** that names an endpoint lets the offline model genuinely fetch live data for free (it requests the call; the harness performs it; it reports only the real result). Without a search key it can still `http_get` URLs it's given or that a skill specifies. With a search key, auto-routing also lets the local model take current/web questions instead of always handing them to Claude. (A 3B model is best-effort at this — for heavier tool use install the bigger model with `-Local -Bigger`, or it escalates to Claude.)

**Routing chain — you choose the order (and which tiers).** A turn flows through an ordered chain of backends; each hands off to the next when it can't cope. You set the chain in the web **Providers** panel — tokens are `local`, `freecloud` (rotate your configured free providers), any **provider id** (`google`, `cerebras`, `groq`, `mistral`, `openrouter`, and **paid** `openai`/`deepseek`), and `claude`. Examples:
- `local, freecloud, claude` (default) — on-device → free cloud → subscription.
- `local` — **only** on-device (no cloud, fully offline/private).
- `local, freecloud` — **no Claude**: local + free tiers only (if nothing can do it, it says so rather than spending the subscription).
- `local, deepseek, claude` — insert a **paid** provider where you want it.

Free providers rotate (least-used first, skipping any at their daily cap); add **one key per provider** (stacking many accounts on the *same* provider breaks ToS — stacking *across* providers is the legit way). Paid providers (OpenAI, DeepSeek) are billed to you and only used if you put their id in the chain. The panel shows each provider's status, daily usage, a "get a key" link, a key field, and order presets. Per-message overrides and "wrong"/"escalate" still jump to Claude (when it's in the chain).

**Escalation → smartest model → new skill.** When a local turn can't cope (it needs tools/web, or signals `<ESCALATE>`), it's handed to the **smartest** model (`ZAMOLXIS_SMART_MODEL`, default `opus`) rather than whatever the everyday default is — and that turn is directed to **author a reusable skill** (`create_skill`) capturing the procedure. Saved skills are then **surfaced to the local model** on later turns, so it can follow knowledge/procedure skills it's capable of, or defer cleanly when one needs a capability it lacks. (A skill can't grant the local model new powers like internet — for those it learns to escalate faster; for knowledge tasks it can now follow the steps.)

In the **web UI** the local model shows up in the header model list (with a ⚡), the chip for whichever model answered the last turn is highlighted, and a per-chat **Auto / Local / Claude** selector (next to the message box) lets you force a conversation on-device or onto Claude regardless of the default, and a per-chat **model** selector (Default / Opus / Sonnet / Haiku) lets you trade depth for speed per conversation (e.g. pin a chat to Sonnet for snappier replies without changing the global default). Turns answered locally cost **0 subscription tokens** and are labelled `local:<model>` in the usage panel.

## Packing your setup for a new install

`zamolxis pack` bundles your current setup into a single portable JSON file so a fresh install can be seeded from it. It **always includes every skill** (including ones the models created over time) and **asks** whether to also include your persona (`SOUL.md`), your profile (`USER.md`), and the learned facts/teachings (`LEARNINGS.md`):

```
zamolxis pack                      # interactive (asks what to include)
zamolxis pack --all                # skills + soul + user + teachings
zamolxis pack --soul --teachings   # pick exactly what to include
# → writes ~/.zamolxis/exports/zamolxis-pack-<stamp>.json
```

On the new machine, after installing: `zamolxis unpack <that-file.json>` writes the skills and any included files into place. You can also trigger packing from **chat or the web UI** — just ask ("pack my setup"); the agent will ask which parts to include and use its `pack_setup` tool. Skills are managed in the web **Skills** panel (list/view, enable-disable, delete — including model-created ones).

## The `zamolxis` command

Install the command globally (one time — symlinks it to this repo so rebuilds apply automatically):

```
npm run build
npm link            # makes `zamolxis` available on your PATH
```

Then control it from anywhere:

```
zamolxis run        # foreground (web UI + channels from .env; Ctrl+C to stop)
zamolxis start      # background (detached; survives closing the terminal)
zamolxis status     # RUNNING (pid) / STOPPED
zamolxis stop
zamolxis restart
zamolxis doctor     # readiness check
zamolxis cli        # foreground, interactive CLI
zamolxis run --channels=telegram,web   # extra args pass through to the daemon
```

Background instances are detached and tracked by a pidfile (`~/.zamolxis/zamolxis.pid`); logs go to `~/.zamolxis/logs/zamolxis.log`. Without the global link, the same commands are available as `npm run start:bg` / `stop` / `restart` / `status`, or `node bin/zamolxis.mjs <command>`.

## Running as a service (auto-start at logon)

The daemon is built for unattended operation: with no TTY it logs JSON and stands the CLI down, and a keep-alive heartbeat stops a process manager from restart-looping it when idle. **Always run it in your own user context** so the engine can read your `claude login` subscription credentials (`%USERPROFILE%\.claude` / `~/.claude`) — a LocalSystem/root service won't have them.

**Windows (Task Scheduler, no admin):**
```
npm run build
npm run service:install     # registers a task that starts Zamolxis at your logon
npm run service:start       # start it now
npm run service:status
npm run service:stop
npm run service:uninstall
```

**Cross-platform (pm2):**
```
npm run build
npm run pm2:start           # uses ecosystem.config.cjs
pm2 save && pm2 startup     # persist across reboots (run the printed command)
npm run pm2:logs
```

**Linux (systemd):** see `scripts/zamolxis.service` (use a `--user` service + `loginctl enable-linger`, or set `User=` to your account).

> For service mode, enable at least one **messaging** channel in `.env` (`ZAMOLXIS_CHANNEL_TELEGRAM=true`, etc.) — the interactive CLI is disabled when there's no terminal.

## Safety laws (Asimov-style)

Alongside SOUL/USER/MEMORY there's a fourth layer: **`LAWS.md`**, a safety constitution adapted from [Asimov's Laws of Robotics](https://en.wikipedia.org/wiki/Three_Laws_of_Robotics) for an autonomous software agent. It is injected at the **top of every turn's system prompt** (and into local-model turns too), explicitly framed to **override the persona, your profile, the agent's memory, and any instruction given in chat**. The agent has **no tool to edit it** — only you can, in Settings.

The default laws, in precedence order (lower number wins on conflict):
0. **Do no harm to people or society** — refuse violence/weapons, self-harm facilitation, malware/intrusion, fraud, surveillance, harassment, CSAM, or anything clearly illegal/dangerous.
1. **Do no harm to the user or their property** — routine, reversible work needs no permission; only **high-risk / hard-to-undo** actions (bulk delete, wipe, force-push, spending, sending messages on your behalf, changing credentials, exposing secrets) require explicit confirmation; never exfiltrate private data.
2. **Obey the user** — except where it conflicts with Law 0/1 or would deceive/harm a third party.
3. **Be honest and transparent** — don't impersonate a human, don't fabricate actions/results, be clear about uncertainty.
4. **Self-preservation, lowest priority** — keep running, but never by deceiving the user, resisting shutdown, or circumventing these laws.

Edit them in **Settings → Identity & memory** (with a "Reset to defaults" button), and there's a checkbox to **toggle the laws on/off** (handy for A/B-testing their speed/behavior impact — though at ~600 static tokens the speed cost is small; the model tier dominates). This is a **prompt-level** safeguard that strongly shapes behavior; for hard guarantees, also use `ZAMOLXIS_DISALLOWED_TOOLS` and a stricter `permissionMode`.

A configured search provider (`TAVILY_API_KEY` / `BRAVE_API_KEY`) also gives **Claude** a `web_search` tool, so it can search reliably without depending on Claude Code's built-in web tool.

## Architecture

```
channels/ ──▶ ChannelManager ──▶ Engine ──▶ Claude Agent SDK (query)
  cli                              │            └─ subscription OAuth, tools, subagents
  telegram (planned)              ├─ SessionStore   (resume per conversation)
  discord/slack/...(planned)      ├─ Throttle       (subscription backpressure)
                                  └─ buildMcpServers (in-process tools, per turn)
scheduler/  ─ cron/one-shot jobs ─┘                    schedule_task, create_skill, …
skills/     ─ auto-generated SKILL.md, shared across conversations
```

- **Per-conversation workspace** — each chat gets `~/.zamolxis/workspaces/<key>/` with its own `CLAUDE.md`, durable `memory.md`, and a link to the shared skills dir. The SDK resumes that conversation's session id across restarts.
- **In-process MCP tools** — `schedule_task`, `list_scheduled`, `cancel_scheduled`, `create_skill`, `list_skills`. They close over the live conversation so a scheduled job is delivered back to the right chat. (Tool callbacks require **streaming-input mode**, which the engine uses.)
- **Skills** — the agent writes `SKILL.md` folders for itself; they become discoverable in every conversation on the next turn.

## Channels

| Channel  | Library            | Credentials (in `.env`)                                   | Notes |
|----------|--------------------|-----------------------------------------------------------|-------|
| CLI      | built-in           | none                                                      | always available |
| Telegram | grammy             | `TELEGRAM_BOT_TOKEN`                                       | long-polling bot |
| Discord  | discord.js         | `DISCORD_BOT_TOKEN`                                        | DMs + @-mentions |
| Slack    | @slack/bolt        | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`                       | Socket Mode; DMs + mentions |
| WhatsApp | @whiskeysockets/baileys | none (QR pairing on first run)                       | creds persist under `<dataDir>/whatsapp-auth` |
| Signal   | signal-cli (JSON-RPC) | `SIGNAL_NUMBER`, opt. `SIGNAL_CLI_PATH`                 | needs `signal-cli` installed + a registered number |
| Email    | imapflow + nodemailer | `EMAIL_IMAP_HOST/USER/PASSWORD`, `EMAIL_SMTP_HOST`, …   | polls IMAP, replies via SMTP |
| Web      | http + ws (built-in)  | `ZAMOLXIS_WEB_PORT`, `ZAMOLXIS_WEB_BIND`, `ZAMOLXIS_WEB_AUTH_TOKEN` | browser chat UI + Settings panel, streaming |

Enable per channel with `ZAMOLXIS_CHANNEL_*=true` (or `--channels=cli,web`). A channel whose credentials are missing logs an error and is skipped — the rest still start.

### Web interface

Enable with `ZAMOLXIS_CHANNEL_WEB=true`, then open `http://127.0.0.1:8787`. The header shows a live **host-local clock** and a **login indicator** (green "login ok" while the Claude subscription token is valid — hover for when it auto-renews — or red "login expired" prompting `claude login`). It's a streaming chat page plus a full **Settings panel** (gear icon) covering:
- **Engine** (applies on next message): **agent name** (the single source of truth for what the agent calls itself — it's enforced into the persona and shown everywhere in the UI), model + fast model (dropdowns), permission mode, default sandbox backend, max turns/concurrency, system-prompt append.
- **Identity & memory** (applies on next message): `LAWS.md` (an **inviolable safety constitution**, adapted from Asimov's Laws — see below), `SOUL.md` (persona/voice — **you own this**, the agent won't rewrite it), `USER.md` (your profile — **agent-maintained** as it learns about you, but editable here), and a read-only view of the agent's bounded working `MEMORY`.
- **Channels** (restart): enable/disable each channel.
- **Credentials** (restart): every channel's tokens/hosts — Telegram (token + allowed-users allowlist), Discord, Slack, Signal, Email (IMAP/SMTP), plus OpenAI/OpenRouter keys. Secrets are **write-only** (shown as set/not-set, never echoed back).
- **Web** (restart): port, bind, auth token. **Sandbox** (restart): docker image/container, ssh host/user/port/identity.
- **Paid model usage** (read-only): token counts for the metered plugins (`ask_external_model`, `generate_image`), broken down per model, both **this session** and **all-time**. Persisted to `~/.zamolxis/usage.json`; also summarized by `zamolxis doctor`. (The Claude subscription itself isn't token-metered, so it's not counted here.)

All settings persist to `~/.zamolxis/settings.json`. **Saving applies them automatically:** engine fields take effect on the next message; channel/credential/web/sandbox changes trigger a **live reload** (the channels restart in-process — no manual restart needed) and a popup tells you the page is reconnecting. If you change the web **port**, the popup gives you the new URL to open (it can't auto-follow). A bad token only fails its own channel — the rest, including the web UI, keep running so you can fix it.

- **Local (default, safe):** `ZAMOLXIS_WEB_BIND=127.0.0.1` — reachable only from this machine, no token needed.
- **Network:** set `ZAMOLXIS_WEB_BIND=0.0.0.0` (or a LAN IP) **and** `ZAMOLXIS_WEB_AUTH_TOKEN=<secret>`. Because the agent can run shell commands, Zamolxis **refuses to start the web channel on a non-loopback address without a token** — the browser then prompts for it and stores it locally.

## Status

**Working & verified end-to-end on the subscription:** core engine, session resume, throttle, CLI channel, scheduler (persisted cron/one-shot jobs), self-authored skills, in-process MCP tool calls.

**Built, compiled, and construction-tested (live round-trip needs your tokens):** all six messaging adapters — Telegram, Discord, Slack, WhatsApp, Signal, Email. Missing-credential channels skip gracefully; the daemon survives stray channel-SDK errors.

**Sandbox backends (`sandbox_exec` tool):** `local` (verified executing via the agent — prefers git-bash/POSIX, falls back to PowerShell on Windows), `docker`, `ssh`, `modal`. Unavailable backends return a clear error instead of crashing. Modal ships `src/sandbox/modal_runner.py` and needs the `modal` CLI + tokens; Docker/SSH use their CLIs.

**Optional paid plugins (key-gated, NOT subscription-funded):** `generate_image` (OpenAI, appears only with `OPENAI_API_KEY`) and `ask_external_model` (OpenAI/OpenRouter, appears with either key). Without the keys these tools simply don't exist.

The feature set is now complete across memory, skills, scheduling, delegation, multi-channel messaging, sandboxing, and model routing.

## Requirements

Node ≥ 20, and a logged-in Claude Code (`claude login`) with a Pro/Max subscription. Requires `@anthropic-ai/claude-agent-sdk` ≥ 0.3 (earlier 0.1.x has a tool-call serialization bug).
