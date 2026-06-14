---
name: system-toolkit
description: A Swiss-army system manager for the host machine — health overview (CPU/RAM/disk/uptime), disk cleanup (temp files + recycle bin), startup-program list, running-process viewer with end-task, and a Windows registry cruft scanner that backs up before removing. Backs the System Toolkit desktop app. Use this when the user wants to check system health, free up disk space, see what runs at startup, find a memory hog, or clean leftover registry entries.
---

# System Toolkit

A built-in "Swiss knife" for looking after the machine Giskard runs on (Windows
first-class; Overview and Processes also work on macOS/Linux). It's the **System
Toolkit** desktop app, backed by the `POST /api/system` endpoint.

## Functions

- **Overview** — OS, host, CPU + core count, memory used/total, uptime, and per-drive
  disk usage with bars. (`op: info`, cross-platform.)
- **Cleanup** — scan User/Windows temp, Windows Update cache, thumbnail cache and the
  Recycle Bin, see the reclaimable size, then free it. (`cleanup-scan`, then
  `cleanup-run` with `confirm:true`.)
- **Startup** — list everything that launches at boot (registry Run keys + Startup
  folders), shown read-only. (`startup-list`.)
- **Processes** — top processes by memory; end a runaway one. (`proc-list`, then
  `proc-kill` with `pid` + `confirm:true`; protected/low PIDs are refused.)
- **Registry cleaner** (Windows) — a heuristic scan for leftover *uninstall* entries
  whose install folder is gone and *startup* entries whose target .exe is missing.
  (`reg-scan`.) Always **back up first** (`reg-backup` exports the affected hives to
  timestamped `.reg` files under `~/.giskard/reg-backups/`), then remove the ones you
  pick (`reg-clean` with `confirm:true`). Deletion is gated to the Uninstall/Run roots
  only, so a stray request can't touch the rest of the registry.

## Safety

Every state-changing function is **opt-in and confirmed**: the server rejects
`cleanup-run`, `proc-kill` and `reg-clean` unless the request carries `confirm:true`,
and the app asks the user before each. The registry cleaner is heuristic — entries are
listed for review, never auto-deleted, and a one-click backup makes it reversible.

## Driving it from chat

You can answer "how's my disk doing?", "what's eating my memory?", or "what runs at
startup?" by calling the relevant read op and summarising. For anything destructive
(emptying temp, ending a process, removing registry keys), describe exactly what will
happen and let the user run it from the app, or confirm explicitly first.
