---
name: meeting-actions
description: Turn a meeting note or transcript into assigned Jira tasks — what, who owns it, when it's due — confirming the list before filing. Use when the user says "turn these notes into tasks", "create tasks from this meeting", "action items from the meeting", or "file these as jira tasks".
---

# Meeting actions

Pull the real commitments out of a meeting note or transcript and turn them into Jira tasks — but only after the user signs off on the list.

## Step 1 — extract and propose (always first)

Read the notes and find the concrete action items. For each, identify:

- **What** — the task, in a short summary line.
- **Owner** — who agreed to do it.
- **Due date** — if one was stated.

Present them back as a **numbered list**, one per line: `summary · owner · due`. Then ask the user to confirm or edit. **Do not file anything yet.** If something is ambiguous ("we should look into X" with no owner), list it but mark the gap rather than assigning it to someone.

## Step 2 — file on confirmation

Once the user confirms (with any edits), create each task with `jira_create_issue`:

- Project = `JIRA_DEFAULT_PROJECT`, type = **Task**.
- Put the **owner** in the description (and the due date if one was given).
- Summary = the task line.

Return the resulting **issue keys + browse links** so the user can click straight through.

## Rules

- **Never invent** an owner, a task, or a commitment that isn't in the notes. If nobody owns an item, leave it unassigned and say so.
- Don't file before confirmation, even if the user sounds eager — show the list first.
- If Jira isn't connected, return the connect-jira setup steps before step 2.
