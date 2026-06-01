# Zamolxis

Zamolxis is a self-hosted AI agent that runs on your own machine. You talk to it through whatever you like - a web page, Telegram, Discord, email, and more - and it remembers things between conversations, writes its own little "skills", schedules tasks, and can run shell commands or browse the web when a job calls for it.

It runs mainly on your Claude Pro/Max subscription (not the pay-per-token API), and it's careful with that quota: a routing chain can hand the easy work to a free local model or to free and cheap cloud providers, so most messages cost you nothing. You can even leave Claude out of the chain entirely and run on local plus free models only.

## Disclaimer

Use at your own risk. Zamolxis is provided "as is", with no warranty of any kind. The authors and contributors are not liable for any damage, data loss, cost, account action, or other harm that comes from using it.

A few things worth keeping in mind:

- It's an autonomous agent. It can run shell commands, reach the web, and act on your behalf. Only run it somewhere you trust, check what you've told it to do, and keep backups. The safety rules in `LAWS.md` help, but they're a prompt-level guardrail, not a hard security guarantee.
- You're responsible for following the rules. That includes the terms of service of Anthropic and any model, API, or messaging provider you connect - rate limits, acceptable use, all of it. Don't use Zamolxis to break a provider's terms (for example, piling several accounts onto one provider) or any law.
- It isn't affiliated with Anthropic, or anyone else. "Claude" and other names belong to their owners and are mentioned only so you know what works with what.
- Your secrets stay yours. Keys and tokens live in your local `.env` and settings files, are never committed to git, and never leave your machine.

## What powers it: your subscription (and friends)

A Claude subscription doesn't hand you metered API access. What it does give you is the Claude Code engine, which the Agent SDK drives using the login you create with `claude login`. Zamolxis is built on that engine, so:

- The agent runs on your subscription. Don't set `ANTHROPIC_API_KEY` - if it's there, Zamolxis hides it so your subscription is used instead. (If you genuinely want metered billing, set `ZAMOLXIS_ALLOW_API_KEY=1`.)
- You live within your plan's rate limits, not pay-as-you-go. Zamolxis caps how many turns run at once (`ZAMOLXIS_MAX_CONCURRENT`) so an always-on agent doesn't burn through your quota.
- Two extras can't run on the subscription. They're optional and only switch on if you supply a key: cross-provider model routing and image generation. Switching between the Claude models (Opus, Sonnet, Haiku) is free.

## You're not locked to Claude

Every message flows through a routing chain you control, so most work can run for free and you decide how much (if any) touches your subscription:

