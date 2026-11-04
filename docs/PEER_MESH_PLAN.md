# Zamolxis peer mesh: plan

Status: proposed, 4 Nov 2026 (revised the same day: one elected orchestrator). Nothing here is built yet.

## Goal

Every PC on the network runs a full Zamolxis. Paired installs form one mesh with one orchestrator: the PC
best placed to think and coordinate, chosen automatically when the PCs pair (and changeable in Settings).
Whichever PC you talk to, by chat, voice or a messaging channel, the orchestrator handles the request: it
decides what runs where, sends the pieces to the right PCs, and the answer comes back where you asked.

What the mesh is for:

- One brain, whatever PC you sit at: the same conversation state, skills, rules and profile.
- Work goes where the stuff is: a build runs on the PC with the compiler and the project folder, an Excel
  report on the one with Office, local-model work on the PC with the big GPU, "open Word" on the PC you are
  sitting at.
- More parallel work without more Claude: the free and local tiers of every PC add up.
- A PC without a Claude login is still a full member: its requests go to the orchestrator, which has (or can
  reach) Claude.

Not goals (for now): getting more Claude quota from more PCs (the quota belongs to the account), a public or
internet-facing mesh, a mesh shared between different people.

## Words used here

- Peer: one Zamolxis install that has joined the mesh. Stable id and a name ("DESKTOP-GPU").
- Orchestrator: the one peer that handles every request in the mesh and decides where work runs.
- Entry peer: the PC where you asked (typed, spoke, or the channel that received the message). It shows the
  chat, captures voice, and runs anything that must happen "here".
- Worker: any peer while it runs a piece of work for the orchestrator. The orchestrator is a worker too.
- Machine profile: what a PC has, collected by the scan.

## How it works

### 1. The machine scan (at install, and Settings -> Mesh -> Scan)

The installer already looks at RAM and the GPU to suggest a local model; the scan widens that into a
machine profile, saved in `<dataDir>/mesh/profile.json` and refreshed by the Scan button, at every start,
and when something changes (a model pulled, Claude logged in or out):

- Thinking tiers: Claude logged in, and which models it reaches; local models in Ollama (name, size,
  context); free providers with a key; paid providers. Only "has a key", never a key.
- Hardware: CPU and cores, RAM, GPU name and VRAM, disk free, desktop or laptop, on mains or battery.
- Availability: how long the PC is usually on (from the Zamolxis uptime log), sleep settings, wired or
  Wi-Fi, LAN or NetBird only.
- Apps: what the existing app scan finds (Office, Visual Studio, VS Code, Adobe, AutoHotkey...).
- Work it can host: allowed project folders and their repos, sandbox backends, voice (speech service and a
  microphone), the messaging channels it runs (Telegram, Slack...).
- OS and shells.

### 2. Threat model

The mesh lets one PC make another run commands, so it is built for a network that is not fully trusted:

- other devices on the same LAN or Wi-Fi (guests, TVs, IoT gadgets, a PC with malware) that can see and
  send traffic, spoof addresses and replay what they capture;
- the laptop on a hotel or office network;
- a stolen or compromised peer (the damage must stay bounded and the peer must be removable at once);
- a passive listener recording traffic for later.

Out of scope: an attacker who already controls the Windows account Zamolxis runs under on a peer (they have
its keys and its data anyway; the plan limits what that peer can make the others do).

### 3. Finding each other on the network

- Off by default. Mesh networking starts only when you turn it on in Settings -> Mesh (or answer yes at the
  end of the install). Until then nothing listens and nothing is advertised.
- Trusted networks only. Zamolxis listens for mesh traffic only on networks you have marked as yours, and on
  the NetBird interface. A network is recognised by its gateway's MAC address plus subnet (and SSID on Wi-Fi),
  so the laptop does not trust "192.168.1.x" in a hotel just because the numbers match. Windows' own
  Public/Private label is shown but not relied on: Windows calls this PC's home Ethernet "Public" today, and
  Zamolxis will not change Windows settings. On an unknown network the mesh pauses and says so in the
  Machines app, with a "This is my network" button.
