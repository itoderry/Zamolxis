# Zamolxis peer mesh: plan

Status: proposed, 4 Nov 2026. Nothing here is built yet.

## Goal

Every PC on the network runs a full Zamolxis that works on its own. Paired installs form a mesh: the one
you are talking to handles your request and borrows the others when they are better placed for a part of
it. A PC without a Claude login is still a full peer, on its local and free models, and hands up to a peer
that has Claude when a job needs it.

What the mesh is for:

- Work goes where the stuff is: a build runs on the PC with the compiler and the project folder, an Excel
  report on the one with Office, local-model work on the PC with the big GPU.
- More parallel work without more Claude: the free and local tiers of every PC add up.
- A PC without Claude never dead-ends: "I need Claude for this" becomes a hand-off to a Claude peer.
- One brain to talk to from any machine: same skills, rules and profile everywhere.

Not goals (for now): sharing one Claude login's quota across machines to get more of it (the quota belongs
to the account, so it does not grow), a public or internet-facing mesh, running peers for other people.

## Words used here

- Peer: one Zamolxis install that has joined the mesh. Each has a stable id and a name ("DESKTOP-GPU").
- Origin peer: the one that received your message. It owns the chat, the report and the reply.
- Remote job: a piece of work the origin sends to another peer (a delegated subtask, an agent run, a
  whole turn on one tier, a plan step).
- Capability card: what a peer has, published to the others.

## How it works

### 1. Pairing and transport

- Each install gets a peer id (random, kept in `<dataDir>/mesh/identity.json`) and an Ed25519 key pair.
- Pairing is explicit and one-time: Settings -> Mesh -> "Add a peer" shows a 6-digit code on one machine,
  you type it on the other, and the two exchange public keys. Nothing joins without that step.
- Discovery: peers are found by mDNS on the LAN (`_zamolxis._tcp`), by NetBird peer addresses, or by an
  address you type. Discovery only finds candidates; pairing decides trust.
- Transport: the existing web server on a separate mesh port (default 8788) bound to the LAN or NetBird
  address, never to the internet. Every request is signed with the sender's key (timestamp + nonce + body
  hash), so a stolen token is not enough and replays are refused. The browser UI port keeps its own rules.
- Peers ping each other every 30 s. A peer that misses three pings is shown as offline and is not chosen.

### 2. Capability card

Each peer publishes, and refreshes on change and every few minutes:

- Tiers: Claude logged in (and which models), local models in Ollama (name, size, context), free provider
  ids with a key, paid providers. No keys or tokens, only "has a key".
- Hardware: GPU name and free VRAM, RAM, CPU load, battery or mains, asleep soon.
- Apps: what the app scan already finds (Office, Visual Studio, VS Code, Adobe, AutoHotkey...).
- Project folders it allows for Code (paths and repo names), so "the Elite game" can be found.
- OS and shells, voice (speech service), sandbox backends.
- Load: turns running, queued remote jobs, and a "busy" flag the owner can set ("don't send me work").

### 3. Routing across peers

The engine's route chain stays as it is (local, free cloud, Claude), with peers as extra tiers:

- `peer:<name>:local`, `peer:<name>:claude` and so on, chosen automatically in Auto, or pinned in a chat's
  Route menu ("Run on DESKTOP-GPU").
- A peer without Claude: when its chain ends and Claude is not present here, it does not answer "no Claude".
  It sends the turn to the best Claude peer (online, least busy) as a remote turn, and streams the reply
  back into the same chat.
- A peer with Claude: before using Claude for an easy turn, it may prefer a peer's strong local model when
  that peer is idle and the local model is better than its own.
- Delegation: `delegate_task` subtasks get an optional `peer`. Without one, the orchestrator picks the peer
  by need: the one that has the folder for code jobs, the right app for app jobs, the GPU for local-model
  work, otherwise the least busy. Independent subtasks can run on different peers at the same time.
- Agents: a scheduled agent can be pinned to a peer ("run the BU report on the office PC"), or "any".
- Plans: each step can carry a peer.
- Failover: a remote job whose peer goes offline or refuses is retried on the next best peer, or locally.
  The report shows it ("DESKTOP-GPU went offline; ran here instead").

### 4. Running a remote job

- The origin sends: the task, the kind (turn, code subtask, CLI job, agent run, plan step), the folder,
  the model or tier, a short context (the relevant chat history and USER profile excerpt, never secrets),
  and a deadline.
- The remote peer runs it through its own engine under its own permissions and allowed folders, and
  streams activity events back (the same `activity` events the chat already shows), then the result and
  its report. The origin's chat shows each step with the peer's name ("Build on DESKTOP-GPU · 2 min").
