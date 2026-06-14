---
name: connect-jira
description: Connect Giskard to Jira Cloud so it can create issues, list your assigned tasks, and alert you when something is assigned to you. Use when the user says "connect jira", "set up jira", or asks for Jira features before credentials exist.
---

# Connect Jira

Giskard talks to Jira Cloud over its REST API with an API token. Three credentials are needed (plus an optional default project):

1. **JIRA_BASE_URL** — the site URL, e.g. `https://your-company.atlassian.net`.
2. **JIRA_EMAIL** — the Atlassian account email.
3. **JIRA_API_TOKEN** — create one at https://id.atlassian.com/manage-profile/security/api-tokens ("Create API token", give it a label, copy the value).
4. **JIRA_DEFAULT_PROJECT** (optional) — the project key (e.g. `PROJ`) used when creating issues without an explicit project.

## Steps

1. Ask the user for the four values above (the token is secret — never echo it back).
2. Have them paste the values in **Settings → Credentials** (group "jira"), or set them in `.env`. Saved credentials apply live.
3. Verify with the `jira_my_issues` tool — it should list the user's open issues.
4. Tell the user what is now available:
   - `jira_create_issue` — create a task/bug/story (defaults: project = JIRA_DEFAULT_PROJECT, type = Task).
   - `jira_my_issues` — list issues assigned to them.
   - `jira_get_issue` — read one ticket in full (reporter, who assigned it, description).
   - The **Jira Sentinel** pre-made agent and the **Jira assigned** proactive watcher (Settings → System → Proactive) alert when a new task is assigned to them: subject, who created it, who assigned it, and a summary of the content.
   - The **Mail Sentinel** pre-made agent can turn an email into a Jira task on request.