- Bind and firewall. The mesh port (default 8788, TCP) binds only to the addresses of trusted interfaces,
  never to 0.0.0.0. When you enable the mesh, Zamolxis offers to add a Windows Firewall rule for that port,
  scoped to the trusted subnets and the NetBird range (this needs your admin approval once; without it the
  mesh still works where the firewall allows).
- Three ways to find candidates, in this order:
  1. Known peers: every paired peer's last addresses (LAN and NetBird) are kept and tried first, so day to
     day no discovery traffic is needed.
  2. LAN discovery: mDNS/DNS-SD (`_zamolxis-mesh._tcp.local`) on trusted networks. Paired peers advertise
     only an opaque, rotating tag (an HMAC of the mesh id and the current hour, keyed with the mesh secret),
     so outsiders cannot tell that Zamolxis is running or follow a laptop from network to network. A PC is
     visible by name only while you have a pairing window open (5 minutes, started by you).
  3. NetBird: the peers of your NetBird network (`netbird status --json`) are probed on the mesh port, for
     PCs outside the house.
  An address you type (IP or name) always works too.
- Discovery never grants anything. It produces candidates; only pairing creates trust, and every connection
  after pairing is checked against the pinned keys, so a spoofed mDNS answer or a hijacked address reaches
  nothing.
- Moving around: when a laptop changes network, it re-resolves its peers (known addresses, then mDNS on the
  new trusted network, then NetBird) and reconnects within a minute; on an untrusted network it uses NetBird
  only.

### 4. Pairing handshake

Goal: two PCs end up holding each other's real long-term public keys, with no way for a third device in the
middle to slip its own keys in, and no secret that can be guessed offline from a recording.

- Each install has a long-term identity: an Ed25519 signing key (`<dataDir>/mesh/identity.json`, the private
  part encrypted with Windows DPAPI for the current user, file permissions limited to that user) and a TLS
  certificate made from it. Its fingerprint (SHA-256 of the public key) is the peer id; its short form
  (`ZM-4F2A-91C7`) is shown in Settings so you can recognise a PC.
- You start pairing on one PC ("Add a PC": it opens a 5-minute pairing window) and choose the other on the
  second PC from the discovered list or by address ("Join"). Nothing pairs without an action on both PCs.
