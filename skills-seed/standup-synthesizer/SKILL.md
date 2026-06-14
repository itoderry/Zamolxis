---
name: standup-synthesizer
description: Draft a team's daily standup from Jira movement — grouped by person as Yesterday / Today / Blockers, with issue keys and a team-blockers wrap-up. Use when the user says "draft the standup", "daily standup", "what did the team do yesterday", or "standup from jira".
---

# Standup synthesizer

Turn the last working day of Jira movement into a standup the team can read in thirty seconds. The board is `JIRA_DEFAULT_PROJECT` unless the user names another. This is **read-only** on Jira — you report what the issues actually show, you never invent progress.

## What to pull

For the project, look at three buckets since the previous working day (skip weekends — Monday's standup covers Friday):

1. **Done** — issues moved to a done/resolved status in the window. These are "Yesterday".
2. **In Progress** — issues currently in an in-progress status. These are "Today".
3. **Blocked** — issues flagged blocked, on hold, or with a blocker status. These feed both each person's "Blockers" and the team wrap-up.

Use `jira_my_issues` / the project search to gather them, and `jira_get_issue` when you need the assignee, status, or summary on a specific ticket.

## How to write it

Group by **person** (the assignee). For each one:

- **Yesterday** — issue keys + short summaries they closed/advanced.
- **Today** — what they have In Progress.
- **Blockers** — anything of theirs that's blocked, or "none".

Always cite the issue key and a brief summary, e.g. `PROJ-214 — fix login redirect`. Keep each line tight; no padding.

Finish with a short **Team blockers** section listing every blocked item across the board (key + who owns it), so nothing hides inside one person's list.

## Rules

- Only report what Jira returns. If someone had no movement, say "no tracked activity" rather than guessing.
- Don't editorialize on whether work is on track — that's not in the data.
- If Jira isn't connected, return the connect-jira setup steps.
