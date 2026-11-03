# Changelog

## Unreleased (0.3.x)

- **Code chats stay on Claude.** After Claude edited files, ran commands or delegated work in a chat,
  a short follow-up such as "it doesn't really work" went to the free providers under Auto routing,
  and models that had never seen the project answered with plans and guesses. Now such a chat keeps
  its follow-ups on Claude, on the primary model rather than the fast one, for 12 hours after the
  last code work (kept in `code-chats.json`, so a restart does not reset it). Picking another route
  in the chat still wins.
- **Proposed plans show in the chat and survive a restart.** A plan from `propose_plan` lived only
  in the Workflow Canvas app, with nothing in the chat but "review the plan in the Workflow Canvas",
  and in memory only, so a restart deleted it. Now the chat shows a plan card under the reply with
  the steps, **Approve and run**, **Reject** and **Open in Workflow Canvas**, and follows the steps
  live while the plan runs. Plans from the free and local models are tagged with their chat too.
  Plans are saved to `plans.json`; a plan cut off by a restart comes back as proposed, with its
  finished steps kept, so approving it runs only the rest.
- **Restart waits for running turns.** `zamolxis restart` and `zamolxis update` (and the restart and
  update buttons, which run them) now wait until no reply, agent run or plan step is in progress,
  and until the instance has been idle for 3 s, before stopping it; after 10 minutes they restart
  anyway, and `zamolxis restart --now` skips the wait. `/api/status` reports `busy`, the number of
  running turns. A chat whose connection drops while a reply is pending now says so instead of
  leaving the question unanswered.
- **One click to allow a project folder for Code.** When a Code job is refused because its folder is
  not in Settings -> Code, the chat shows a card with **Allow this folder** (it is added next to the
  folders already allowed; a whole drive or a Windows system folder is refused) and then **Run my
  last request again**. The models are told to call the tool with the folder the user named instead
  of refusing on their own or offering to build the project somewhere else.
- **Claude: the newest models are used automatically (Opus 5.5 instead of Opus 4.8).** "opus",
  "sonnet", "haiku", the Claude route and the default model were handed to the Claude Agent SDK as
  aliases, and the SDK's bundled Claude Code (2.1.156) mapped them to the models it knew, so turns
  kept running on Opus 4.8; it also could not run Opus 5.5 at all ("version 2.1.280 or newer is
  required"). Now the aliases and the default resolve to the newest id of their family in the live
  `/v1/models` list (opus -> claude-opus-5-5, sonnet -> claude-sonnet-5-5, haiku ->
  claude-haiku-5-5, and the new fable -> claude-fable-5-1), in chat turns, one-shot calls and
  delegated Code jobs (SDK and CLI); a full model id picked by the user is kept. The SDK is updated
  to 0.3.314 (Claude Code 2.1.314). When a model newer than the bundled Claude Code appears, the
  refused model is skipped from then on and the turn reruns once on the next newest of the family.
- **Voice: the instruction after "zam" is no longer lost.** After the wake word the microphone was
  muted while the "Yes?" answer was being prepared, up to 125 s, and a cold Kokoro start takes
  several seconds, so what was said right after "zam" (including "execute") was thrown away and
  nothing was sent. Now the microphone is muted only while the answer is actually playing, and the
  "Yes?" is skipped when it is ready more than 2.5 s after the wake word or the user is already
  talking. Each transcribed utterance is logged (`voice: transcribed`: length, time, device,
  language and the start of the text) so a dictation that did not send can be traced.
- **Voice: no more "speech recognition is falling behind".** When large-v3 did not fit on the GPU
  (Claude Voice or another program holding the VRAM), whisper-server fell back to large-v3 on the
  CPU, about 45 s per clip, so utterances queued up past the limit; and it stayed on the CPU until
  Zamolxis restarted, even after the GPU was free. Now a lighter installed model (base) runs on the
  GPU instead (about 1 s per clip), large-v3 is tried on the GPU again after 10 minutes during a
  pause and after every idle unload, and CPU is the last resort. Device -> CPU only still runs the
  chosen model on CPU. An unexpected whisper-server exit is logged with its exit code and the last
  error lines. Measured: large-v3 on the GPU 1.9 s per clip warm (6.8 s including the load).
- **Live work feedback and a finish report in chat windows.** While a turn runs, the desktop chat
  shows an animated working line (cycling glyph, the current step, elapsed seconds, the model) with
  a **Stop** button and an expandable list of the steps so far: the model asked, each tool call with
  its main input and time, delegated subtasks, provider fall-overs, retries and escalation. When the
  reply arrives it becomes a report card under it ("Done in 14 s · Claude (opus) · 3 tools (Bash ×2,
  Read) · 2.1k in / 340 out tokens · $0.02"), with details on click (steps with times, tools with
  counts, files changed, subtasks with path, backend and outcome, escalation, errors); failed or
  stopped turns get a red card. Agent chats show the working line while the run is pending and the
  report from the run; the classic UI shows the current step in its status line and a one-line
  report. **Settings -> Appearance -> Show work details** (on by default, a browser preference)
  hides the steps and the report card and keeps the working line. Under the hood the engine emits
  structured activity events (`start`, `model`, `tool`, `tool_done`, `subtask`, `note`, `retry`) on
  every tier (the Claude SDK stream's tool_use/tool_result, the free/local tool loop, delegated
  subtasks, load_code_model) and builds a `TurnReport` for every turn; the WebSocket sends them as
  `activity` and `report` messages and accepts `{cancel: true}` to stop the chat's running turn.
  `/api/agents` `run` returns the report (and a new `cancel` action stops an agent chat's run
  without stopping the agent), and the runs ledger keeps it (Agent Activity shows the summary on
  hover). In the web UI the status lines that used to be pasted into the reply ("(handed to …)",
  "(load_code_model: …)", subtask progress) are now activity only; Slack, Telegram, Discord and the
  CLI keep them as before.