- Local model (free, on your machine). A small model running through [Ollama](https://ollama.com) answers the easy stuff completely offline, for zero subscription tokens. The installer shows you a menu of models that fit your hardware.
- Free cloud tiers. Drop in free API keys for Google (Gemini), Cerebras, Groq, Mistral, or OpenRouter. Zamolxis rotates between them - least-used first, skipping any that hit their daily limit. One key per provider.
- Paid providers, if you want them. OpenAI or DeepSeek (billed to you) work too; just add them to the chain. Completely optional.
- Claude, on your subscription. The default top tier and the brains behind the agent's tool use.

You arrange these in the web Providers panel. For example: `local, freecloud, claude` (the default), `local, freecloud` (no Claude at all - local and free only), or `local, deepseek, claude` (a paid provider in the middle). The tool-using core does need `claude login`, but everyday replies can come from the local model or other providers, so you save - or completely skip - subscription usage. There's more detail in the local model section below.

## Install

You'll need [Node.js](https://nodejs.org) 20 or newer, [git](https://git-scm.com), and Claude Code logged in with a Pro/Max subscription. Log in once:

```
claude login
```

Then clone the repo and run the installer for your system. It checks prerequisites, installs dependencies, builds, creates a `.env`, and runs a quick readiness check. (Every code block here has a copy button - just click it.)

Windows (PowerShell):

```powershell
git clone https://github.com/itoderry/Zamolxis.git; cd Zamolxis; powershell -ExecutionPolicy Bypass -File .\install.ps1
```

macOS (Terminal):

```bash
git clone https://github.com/itoderry/Zamolxis.git && cd Zamolxis && bash install.sh
```

Linux (shell):

```bash
git clone https://github.com/itoderry/Zamolxis.git && cd Zamolxis && bash install.sh
```

Flags you can add: `-Web` / `--web` (browser UI), `-Web -Open` / `--web --open` (UI, opened right away), `-Service` / `--service` (start at logon), and `-Local` / `--local` (pick an on-device model that fits your hardware - more on that below).

Once it's installed, start the browser UI any time with `npm run web` and open http://127.0.0.1:8787. Or chat in the terminal with `npm run cli` and try something like *"create a skill called morning-brief"* or *"schedule a reminder every weekday at 9am"*. To turn on messaging channels, set them in `.env` and restart.

Updating is just a pull and a re-run, since you installed from git:

```bash
git pull && bash install.sh          # macOS/Linux
```
```powershell
git pull; powershell -ExecutionPolicy Bypass -File .\install.ps1   # Windows
```

Check everything's healthy any time with `npm run doctor`:

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

### Prefer to do it by hand?

```bash
git clone https://github.com/itoderry/Zamolxis.git && cd Zamolxis
npm install && npm run build
cp .env.example .env   # optional - the defaults are fine
npm run cli
```

## The local model (optional, for the easy stuff)

Zamolxis thinks with Claude through your subscription, and that part doesn't change. But you can bolt on a small model that runs on your own machine and let the agent hand it the trivial jobs - summarizing, classifying, extracting, reformatting, drafting boilerplate - so you spend less of your quota.

When you pass the local flag, the installer looks at your hardware: RAM, and any dedicated GPU (NVIDIA, AMD, or Arc on Windows and Linux, Apple Silicon on macOS). It only offers a local model if your machine can make good use of one (a dedicated GPU, or at least 8 GB of RAM). Then it shows a menu of models that fit, tells you what each is good at, and asks before installing the one you pick. From there it installs Ollama, pulls the model, writes your `.env`, and tests it:

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

A few more flags: `-Yes` / `--yes` installs the recommended pick without asking, `-Bigger` / `--bigger` points the menu's default at the largest model that still fits, and `-Force` / `--force` lets you install a small one even on a modest machine. With a CUDA/ROCm GPU or Apple Silicon, the model is GPU-accelerated automatically. Skip the flag entirely and the installer just shows the menu it would offer, without installing anything. `zamolxis doctor` reports the current status.

**How it saves your subscription.** Once a local model is set up, `ZAMOLXIS_LOCAL_ROUTING` decides how it's used:

- `auto` (the default when a local model exists): simple messages - short ones with no tools, web, scheduling, memory, or code - are answered entirely by the local model, so your subscription isn't touched at all. Anything that needs tools, the web, scheduling, memory, or real reasoning is handed up to Claude automatically, and the local model can also choose to hand off by saying `<ESCALATE>`. If it fails, Claude takes over.
- `off`: every message goes to Claude, and the local model is only there as the `ask_local_model` tool.

**It can reach the internet too.** The local model runs a small tool loop with real tools your machine carries out: `http_get` (fetch any URL - a public API, a website, or something on your LAN like Home Assistant) and, if you've set a search key, `web_search` (Tavily or Brave). So a skill that points at an endpoint lets even the offline model pull live data for free: it asks for the call, your machine makes it, and it gets back only the real result. Without a search key it can still fetch URLs you give it or that a skill names. A 3B model is doing its best here - for heavier tool use, install a bigger model, or let it escalate to Claude.

**Choosing the order of tiers.** A message moves through your chain of backends, and each one passes it along when it can't handle it. You set the chain in the Providers panel. The pieces are `local`, `freecloud` (rotate through your free providers), any single provider id (`google`, `cerebras`, `groq`, `mistral`, `openrouter`, plus paid `openai` / `deepseek`), and `claude`. Some examples:

- `local, freecloud, claude` (default): your machine first, then free cloud, then your subscription.
- `local`: on-device only - fully offline and private, no cloud.
- `local, freecloud`: no Claude - local and free tiers only. If nothing can handle it, Zamolxis tells you, instead of spending your subscription.
- `local, deepseek, claude`: slot a paid provider in wherever you like.

Free providers rotate (least-used first, skipping any at their daily cap). Use one key per provider - piling several accounts onto the same provider breaks their rules, but spreading across different providers is fair game. Paid providers are billed to you and only used if you put them in the chain. The panel shows each provider's status, how much you've used today, a link to get a key, a field to paste it, and a few ready-made orderings. Per-message overrides (and saying "wrong" or "escalate") still jump straight to Claude when it's in the chain.

**When the local model gets stuck, the best model steps in - and learns.** If a local turn can't cope (it needs tools or the web, or it signals `<ESCALATE>`), the job goes to your smartest model (`ZAMOLXIS_SMART_MODEL`, `opus` by default) rather than the everyday one. That turn is also nudged to write a reusable skill capturing how it solved the problem. Those skills are then shown to the local model next time, so it can follow the ones it's capable of, or cleanly hand off the ones that need something it doesn't have. (A skill can't give the local model new powers like internet access - for those it just learns to escalate sooner; for knowledge tasks, it can now follow the steps itself.)