- Stop in the chat stops the remote job too.
- Files: a remote code job works in the remote PC's folder. Results come back as text, the list of changed
  files, and on request small files (capped, e.g. 20 MB), never whole folders.

### 5. Safety

- Only paired peers, only on LAN or NetBird addresses, signed requests.
- A remote job runs with the remote PC's rules: its `LAWS.md`, its permission mode and remembered grants,
  its allowed folders. Mesh settings add a ceiling per paired peer: which job kinds it may send
  (turns, code, CLI, agents), whether shell and file writes are allowed for remote jobs (off by default),
  and a daily limit.
- Anything that would need an interactive approval on the remote PC is asked in the origin chat (the
  existing permission card, labelled with the peer's name), and denied if nobody answers.
- Peers never send keys, tokens or the Claude login to each other. Secrets stay on their machine.
- Every remote job is logged on both sides (Agent Activity shows "from LAPTOP" / "on DESKTOP-GPU").
- Unpairing removes the key at once; that peer's jobs are refused from then on.

### 6. What is shared and what stays local

- Synced across peers (opt-in per item, last-writer-wins with a version stamp, the existing pack/unpack
  format): skills, `LAWS.md`, `SOUL.md`, `USER.md`, the route chain, agent definitions.
- Stays local: chats and sessions, memory notes of each workspace, credentials and provider keys, the
  Claude login, permissions grants, allowed folders, voice settings.
- Free provider keys: using the same key on several of your machines is fine and can be copied by hand
  in Settings; the mesh never creates or spreads extra accounts.

### 7. UI

- Settings -> Mesh: this peer's name and id, pairing (code), paired peers with their capability cards,
  online state, load, the per-peer ceiling, unpair, and "don't send me work" for this machine.
- A Machines app on the desktop: the mesh at a glance, what runs where right now.
- Chat: the Route menu lists peers; work steps and the report carry the peer name; the finish report says
  where each part ran.

## Phases

Each phase ends usable on its own and is tested on two real PCs (one with Claude, one without).

1. Identity, pairing, discovery, signed transport, capability cards, Settings -> Mesh, the Machines app.
   Done when: the two PCs pair with a code, see each other's cards, and an unpaired third install is refused.
2. Remote jobs: `delegate_task` with `peer`, agent runs on a peer, streamed activity and report, Stop,
   per-peer ceiling, logs on both sides.
   Done when: from the laptop, "build the Elite game on the desktop" runs on the desktop's folder, the
   laptop chat shows the desktop's steps live, and Stop stops it there.
3. Mesh routing: peers as tiers in Auto, the no-Claude hand-off, peer choice by folder / app / GPU / load,
   failover, the Route menu.
   Done when: on the PC without Claude, a message that needs Claude is answered by the Claude PC in the same
   chat, and a job whose peer is switched off mid-run finishes elsewhere.
4. Sync of skills, rules, profile, route chain and agents.
   Done when: a skill written on one PC is used on the other on its next turn, and an edit conflict keeps
   the newer version and logs the older one.

Rough size: phase 1 and 2 are the core (a few days each); 3 is the part that makes it feel like one brain;
4 is small once 1 exists, since pack/unpack already serialises those files.

## Touch points in the code

- `src/core/mesh/` (new): identity, pairing, discovery, signed client and server, capability card, peer
  table, job runner.
- `src/channels/web.ts`: the mesh listener (separate port and bind), Settings -> Mesh API, peer events to
  the chat.
- `src/core/engine.ts`: peer tiers in `planRoute` / `attemptTier`, the no-Claude hand-off, peer label in
  reports.
- `src/core/code/orchestrator.ts`: `peer` on `DelegateTaskSpec`, peer choice, remote execution, failover.
- `src/core/activity.ts`: a `peer` field on events and subtasks.
- `src/core/agents.ts`, `src/core/plans.ts`: a peer per agent and per plan step.
- `src/core/pack.ts`: reused for sync.
- `webui/desktop.js` / `desktop.css`: Settings -> Mesh, the Machines app, peer labels in the chat.

## Open questions

- Which PCs join first, and what each has (GPU, Claude login or not, Office, the project folders). The
  first test pair decides the defaults.
- Should a peer without Claude be allowed to send whole turns to the Claude PC automatically, or only after
  you confirm the first time per chat? (Proposed: automatic, with the step shown.)
- Is NetBird the only way in from outside the house, or should a peer be reachable only on the LAN?
- Sync: everything listed above by default, or nothing until you turn each item on? (Proposed: skills,
  rules and profile on; agents and route chain off.)
