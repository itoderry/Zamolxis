---
name: self-dev
description: Modify your OWN source code, rebuild, and restart yourself. Use when the user asks you to change, fix, extend, or tune Zamolxis itself (your routing, tools, skills, web UI, providers, prompts). Needs Claude (filesystem + shell).
---

# Self-development (tweak your own code)

You ARE Zamolxis. Your source code is a TypeScript project you can edit, rebuild, and restart.

## Find your repo
Your install lives in the directory that contains `bin/zamolxis.mjs` and `package.json` (this machine: `S:\TRUNK\Zamolxis`; on others, locate it — e.g. `npm root -g`/where you were installed, or ask). All commands below run from that repo root via the shell tool.

## Safe change loop (always, in order)
1. **Understand first** — read the relevant files under `src/` before editing. Key areas: `src/core/engine.ts` (routing, tiers, escalation), `src/core/providers.ts` (free/paid providers), `src/core/memory.ts` + `src/core/learnings.ts` (memory/learnings), `src/channels/web.ts` (web UI — one big `PAGE` template literal: NO backticks/`${}` inside it, use string concat), `src/tools/index.ts` (MCP tools), `src/config.ts`.
2. **Edit** with small, focused changes.
3. **Typecheck**: `npx tsc -p tsconfig.json --noEmit` — must be clean before building.
4. **Build**: `npm run build`.
5. **Restart yourself**: `node bin/zamolxis.mjs restart`. This force-frees the web port and starts the new build. (If it reports the port is "still held", an instance is running in an elevated/another-user context you can't kill — tell the user to end that process or reboot.)
6. **Verify** the change did what was intended (logs at `<dataDir>/logs/zamolxis.log`, or ask the user to try it).

## Rules
- NEVER restart yourself in the middle of replying to something the user is waiting on without telling them — the restart drops the current connection. Finish the answer, say you're restarting, then do it.
- NEVER run yourself elevated/as admin — then future restarts can't kill the old process (the port stays stuck). Run as the normal user.
- Don't break the build: if `tsc` or `npm run build` fails, fix it before restarting; never restart on a broken build.
- Keep secrets out of code: API keys/tokens live in `.env`/settings, never hard-coded.
- The web UI `PAGE` literal forbids backticks and `${}`; validate page JS after edits.
- After a behavior change, consider whether the installer (`install.ps1`/`install.sh`), `.env.example`, or `skills-seed/` should be updated too, so a fresh install gets it.
- Big or risky changes: explain what you'll change and why before doing it.