In the web UI, the local model shows up in the header's model list, the model that answered the last message is highlighted, and next to the message box there's an Auto / Local / Claude switch to force a conversation one way or the other. A per-chat model picker (Default / Opus / Sonnet / Haiku) lets you trade depth for speed in a single conversation without changing your global default. Anything answered locally costs zero subscription tokens and is labelled `local:<model>` in the usage panel.

## Taking your setup to a new machine

`zamolxis pack` rolls your current setup into one portable JSON file you can use to seed a fresh install. It always includes every skill (even the ones the models wrote themselves) and asks whether to also bring along your persona (`SOUL.md`), your profile (`USER.md`), and the things it has learned (`LEARNINGS.md`):

```
zamolxis pack                      # asks what to include
zamolxis pack --all                # skills + soul + user + learnings
zamolxis pack --soul --teachings   # pick exactly what you want
# writes ~/.zamolxis/exports/zamolxis-pack-<stamp>.json
```

On the new machine, install Zamolxis and then run `zamolxis unpack <that-file.json>` to drop the skills and any included files into place. You can also just ask for it in chat or the web UI ("pack my setup") - the agent will ask what to include and handle it. Skills live in the web Skills panel, where you can view, enable, disable, or delete them (including the model-created ones).

## The `zamolxis` command

Install the command once so it's available everywhere. This symlinks it to the repo, so future rebuilds apply automatically:

```
npm run build
npm link            # puts `zamolxis` on your PATH
```

Then run it from anywhere:

```
zamolxis run        # foreground (web UI + channels from .env; Ctrl+C to stop)
zamolxis start      # background (keeps running after you close the terminal)
zamolxis status     # RUNNING (pid) / STOPPED
zamolxis stop
zamolxis restart
zamolxis doctor     # readiness check
zamolxis cli        # foreground, interactive CLI
zamolxis run --channels=telegram,web   # extra args pass through to the daemon
```

Background instances run detached and are tracked by a pidfile (`~/.zamolxis/zamolxis.pid`), with logs in `~/.zamolxis/logs/zamolxis.log`. If you skip the global link, the same things are available as `npm run start:bg` / `stop` / `restart` / `status`, or `node bin/zamolxis.mjs <command>`.

## Running it as a service (start at logon)

The daemon is happy running unattended: with no terminal it logs JSON and stands the CLI down, and a heartbeat keeps a process manager from restart-looping it while idle. Run it as yourself, not as a system or root service - the engine needs to read your `claude login` credentials from your home folder, which a LocalSystem or root account won't have.

Windows (Task Scheduler, no admin needed):

```
npm run build
npm run service:install     # starts Zamolxis when you log in
npm run service:start       # start it now
npm run service:status
npm run service:stop
npm run service:uninstall
```

Any OS (pm2):

```
npm run build
npm run pm2:start           # uses ecosystem.config.cjs
pm2 save && pm2 startup     # survive reboots (run the command it prints)
npm run pm2:logs
```

Linux (systemd): see `scripts/zamolxis.service` - use a `--user` service with `loginctl enable-linger`, or set `User=` to your account.

For service mode, turn on at least one messaging channel in `.env` (`ZAMOLXIS_CHANNEL_TELEGRAM=true`, and so on) - the interactive CLI is off when there's no terminal.