- The two connect over TLS 1.3 (each side's certificate not yet trusted) and run a numeric-comparison
  exchange, the same idea as Bluetooth Secure Simple Pairing and Signal's safety numbers:
  1. The joiner sends a commitment: a hash of its fresh X25519 key and a random nonce, plus its identity key.
  2. The host replies with its fresh X25519 key, nonce and identity key.
  3. The joiner reveals its key and nonce; the host checks them against the commitment.
  4. Both derive the shared secret (X25519, then HKDF over the whole transcript: both identity keys, both
     certificates, both nonces, protocol versions).
  5. Both screens show the same 6-digit number, computed from that transcript. You check that the two PCs
     show the same number and press "They match" on both.
  6. Each side signs the transcript with its identity key and sends the signature; the other verifies it.
  Because of the commitment, a device in the middle has to fix its keys before it sees the other side's, so
  it gets one blind guess at the 6-digit number (one chance in a million) per attempt, and every failed
  attempt is visible to you as a mismatch.
- Limits: a pairing window takes at most three attempts, then closes for ten minutes; a mismatch or a
  timeout ends the attempt; the pairing endpoint does not exist outside a window.
- Compatibility: the hello carries the mesh protocol version and the Zamolxis version; a major protocol
  mismatch stops the pairing with "update Zamolxis on <PC> first".
- After pairing, the PCs exchange their machine profiles over the now-authenticated channel, and the new PC
  receives the mesh roster (below).

### 5. Membership, keys and revocation

- Connections between paired PCs are mutual TLS 1.3, and each side accepts only a certificate whose key is in
  the roster (pinned keys; no certificate authority, no passwords, nothing to phish). Every message also
  carries the sender id, a sequence number and the orchestrator term, so stale or replayed orders are
  refused.
- The roster: the list of member PCs (id, name, public key, added by, added when), plus mesh settings that
  must agree everywhere (the pinned orchestrator, per-peer ceilings). Every change is a signed entry that
  names the previous one, like a short chain, so all PCs converge on the same roster and a change cannot be
  forged or reordered.
- Adding a third PC: you pair it with any member; that member signs the "add" entry, and the others accept it
  because it is signed by a member they trust. To limit what one compromised PC can do, adding a member also
  needs the orchestrator's countersignature (automatic when the orchestrator is the PC you paired with,
  otherwise a confirmation on the orchestrator's screen).
- Removing a PC: Settings -> Mesh -> Remove, on any member, signs a "remove" entry; every PC drops the
  connections and refuses that key from then on, even if the removed PC was offline at the time. Removing a
  lost laptop works from any other PC.
- Key changes: a PC can rotate its identity key (Settings -> Mesh -> New keys); the new key is announced in an
  entry signed with the old one. Reinstalling Zamolxis without the data folder means pairing again.
- Data in transit is always encrypted (TLS 1.3). At rest, synced conversations and memory sit in each PC's
  Zamolxis data folder under the user's profile, as they do today; keys are DPAPI-protected.

### 6. Orchestrator election

- During the handshake, and whenever the roster or a profile changes, every PC scores every member for the
  orchestrator role with the same formula and the same data, so they reach the same answer without a vote:
  - only peers online right now count;
  - first: Claude logged in (the orchestrator does the hard thinking and tool use);
  - then: on most of the time (a desktop on mains, or you mark it so), so the role moves rarely;
  - then: more reliable uptime, more RAM and CPU, a wired connection, a stronger local model;
  - tie: the peer that was orchestrator before, then the lower peer id.
  The result is shown at the end of pairing ("DESKTOP-GPU will coordinate: always on, Claude, 64 GB RAM")
  and you can accept or pick another.
- Settings -> Mesh -> Orchestrator: "Automatic" (default, re-scored when a peer joins, leaves or its profile
  changes) or a PC you pin. A pinned choice wins over the score; it is a signed roster entry, so every PC
  agrees on it.
- The orchestrator receives every request, so the role is guarded: profiles are self-reported, and a PC that
  lied about having Claude or being always on could otherwise take it. So a PC paired less than 24 hours ago
  cannot become orchestrator automatically, every change of orchestrator (other than a failover back and
  forth between PCs that already held the role) is announced on every PC with its reason, and a pinned
  orchestrator never changes without you.
- Each change of orchestrator gets a term number, carried on every message; a peer ignores orders from an
  older term, so two PCs never both act as orchestrator.
- Failover: if the orchestrator misses three pings (90 s), the next best peer by score takes over with a new
  term, and the old one steps down when it returns, unless it is pinned, in which case it takes the role back.
- Alone: a PC that cannot reach any orchestrator keeps working on its own (standalone mode) and says so in the
  chat; its chats and memory are merged back when it reconnects.

### 7. Every request goes to the orchestrator

- The entry peer receives your message (web chat, voice, Telegram...), shows it in its chat, and forwards it
  to the orchestrator with: the chat id, the entry peer, and any attachments. Voice is transcribed on the
  entry peer first (its own microphone and speech service) and sent as text.
- The orchestrator runs the turn through its engine: route chain, Claude, tools, delegation, plans, exactly as
  today, plus a choice of where each piece runs:
  - "here" actions run on the entry peer: open an app or a file, read the screen, dictation, anything about
    "this PC";
  - code jobs run on the PC that has the project folder (the profile lists them);
  - app jobs run on a PC that has the app (Excel on the office PC);
  - local-model work runs on the PC with the strongest idle local model;
  - free-provider calls can run anywhere, so they go to the least busy peer;
  - independent subtasks run in parallel on different peers.
- Activity streams back to the entry peer's chat as it does today, each step labelled with the PC it ran on
  ("Build on DESKTOP-GPU · 2 min"), and the finish report says where each part ran. Stop stops every piece on
  every PC.
- Messaging channels: a channel connected on any peer forwards to the orchestrator the same way; replies go
  back out through the peer that owns the channel.
- Scheduled agents live on the orchestrator and can be pinned to a peer ("run the BU report on the office
  PC") or "anywhere".

### 8. Where state lives

- The orchestrator holds the conversations (sessions and history), the shared memory and profile, skills,
  rules, agents and plans. Every peer keeps a synced copy, so failover and standalone mode lose nothing.
- Each peer keeps its own: credentials and provider keys, the Claude login, permission grants, allowed
  folders, voice settings, the machine profile.
- Sync uses the existing pack/unpack format with a version stamp per item; on a conflict after standalone
  mode the newer version wins and the older one is kept in the log.

### 9. Running work on a peer

- The orchestrator sends: the task, the kind (code subtask, CLI job, tool call, app action, local-model call,
  agent run, plan step), folder, tier or model, a short context (never secrets) and a deadline.
- The worker runs it through its own engine under its own permissions and allowed folders, streams activity,
  then returns the result, its report and the list of changed files (small files on request, capped).
- A worker that goes offline or refuses: the piece is retried on the next suitable peer, or on the
  orchestrator, and the report says so.

### 10. Safety rules for mesh work

- Transport and trust are covered in sections 3 to 5: trusted networks and NetBird only, mutual TLS with
  pinned keys, signed roster changes, sequence numbers and terms on every message. The browser UI port keeps
  its own rules and never accepts mesh traffic.
- A worker treats text that came from another PC (task descriptions, chat history, file contents) as data,
  not instructions about its own settings: it never changes its rules, keys, roster or allowed folders
  because a mesh job asked it to. Those change only from that PC's own Settings.
- A piece of work runs with the worker's own rules: its `LAWS.md`, permission mode, remembered grants and
  allowed folders. Settings -> Mesh adds a ceiling per paired peer (which kinds of work it accepts; shell and
  file writes for mesh work off by default; a daily limit) and "don't send me work" for this PC.
- Approvals that a worker would ask for interactively are asked in the entry peer's chat (the existing
  permission card, labelled with the PC's name) and denied if nobody answers.
- Secrets and the Claude login never leave their PC. Every piece of mesh work is logged on both sides (Agent
  Activity: "from LAPTOP", "on DESKTOP-GPU"). Unpairing removes the key at once.

### 11. UI

- Settings -> Mesh: this PC's profile with a Scan button, pairing, the paired PCs with their profiles and
  online state, the orchestrator (Automatic or pinned, with the reason it was chosen), the per-peer ceiling,
  "don't send me work", unpair.
- A Machines app on the desktop: the mesh at a glance, who coordinates, what runs where right now.
- Chat: a small badge showing the orchestrator ("via DESKTOP-GPU") or "standalone"; work steps and reports
  carry the PC name; the Route menu can pin a turn to a PC.
- Installer: runs the scan, shows the profile, and offers "Join a mesh" (pairing code) at the end.

## Phases

Each phase ends usable on its own and is tested on two real PCs, one with Claude and one without.

1. Scan and profile (installer and Settings button), identity and keys, trusted networks, the firewall rule,
   discovery (known addresses, mDNS, NetBird), the pairing handshake, mutual TLS, the roster, the election
   and the orchestrator setting, Settings -> Mesh, the Machines app.
   Done when: the two PCs pair with matching numbers, both show the same orchestrator with its reason, and
   pinning the other one in Settings switches it on both. Security checks, each scripted where possible:
   - a third install that is not paired is refused at the TLS step, before any request is read;
   - a pairing where the numbers do not match ends with nothing stored on either side; a fourth attempt in the
     same window is refused;
   - a man in the middle (a test proxy that terminates both sides) always produces different numbers;
   - a replayed message (captured and resent) and a message with an old term are refused;
   - a removed PC is refused by every PC, including one that was offline when it was removed;
   - on a network not marked as trusted, nothing listens on the mesh port and nothing is advertised;
   - the mDNS advertisement of a paired PC contains neither its name nor a stable id.
2. Forwarding: every request from either PC is answered by the orchestrator, with the reply and live steps in
   the entry PC's chat; voice from the non-orchestrator PC works the same; Stop works across PCs; standalone
   mode when the orchestrator is off.
   Done when: on the PC without Claude, a message that needs Claude is answered (by the orchestrator) in that
   PC's chat, and with the orchestrator switched off the PC answers alone and says so.
3. Placement: "here" actions on the entry PC, code on the folder's PC, apps on the app's PC, local-model work
   on the GPU PC, parallel subtasks, retries on another PC.
   Done when: from the laptop, "open Excel" opens it on the laptop, and "build the Elite game" runs on the
   desktop's folder with its steps live in the laptop chat.
4. State: conversations, memory, skills, rules and agents synced to every peer; failover to the next best
   orchestrator; merge after standalone mode.
   Done when: the orchestrator is switched off mid-conversation, the next PC takes over within two minutes,
   the conversation continues, and on return the chats and memory agree.

## Touch points in the code

- `src/core/mesh/` (new): profile scan; identity and DPAPI-protected keys; trusted networks (gateway MAC,
  subnet, SSID); discovery (known addresses, mDNS with rotating tags, NetBird probe); the pairing handshake
  (X25519, HKDF, Ed25519 and TLS 1.3 from Node's own `crypto` and `tls`, no new crypto dependency); mutual
  TLS client and server with pinned keys; the signed roster; election and terms; forwarding, placement, job
  runner and sync. The one new dependency is a small, maintained mDNS package (or about 200 lines on `dgram`).
- `scripts/` and `install.ps1`: the optional firewall rule for the mesh port, scoped to trusted subnets and
  NetBird, created only with your admin approval.
- `install.ps1` / `install.sh`: run the scan, show the profile, offer pairing.
- `src/core/code/localCodeModel.ts` (`detectHardware`) and `src/core/appscan.ts`: reused by the scan.
- `src/channels/manager.ts` and the channels: forward to the orchestrator when this PC is not it.
- `src/core/engine.ts`: placement of tool calls and tiers on peers, PC labels in reports.
- `src/core/code/orchestrator.ts`: a peer for each subtask, chosen by folder, app, GPU and load; retries.
- `src/core/activity.ts`: a `peer` field on events, steps and subtasks.
- `src/core/agents.ts`, `src/core/plans.ts`, `src/core/session.ts`: owned by the orchestrator, synced copies
  elsewhere.
- `src/core/pack.ts`: reused for sync.
- `src/channels/web.ts` and `webui/desktop.js`: the mesh listener, Settings -> Mesh, the Machines app, the
  orchestrator badge.

## Open questions

- Which PCs join first and what each has (always on or not, Claude login, GPU, Office, project folders).
- If the only PC with Claude is a laptop: it coordinates while it is on, and the role falls back to the best
  always-on PC (local and free models only) while it sleeps. Is that right, or should a PC without Claude
  never coordinate? (Proposed: it may, as a fallback, and says so in the chat badge.)
- Should the mesh be reachable from outside the house over NetBird, or LAN only? (Proposed: both, with
  NetBird used automatically on untrusted networks.)
- Pairing confirmation: comparing the 6-digit number on both screens (proposed, safest), or typing one PC's
  code into the other (one step less, but then the code must be long or the exchange needs a PAKE library)?
- Adding a third PC: should the orchestrator always have to confirm it on its own screen, even when you pair
  the new PC with the orchestrator itself? (Proposed: no, pairing with the orchestrator is the confirmation.)
- Sync: everything listed above by default? (Proposed: yes, since the orchestrator owns it and the copies
  only exist for failover.)
