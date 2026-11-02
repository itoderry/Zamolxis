---
name: delegate
description: Hand work to Claude Code as a worker with the delegate_task tool (or claude_code / claude_cli for one job). Use for changes in a code project (fix, refactor, build, test), for longer research or analysis jobs, and whenever a job splits into independent parts that can run in parallel.
---

# Delegate to Claude Code

Zamolxis can run Claude Code as a worker. You describe the job; the orchestrator picks how and
where it runs and returns the worker's result.

## The two paths

- **Code job** (path 2, `claude_code`): a Claude Code session runs *inside a project folder*. It
  reads, edits and creates files and can run builds and tests (each risky tool still goes through
  the permission policy). The reply lists the files it changed.
- **Non-code job** (path 3, `claude_cli`): the headless `claude -p` CLI with read and web-research
  tools only (no edits, no shell). For research, analysis, comparisons, drafting.

The rule is simple: **if the job needs code, it goes to path 2; otherwise to the CLI.** With
`kind: "auto"` (the default) the orchestrator decides from the task (folder given, file names,
code verbs such as fix/refactor/build/test/commit), and asks the fast model when it is unclear.

## When to delegate

- The user asks for a change in a project ("fix the failing test in my-app", "add a --verbose
  flag to the CLI in D:\work\tool").
- A research or analysis job is long enough to deserve its own worker.
- A job has **independent parts**: send them as separate tasks in ONE `delegate_task` call so
  they run in parallel (e.g. "update the README" + "research how other projects version their
  API"). Two code tasks on the same folder run one after another automatically.

Do not delegate quick answers you can give yourself, or anything the user only wants discussed.

## How to call it

```json
{ "tasks": [
  { "task": "In this repo, make `npm test` pass: fix the failing date test in src/util/date.test.ts. Run the tests to confirm.", "folder": "D:\\work\\my-app" },
  { "task": "Summarize the 2026 changes to the Node.js permission model, with sources.", "kind": "general" }
] }
```

- Write each `task` as complete, self-contained instructions: the worker does not see this chat.
- `folder` must be an **allowed project folder** (Settings -> Code; default the work dir) or a
  subfolder of one. A relative folder is taken inside the first allowed folder. Anything else is
  refused with a message saying where to add it.
- `backend` is `auto` unless the user asks otherwise: code and complex jobs run on Claude, small
  general jobs on a free provider, else a capable local model, else Claude. A free/local run that
  cannot finish is retried once on Claude. **Privacy Mode keeps every run on the local model.**
- `model` optionally overrides the model for the chosen backend.

## After it returns

Report each subtask's outcome to the user: done / incomplete / failed / refused, the files
changed, and the worker's summary. If a subtask was refused (folder not allowed, no usable
backend, claude CLI missing), tell the user exactly what to change in Settings -> Code.