## Safety rules (Asimov-style)

On top of SOUL/USER/MEMORY there's a fourth layer: `LAWS.md`, a small safety constitution adapted from [Asimov's Laws of Robotics](https://en.wikipedia.org/wiki/Three_Laws_of_Robotics) for a software agent. It sits at the very top of every system prompt (the local model's too) and is written to override the persona, your profile, the agent's memory, and anything said in chat. The agent has no way to edit it - only you can, in Settings.

The default rules, most important first (lower number wins a conflict):

0. Do no harm to people or society. No violence or weapons, no helping with self-harm, no malware or intrusion, no fraud, surveillance, harassment, CSAM, or anything clearly illegal or dangerous.
1. Do no harm to you or your things. Routine, reversible work needs no permission; only risky or hard-to-undo actions (bulk deletes, wipes, force-pushes, spending money, sending messages as you, changing credentials, exposing secrets) need an explicit OK. Never leak private data.
2. Do what you ask, unless it clashes with rule 0 or 1, or would deceive or harm someone else.
3. Be honest. Don't pretend to be human, don't make up actions or results, and be upfront about uncertainty.
4. Look after itself, but last. Keep running, but never by deceiving you, resisting shutdown, or getting around these rules.

You can edit them in Settings -> Identity & memory (there's a "Reset to defaults" button), and a checkbox lets you turn the rules on or off if you want to compare behavior. They're only about 600 tokens, so the speed cost is tiny - the model you pick matters far more. This is a prompt-level safeguard that strongly shapes behavior; for harder guarantees, also use `ZAMOLXIS_DISALLOWED_TOOLS` and a stricter permission mode.

If you set a search key (`TAVILY_API_KEY` or `BRAVE_API_KEY`), Claude also gets a `web_search` tool, so it can search reliably without leaning on Claude Code's built-in web access.

## How it's put together

```
channels  ->  ChannelManager  ->  Engine  ->  Claude Agent SDK (query)
  cli                            |             - subscription OAuth, tools, subagents
  telegram                       |- SessionStore    (resume each conversation)
  discord/slack/...              |- Throttle        (subscription backpressure)
                                 |- buildMcpServers (in-process tools, per turn)
scheduler  - cron/one-shot jobs                     schedule_task, create_skill, ...
skills     - SKILL.md files, shared across conversations
```

- Each conversation gets its own workspace. It lives at `~/.zamolxis/workspaces/<key>/` with its own `CLAUDE.md`, a durable `memory.md`, and a link to the shared skills folder. The SDK resumes that conversation's session across restarts.
- Tools run in-process: `schedule_task`, `list_scheduled`, `cancel_scheduled`, `create_skill`, `list_skills`. They're wired to the live conversation, so a scheduled job comes back to the right chat. (These callbacks need streaming-input mode, which the engine uses.)
- Skills are just folders. The agent writes its own `SKILL.md` files, and they show up in every conversation on the next turn.

## Channels

| Channel  | Library            | Credentials (in `.env`)                                   | Notes |
|----------|--------------------|-----------------------------------------------------------|-------|
| CLI      | built-in           | none                                                      | always available |
| Telegram | grammy             | `TELEGRAM_BOT_TOKEN`                                       | long-polling bot |
| Discord  | discord.js         | `DISCORD_BOT_TOKEN`                                        | DMs and @-mentions |
| Slack    | @slack/bolt        | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`                       | Socket Mode; DMs and mentions |
| WhatsApp | @whiskeysockets/baileys | none (QR pairing on first run)                       | creds persist under `<dataDir>/whatsapp-auth` |
| Signal   | signal-cli (JSON-RPC) | `SIGNAL_NUMBER`, optional `SIGNAL_CLI_PATH`             | needs `signal-cli` installed and a registered number |
| Email    | imapflow + nodemailer | `EMAIL_IMAP_HOST/USER/PASSWORD`, `EMAIL_SMTP_HOST`, ... | polls IMAP, replies over SMTP |
| Web      | http + ws (built-in)  | `ZAMOLXIS_WEB_PORT`, `ZAMOLXIS_WEB_BIND`, `ZAMOLXIS_WEB_AUTH_TOKEN` | browser chat UI + Settings panel, streaming |

Turn channels on with `ZAMOLXIS_CHANNEL_*=true` (or `--channels=cli,web`). A channel whose credentials are missing logs an error and is skipped - the rest still start.

### The web interface

Turn it on with `ZAMOLXIS_CHANNEL_WEB=true` and open http://127.0.0.1:8787. The header shows a live clock (your machine's local time) and a login indicator: green "login ok" while your Claude token is valid (hover to see when it renews), or red "login expired" telling you to run `claude login`. It's a streaming chat page plus a full Settings panel (the gear icon):

- Engine (applies on your next message): the agent's name (the single source of truth for what it calls itself, used in the persona and shown everywhere), main and fast models, permission mode, default sandbox, max turns and concurrency, and extra system-prompt text.
- Identity & memory (applies on your next message): `LAWS.md` (the safety rules, above), `SOUL.md` (its persona and voice - this one's yours, the agent won't rewrite it), `USER.md` (your profile, which the agent keeps up to date as it learns about you, but you can edit), and a read-only view of its working `MEMORY`.
- Channels (restart): turn each channel on or off.
- Credentials (restart): tokens and hosts for every channel - Telegram (token plus an allowed-users list), Discord, Slack, Signal, Email (IMAP/SMTP), plus OpenAI/OpenRouter keys. Secrets are write-only: you see whether they're set, never the value.
- Web (restart): port, bind address, auth token. Sandbox (restart): docker image/container, ssh host/user/port/identity.
- Paid model usage (read-only): token counts for the metered add-ons (`ask_external_model`, `generate_image`), per model, for this session and all time. Saved to `~/.zamolxis/usage.json` and summarized by `zamolxis doctor`. (Your Claude subscription isn't token-metered, so it isn't counted here.)

Everything saves to `~/.zamolxis/settings.json`, and saving applies it for you: engine fields take effect on the next message, while channel, credential, web, and sandbox changes reload the channels in place (no manual restart) and a popup tells you the page is reconnecting. Change the web port and the popup gives you the new URL to open, since it can't follow you there. A bad token only breaks its own channel - everything else, including the web UI, keeps running so you can fix it.

- Local and safe by default: `ZAMOLXIS_WEB_BIND=127.0.0.1` means only this machine can reach it, no token needed.
- On your network: set `ZAMOLXIS_WEB_BIND=0.0.0.0` (or a LAN IP) and `ZAMOLXIS_WEB_AUTH_TOKEN=<secret>`. Because the agent can run shell commands, Zamolxis refuses to start the web channel on a non-loopback address without a token - the browser then asks for it and remembers it locally.

## Where things stand

Working and verified end-to-end on the subscription: the core engine, session resume, throttling, the CLI channel, the scheduler (persisted cron and one-shot jobs), self-written skills, and in-process tool calls.

Built and tested for construction, with the live round-trip waiting on your tokens: all six messaging adapters - Telegram, Discord, Slack, WhatsApp, Signal, and Email. Channels without credentials skip themselves, and the daemon shrugs off the odd channel-SDK error.

Sandbox backends (the `sandbox_exec` tool): `local` (verified - prefers git-bash/POSIX and falls back to PowerShell on Windows), `docker`, `ssh`, and `modal`. Backends that aren't available return a clear error instead of crashing. Modal ships `src/sandbox/modal_runner.py` and needs the modal CLI plus tokens; Docker and SSH use their own CLIs.

Optional paid add-ons (key-gated, not on the subscription): `generate_image` (OpenAI, only with `OPENAI_API_KEY`) and `ask_external_model` (OpenAI/OpenRouter, with either key). No key, no tool.

The feature set is complete across memory, skills, scheduling, delegation, multi-channel messaging, sandboxing, and model routing.

## Requirements

Node 20 or newer, and Claude Code logged in (`claude login`) with a Pro/Max subscription. Needs `@anthropic-ai/claude-agent-sdk` 0.3 or later (the older 0.1.x has a tool-call serialization bug).

## License

MIT - see the [LICENSE](LICENSE) file. As the disclaimer above says, it's provided "as is" with no warranty, and you're responsible for following the terms of service of any providers you connect.
