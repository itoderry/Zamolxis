---
name: watch-jira-tasks
description: Follow specific Jira issues (even ones not assigned to you) and get alerted when they change — status moved, reassigned, commented, or edited. Use when the user says "keep an eye on PROJ-42", "follow this ticket", "watch the issues blocking my release", "any updates on the tickets I'm watching?", or "stop watching PROJ-42".
---

# Watch Jira tasks

Beyond the issues assigned to you (Jira Sentinel), you can **follow any Jira issue** you have a stake in — a dependency, a blocker, a colleague's ticket — and Giskard alerts you when it changes. A background watcher (jiraTasks, default every 10 min, toggle in Settings → System → Proactive) polls the followed issues; the **Jira Watcher** pre-made agent reports the changes.

Manage the list from chat with the `jira_watch` tool:

- **Add**: `jira_watch action="add" key="PROJ-42"` — optional `note` (why you're following it). The reply confirms with the current status, assignee, and a link.
- **Remove**: `jira_watch action="remove" key="PROJ-42"`.
- **List**: `jira_watch action="list"` — every followed issue with its current status, assignee, and link.
- **Check now**: `jira_watch action="check"` — reports what changed since the last check.

A change is reported when the issue's **status** moves, its **assignee** changes, or it's otherwise **updated** (a new comment or edit advances the timestamp). Each alert includes the browse link so you can click straight to the ticket.

Requires Jira to be connected (see the connect-jira skill, or Settings → Credentials → JIRA_*). If it isn't, `jira_watch` returns the setup steps.

## How to respond

- "keep an eye on PROJ-42 because it blocks my release" → `add key="PROJ-42" note="blocks my release"`.
- "what am I watching?" → `action="list"`.
- "any updates?" → `action="check"` and summarize the changes with links; if none, say so.
- "stop watching PROJ-42" → `action="remove" key="PROJ-42"`.