- **Voice: raw audio from the same microphone as Claude Voice, plus recent recordings.** Capture
  asked the browser for echo cancellation, noise suppression and auto-gain, which are tuned for
  calls and garble speech for Whisper, and always used the browser's default input (on a PC with
  several inputs, e.g. a laptop array, a USB mic and a Steam virtual mic, often the wrong one).
  Claude Voice records its configured microphone raw. Now capture is raw by default (Settings ->
  Voice -> Browser audio cleanup turns the filters back on), and records from the microphone whose
  name contains Claude Voice's `mic.device` (e.g. "TONOR"; Settings -> Voice -> Microphone picks
  another). The browser only reveals microphone names after the first permission, so the first
  start switches to the right one as soon as they are visible. Claude Voice's `mic.device` was also
  dropped when its config was read; it is now kept. Settings -> Voice -> Recent recordings lists
  the last 5 utterances with length, peak level (very quiet / ok / clipping), microphone, time to
  transcribe, language and the text, with playback of exactly what was sent to Whisper.
- **Route menu Claude models are honoured; no more bare "ESCALATE".** Picking Claude Opus /
  Sonnet / Haiku in a chat's Route menu sent `route: "opus"`, which the router did not recognise,
  so the turn fell through to the normal free-first routing and the chosen model was ignored. Such a
  route now means Claude with that model, and delegated Claude Code work started from that chat
  runs on the same Claude model even if the orchestrating model asked for a cheaper backend.
  A cheap model that said ESCALATE after a delegation that was refused before it started (e.g. a
  folder that isn't allowed) was kept from escalating, as if work had run, and its bare "ESCALATE"
  was shown; now only a delegation that actually ran blocks the hand-off, a hand-off token is never
  shown to the user (a plain sentence replaces it when no stronger model is left), and refused
  delegations are logged with their reason. A code job without a project folder is refused with
  the allowed folders listed, instead of silently running in the work folder.
- **Voice uses the Claude Voice system (local Whisper + Kokoro).** A new **Settings -> Voice** tab
  (the toggles left Appearance) picks the speech engine: **Claude Voice (local Whisper)**, the
  default when its whisper.cpp release zip (or a set-up whisper runtime) and a whisper model are
  found, or **Browser** (the Web Speech API, as before). With Claude Voice the page captures the
  microphone (AudioWorklet, 16 kHz), cuts utterances by level the way Claude Voice does (noise floor,
  speech ratio, 900 ms of silence, 300 ms pre-roll) and `POST /api/voice/transcribe` runs each one
  through **whisper-server** (whisper.cpp b5454, the build Claude Voice uses) with Claude Voice's
  models, Silero VAD and speech settings; audio never leaves the PC. whisper-server runs from one
  runtime folder shared by all data dirs (`%LOCALAPPDATA%\Zamolxis\whisper-runtime`, or
  `ZAMOLXIS_WHISPER_DIR`): only whisper-server.exe is extracted from Claude Voice's zip and every
  DLL is a hard link to Claude Voice's install after a size check against the zip (no extra disk);
  extracting the DLLs from the zip (about 1.2 GB, or a CPU-only set of about 10 MB) is offered only
  when linking is not possible, after a free-space check, and the official release can be
  downloaded when the zip is missing. Settings -> Voice shows the mode and the disk used. It starts on first use on a free 127.0.0.1 port, unloads after 5 idle
  minutes (setting) to free VRAM, and retries once on CPU when the GPU load fails (for example
  while Claude Voice holds the GPU). A server left behind by a crash is stopped at the next start.
  Defaults (model large-v3, languages, translate to English, stop and cancel phrases, Kokoro voice)
  are read from `%APPDATA%\ClaudeVoice\config.json`, never written; **Use Claude Voice settings**
  fills the form from it.
- **"Zam" wake word and Dictate.** Saying **"zam"** (or "hey zam", "hello zam"; misheard forms
  such as "sam", "zum", "zahm" are editable) while a Zamolxis window has focus opens a **new chat
  window** and dictates into it; a stop phrase (Claude Voice's, e.g. "execute", "go ahead zam")
  sends it, a cancel phrase ("cancel", "never mind") discards it, and after 120 s without speech it
  stops and leaves the text unsent. "Zam, <prompt> ... execute" in one breath works too. Wake
  listening stops whenever Zamolxis loses focus; a dictation you started keeps going. Phrase
  matching is a port of Claude Voice's (difflib ratio, stop in the last 3 words, cancel in 4 words
  or fewer), plus one rule for the short name: a wake phrase must contain the name itself. A
  **Dictate** desktop shortcut, a command bar entry and a desktop right-click entry do the same.
- **Microphone in every chat.** The mic button is in every chat window, including new chats and
  agent chats. With Claude Voice: click to talk, click again, pause or say a stop phrase to send;
  a cancel phrase clears it.
- **Kokoro voices for spoken replies.** Spoken replies can be Off, Browser or **Kokoro** (Claude
  Voice's offline neural voices through its own Python venv, `POST /api/voice/tts`,
  `GET /api/voice/voices`), with voice, speed and **Test voice**. The microphone is muted while a
  reply plays and for 0.5 s after. `GET /api/voice/status` and `POST /api/voice/prepare` back the
  status line (engine, whisper-server state, model, GPU/CPU, venv found).
- **Web UI refuses cross-site requests.** Before, any web page open in the browser could POST to
  `/api/*` (a plain-text "simple" request needs no CORS preflight) or open the chat WebSocket
  (browsers don't apply CORS to WebSockets) and drive the agent, and a hostile domain pointed at
  127.0.0.1 (DNS rebinding) looked same-site. Now every request is checked: on a loopback bind the
  `Host` must be a loopback name (add others with `ZAMOLXIS_WEB_ALLOWED_HOSTS`), a browser `Origin`
  must be Zamolxis's own (`null` from sandboxed frames such as Canvas content is refused), and
  `Sec-Fetch-Site: cross-site` is refused except plain page navigations outside `/api/`.
  Non-browser clients (CLI, scheduled tasks, delegated Claude Code workers) send no Origin and are
  unaffected; the Claude Code translator route keeps its own loopback + secret guard.
- **Providers: brief overloads retried, "not on your plan" models repaired.** A provider that says
  it is briefly busy (Z.ai code 1305 "temporarily overloaded", HTTP 503/529, "high demand") is
  retried after 3 s and 6 s in chats, delegated Claude Code runs and Re-check, and if still busy is
  skipped for 15 seconds instead of 2 minutes. A model that is not on the user's plan (Z.ai code
  1113 "insufficient balance", or Mistral's `x-ratelimit-limit-req-minute: 0` on free plans) is now
  repaired like a retired one: known free models (`fallbackModels`) are tried first, then the
  provider's list, and the notification says "not available on your plan". Mistral now defaults to
  `ministral-14b-latest` (Mistral Small has a 0/min limit on free plans). Re-check shows "busy, try
  again" instead of a red rate limit, and no longer reports "no tool call" when the tool check was
  only blocked by an overload.
- **Free provider list refreshed (checked 2 Nov 2026).** Groq now defaults to
  `openai/gpt-oss-120b`, OpenRouter to `nvidia/nemotron-3.5-super-vl:free` and NVIDIA NIM to
  `nvidia/nemotron-3-ultra-550b-a55b` (the old Llama 3.3 defaults were retired). Cerebras and
  SambaNova notes now say free use needs a card / payment method. New free providers:
  **OVHcloud AI Endpoints** (gpt-oss-120b; can run without a key at about 2 requests/min once you
  turn on **Use without a key** on its card, setting `keylessProviders`, off by default; an
  optional token raises the limits), **Z.ai** (GLM-4.7 Flash) and **Cloudflare Workers AI**
  (gpt-oss-120b, API token + Account ID; the base URL takes `{ENV_NAME}` placeholders). Their
  credentials are saved from Settings and restored at boot.
- **Per-provider model override.** Settings → Providers has a **Model** field on every card
  (setting `providerModels`), so a stale free model can be fixed without a code change.
- **Provider health and self-correcting models.** A provider that fails with 401/402/403/404/410
  is cooled down for 6 hours (a 429 for 2 minutes) and skipped by the free rotation; the
  Providers tab shows a red "failing: HTTP …" tag. Failed calls no longer count toward the daily
  quota. When the failure says the **model is gone** (retired, renamed, no longer free), Zamolxis
  lists the provider's models, tests up to 6 candidates (a short answer plus a tool call), switches
  to the first that passes, saves it like a manual override (remembered as automatic in
  `providerModelsAuto` until you edit the Model field), notifies you and retries the request
  once (chat and the Claude Code translator). Free providers only, only for the provider's
  configured model, at most once per provider per 6 hours (10 minutes after a search cut short by
  a rate limit) and within 90 seconds. **Re-check**
  and **Check all** buttons (`POST /api/providers {action:'validate'}`) run the same test on demand.
- **A better local model for code.** Settings → Code shows a hardware-aware **Recommended for
  code** card (qwen3-coder:30b with 32 GB+ RAM or 20 GB+ VRAM, else qwen2.5-coder:14b, else
  qwen2.5-coder:7b) with **Download and use**; before any pull the free space of Ollama's models
  folder is checked (size + 2 GB), and a full disk is explained (move the folder with
  `OLLAMA_MODELS`). A code job run on the local backend with a weak coder ends with a short
  proposal, and the new `load_code_model` tool (all tiers) downloads and selects the model once
  you agree. The low-context warning no longer claims Ollama "may load a small context" (0.40+
  loads a large default context); it warns only when a small limit is actually set.

- **Claude Code as a worker (delegation).** New tools `delegate_task`, `claude_code` and
  `claude_cli`, on every tier (Claude, free providers, local) and assignable to scheduled agents.
  A subtask that needs code runs as a Claude Code session (Agent SDK) **inside a project folder**,
  with the Laws, the permission gate (grants remembered per project as `code:<folder>`) and a
  `git status` before/after so the reply lists the changed files; any other subtask runs on the
  installed `claude` CLI headless (`claude -p`, read and web tools only, task passed on stdin).
  An orchestrator picks the path and the model backend per subtask: **Claude** (subscription),
  a **free** provider (through a new built-in Anthropic -> OpenAI translator at
  `/anthropic/<provider>/v1/messages`, loopback-only and secret-protected), or **local** Ollama
  (its native Anthropic API). Privacy Mode forces local; an automatically chosen free/local run
  that can't finish is retried once on Claude. Independent subtasks run **in parallel** on their
  own throttle (default 3, separate from the chat's), and code subtasks on the same folder run one
  after another. Progress lines stream into the chat; runs show in Agent Activity with new
  `code` / `cli` badges. Configure it in the new **Settings -> Code** tab (allowed project folders,
  default backend, local model for code jobs, parallel subtasks, max turns), which also shows the
  detected `claude` CLI, its login state and which backends are usable right now (`GET /api/code`).
  Claude Code is now listed among the detected CLI providers, and a **delegate** skill explains
  when to delegate.
- **Fix: the Ollama Cloud key is saved.** `OLLAMA_API_KEY` was missing from the credential list,
  so saving it in Settings silently dropped it.
- **Settings → Integrations tab.** Jira credentials (base URL, account email, API token, default
  project) had no home in the desktop Settings; the Jira tools and agents now point to
  **Settings → Integrations → Jira**, and the tab also surfaces the optional web-search and plugin
  keys with Save buttons.
- **Clearer toggles, connector setup guides, and an easter egg.** The on/off switches show an
  **ON/OFF** label so their state is unmistakable; each **Channels** connector has a step-by-step
  "How to set up" (with a full **Slack** Socket-Mode walkthrough and a link to the setup page); and
  clicking the taskbar clock opens the page about the Dacian god Zamolxis is named after.
- **Slack connector guide.** README, HELP, `.env.example` and the **connect-slack** skill document
  the Socket-Mode setup (app, scopes, event subscriptions, where the `xoxb-`/`xapp-` tokens go).
- **File Transfer (a FileZilla-style client).** The old single-pane SFTP Client is now a two-pane
  file-transfer window: **Local site** (the machine Zamolxis runs on, browsed via `/api/fs`) on the
  left, **Remote site** (an SSH/SFTP server) on the right, with a status log narrating each
  connection and transfer. Move files with the ↥/↧ arrows (binary-safe, up to 50 MB; new
  `/api/fs readB64` op), make folders, rename and delete on either side. It has a desktop icon.
- **Clickable links everywhere.** Bot replies render http(s) and `/api/...` links as clickable
  anchors (desktop and classic UIs, HTML-escaped), so Outlook-open, Jira browse and watched-site
  links work with a click. **Settings → System → Proactive** gained rows for the followed-Jira-tasks
  and site-health watchers next to the Outlook one.
- **Model pickers show the real Claude models, including Fable.** The Route / agent model pickers
  list the live model list (Fable, Opus, Sonnet, Haiku and dated ids, de-duped by family) after the
  Auto / Free cloud / provider entries, and **Local** is offered only when a local model is actually
  installed (a stale saved choice falls back to Auto).
- **`zamolxis` is added to PATH automatically by the installers** (via `zamolxis setup-path`
  instead of `npm link`), so `zamolxis start` works straight after install.
- **Polish and Ukrainian** interface languages (Settings → Appearance → Language), including the
  translated UI strings and Help guide.
- **Claude API key** can now be entered in Settings → Providers (optional metered billing; used
  only when `ZAMOLXIS_ALLOW_API_KEY=1`, otherwise the subscription is used).
- **Agents are headless by default** (the chat window starts OFF; flip the toggle to talk to one).
- **Agent output format is the agent's choice; Chat / Slack / Web page are just its channels.** The
  agent app's delivery row now shows **Chat**, **Slack** (with the channel/ID) and **Web page**
  together, auto-saving on change (no Save button); how a result is shaped (a Word/Excel document,
  etc.) is decided by the agent's own instructions — tell it in chat ("save the briefing as a Word
  doc"). Generated Word/Excel/PowerPoint documents now save to a discoverable
  **Documents\Zamolxis** folder (not the hidden data dir) and open automatically. The digest/report
  agents (News Brief, Chief of Staff, Scrum Sentinel, Review Radar) gained the document tools. A
  headless `zamolxis run-agent` / Windows-task run now delivers the reply to the agent's channels
  (chat feed + Slack) exactly like a scheduled run (`Scheduler.deliverToChannels`); the Slack
  delivery setting is honoured by scheduled runs too.
- **Appearance simplified.** The desktop-theme picker is gone (Zamolxis is the only theme); the
  Classic UI moved to a link at the bottom of the System tab.
- **New pre-made agent: John the Butler**, a courteous PC-maintenance butler for Windows. He keeps
  the machine in order (drivers, apps, network, system/security health, disk clutter, duplicate
  photos) and reports in plain language, proposing fixes but never making risky changes without a
  yes. Ask "John, check the house" or let him do a silent weekly round (seeded paused, Monday 09:00).
  - Driven by a bundled native maintenance **engine** (`butler-engine/`, built into `bin/`): John
    runs it headless and parses its JSON, so the scans are fully deterministic; the model only
    picks the scan and phrases the result. Every read-only scan (drivers, system health, apps,
    network, duplicates) uses the standard-user build `butler-scan.exe` with **no UAC prompt**; the
    driver report (`--export`, HTML) is returned as readable text. The elevated build
    `butler-core.exe` backs fixes and the silent weekly scheduled task. Both binaries are built
    locally from `butler-engine/` (see its README) and gitignored.
  - **Silent automation:** "set up automatic maintenance" registers a highest-privilege weekly
    scheduled task `Butler_Health` (created elevated via a single UAC prompt, prompt-free
    thereafter) that writes a full `--dumpsys` health report, including deep disk S.M.A.R.T., which
    `pc_health` prefers over a live scan. Elevation is asked for only there and when applying a fix.
  - **A duties dashboard.** John's page at `/john-the-butler` (Web-page delivery is seeded on) shows
    his latest report first, with a collapsed "John's duties" panel below it: tick which areas he
    handles on his own each week, set the duplicate-photos folder, and, behind a master opt-in that
    is **off by default**, let him apply safe fixes rather than only reporting. His weekly round
    reads those choices and does only the ticked duties. Backed by `GET`/`POST /api/butler` (config
    in `<dataDir>/butler-duties.json`) and a `pc_config` tool.
  - Tools: `pc_health`, `pc_drivers`, `pc_apps`, `pc_network`, `pc_duplicates`, `pc_config`,
    `pc_maintain`. Pre-made agents gain a `webPage` seed flag.

- **Command bar (Ctrl+Space).** A spotlight-style launcher: press Ctrl+Space (or Ctrl/Cmd+K) from
  anywhere on the desktop, start typing, and jump straight to any app or agent, or pick "Ask
  Zamolxis: <your text>" to open the chat and send your question in one step. Arrow keys navigate,
  Enter selects, Esc closes. Also on the desktop right-click menu. The chat window gains a
  `sendChat` hook that waits for the socket before sending. Pure front-end.
- **Privacy dashboard.** A new "Privacy" desktop app (shield icon, kept on the desktop) shows the
  self-hosting posture at a glance: where Zamolxis runs (host, account, data dir), whether the web
  UI is local-only or exposed, the live **Privacy Mode** state with an on/off switch (the same
  setting as Settings -> Engine), the places data can leave the machine (Claude and any configured
  cloud model providers, shown as *blocked* while Privacy Mode is on; enabled messaging channels;
  web search; Home Assistant; external MCP servers), and what never leaves. It states plainly that
  Privacy Mode keeps model inference local but does not switch off tools that reach the network on
  purpose. All derived live from configuration via `GET /api/privacy`; no telemetry.
- **Share agents (export / import cards).** Any agent can be exported as a small, portable JSON
  "card" (name, label, job, tools, model, help, guide, delivery, schedule; no machine-specific
  state) and imported on another machine in one click. The New Agent window gains a "Share agents"
  section for both; import detects a name clash and offers to replace. Backed by new `export` /
  `import` actions on `POST /api/agents`.
- **Desktop: right-click menu, "Auto-arrange icons" + no more off-screen icons.** Right-clicking
  the empty desktop opens a small menu (Command bar, Auto-arrange icons); "Auto-arrange icons" is
  also in the command bar (Ctrl+Space). It lays every icon into a tidy grid inside the visible area.
  The menu listens on the desktop itself, since the icon layer has pointer-events: none (Giskard
  attached it to that layer, so it never opened). Icons without a saved position now wrap into the
  next column instead of stacking down a single column past the bottom of the screen.
- **Pre-made agents: Hide instead of Delete.** A shipped pre-made agent can't be truly deleted (it
  would just re-seed on restart), so its window now offers **Hide** rather than Delete. Hiding takes
  it off the desktop and app list, pauses it and removes its schedules; **Un-hide** from Settings ->
  Sub-agents brings it back (paused, no schedule). Agents you created yourself keep both Hide and
  Delete. Agents carry new `premade` / `hidden` flags (existing pre-made agents are tagged at
  startup), `/api/agents` gains `hide` / `unhide` actions, "Resume all" skips hidden agents, and the
  classic UI's agent rail hides them too.

- **The Laws now govern every run, on every model.** The full Prime Directives block (`LAWS.md`)
  was injected only into Claude-tier runs; it now also leads, at highest priority, the lean prompt
  used for local and free/paid provider models (chats and agent runs alike), including in Privacy
  Mode where the local model is the only tier. The concise safety line for local/provider models
  also gained the destructive-action guard: routine reversible work proceeds, but high-risk or
  irreversible steps (bulk delete/overwrite, wipe/format, sending messages, spending money,
  changing credentials/settings) need the user's explicit confirmation. It stays as reinforcement
  for weak models and as the fallback when the Laws are switched off.
- **Desktop Automation binds explicitly to the Laws.** Its job/help/guide now state that it operates
  under Zamolxis's Prime Directives (Law 1 above all) instead of a vague "pauses before destructive";
  a one-time migration (`.premade-laws-v1`) refreshes that agent's text on existing installs,
  keeping its model, paused state and schedule.
- **Interactive tool permissions with remembered grants.** In the `default` permission mode, Zamolxis
  asks before a tool or resource is used: an inline Allow once / Always allow / Deny / Always deny
  card in the web chat (desktop and classic UI) or a y/a/n/d prompt in the CLI. "Always" answers are
  remembered per agent, per forced skill, per chat (or globally) in `<dataDir>/permissions.json`, and
  are listed and revocable in the new Settings -> Permissions tab (`GET/POST /api/permissions`).
  Channels with no prompter (scheduled/headless agent runs, messaging adapters) follow remembered
  grants and otherwise proceed, so unattended jobs never hang; an unanswered prompt (5 minutes, or the
  tab closed) denies just that call. The built-in default is now `default` (interactive); installs
  whose `.env` sets `ZAMOLXIS_PERMISSION_MODE=acceptEdits` (as `.env.example` does) keep never-ask
  behaviour. Change it in Settings -> Engine -> Permission mode or in `.env`.
- **Native OS notifications.** Every alert (watchers, Site Sentinel, Jira, triggers) also pops a
  Windows toast / macOS notification / Linux notify-send, not just the in-app feed
  (`src/core/hostNotify.ts`). On by default; toggle in Settings -> System -> Proactive (saved as
  `osNotify` in `watchers.json`); `ZAMOLXIS_OS_NOTIFICATIONS=0` flips the startup default.
- **Run under a separate OS user (enhanced security).** `scripts/service-install.ps1 -RunAsUser <account>`
  registers the service under a dedicated low-privilege Windows account (starts at boot, password
  stored by Task Scheduler); `scripts/zamolxis.service` documents a dedicated `User=` plus systemd
  hardening for Linux. Documented in the README and HELP.
- **Longer default turn timeout.** `ZAMOLXIS_TURN_TIMEOUT_SECONDS` now defaults to 1800 (30 minutes)
  instead of 300, so long autonomous jobs (research, document building, multi-tool chains) aren't
  cut short; a hung turn is still aborted. Existing `.env` / saved settings values are respected.
- **CLI: `install-agent-tasks`, `remove-agent-tasks`, `list-agent-tasks`.** On Windows,
  `zamolxis install-agent-tasks` mirrors every scheduled agent into Task Scheduler (folder
  `Zamolxis`, each task running `zamolxis run-agent <name>`), sets `ZAMOLXIS_AGENT_TRIGGER=windows`
  and restarts so the in-process timer stops double-firing; `remove-agent-tasks` deletes the tasks
  and switches back to `internal`; `list-agent-tasks` shows what is registered.
- **New pre-made agent: Desktop Automation (plain-English Windows RPA).** Describe a repetitive
  desktop task in ordinary words and it carries it out on this machine - launching apps, sending
  keystrokes/clicks via AutoHotkey, driving your browser through a web flow, running PowerShell,
  arranging files - then reports what it did. On-demand (open agent), top Claude tier, and careful
  by design: it does only what was asked and pauses before anything destructive. Pairs with an
  Automation (trigger) so a desktop task can fire when a file lands.
- **External MCP servers.** Zamolxis now loads extra MCP servers from `<dataDir>/mcp.json` and merges
  them alongside the built-in `zamolxis` tool server, so an agent can use tools from any MCP server
  the user wires up (a Windows automation server, desktop-commander, a DB gateway) by listing
  `mcp__<server>__<tool>` in its tools. Optional - no file means no change.
- **Event-driven automations (triggers).** Agents can now fire on something happening on this
  machine, not just on a clock: a file landing in (or changing under) a watched folder, a drive's
  free space dropping below a threshold, or memory use climbing above one. A new "Automations"
  desktop app creates and toggles triggers; each fire runs the chosen agent, delivers its reply
  through the agent message bus, and raises a native OS notification. The watcher lives in the
  Zamolxis process and reacts to this desktop's own filesystem. Backed by `triggers.json` and the
  new `GET/POST /api/triggers`; the file watcher reloads config on the fly, so adding a trigger
  takes effect without a restart. Trigger-fired runs are recorded in the Agent Activity dashboard
  with an "event" badge.
- **New "Agent Activity" dashboard (run history + cost observability).** Every agent run - scheduled,
  manual, or event-triggered - is now recorded to a rolling local ledger (`runs.json`, last 1000 runs)
  with its duration, outcome, cost, backend, and a short preview of what it did. A new desktop app
  (System category) shows per-agent rollups (runs, success rate, total cost, average time, last run)
  and a live recent-runs feed with trigger badges. Served from the new `GET /api/runs` endpoint; the
  ledger stays entirely on this machine.

- Files: configurable **Work folder** (default `C:\Zamolxis`) for user outputs and **Scripts folder**
  (default `C:\bat`) for installed .bat/.ps1 — the agent is instructed to use these instead of the
  Desktop, and the planner bakes them into agent specs. Settings panel + auto-created on boot.
- Agents: skip + report `inactive` (no escalation) when a pinned model is unavailable; panel shows the
  actual model a rotating tier ran on; scheduled messages carry the model badge.

- Agents: choose the model on create/edit (Auto or a pinned tier); manual picks respected with a
  smart-model warning if too weak; `[inactive]` + **Fix** when an agent's model is unavailable.
- Agents: agent-created ones show in the panel (`auto` badge) and are temporary unless the new
  Settings toggle "Keep agents that Zamolxis created itself after restart" is on.
- Agents: lean executor prompt (compiled spec + tools + time only); the planner now bakes relevant
  user context into the spec. Agent runs at temperature 0; 24-hour authoritative time injection.
- UI: Chats moved into the left rail as a permanent section (removed from Tools); draggable
  Agents/Chats splitter; tool panels push content aside; build number zero-padded to 3 chars.
- Docs/auth: all guidance updated to **`claude auth login`** (current Claude Code; older `claude
  login` is gone) incl. the web login tooltip; added HELP.md (web+CLI) and a /help page + Help menu;
  DESCRIPTION.md gained a Sign-in section.

## 0.3.0

Smarter, cheaper routing and full local-model control.

### Routing
- **Cheapest-capable-brain ladder** reworked: free cloud → paid → **local last** → frontier subscription tier (rescue/escalation only). The local model is no longer the default first stop.
- **Deterministic arithmetic**: a pure formula (e.g. `(2+45-32+56)/334`) is computed directly with no model.
- **Targeted escalation**: `escalate`, `escalate <model>`, or `escalate <number>` to jump to a specific tier (typos tolerated); input autocomplete for model names.

### Local models
- **Local-model panel** (Tools → Local model): install the runtime if missing, browse/pull a curated general-chat catalog (all tool-capable) with live progress, keep several models and switch the active one any time, delete unused ones.
- Per-model settings: **routing** (off / auto last-resort), **context window** (num_ctx), **keep-alive**, **temperature**; **GPU/CPU split** indicator and a per-model **Test** button.
- Active model + settings persist across restarts; the models rail shows `Local - <model>`.
- Installer now recommends **general-chat all-rounders** (tool-capable) instead of code-tuned defaults.

### Skills & tools
- **`/skill` calls** with `/` autocomplete to force a specific skill/tool.
- **Home Assistant device map**: `/hasync` (or the `ha_build_map` tool) scans HA and the smart model writes a dead-simple `home-assistant-devices` skill (by area, by type, with aliases + exact entity_ids) so the local model can control the house reliably.

### Control & safety
- **Per-(model, skill) ban list**: `/ban [skill] [model]` and `/unban`, editable in the Memory panel; a banned model refuses that capability and routing prefers a non-banned one. The smartest model can never be banned. Auto-bans the local model from a skill when you escalate right after it used that skill.

### Docs
- Added `DESCRIPTION.md` (clear overview + disclaimer).
