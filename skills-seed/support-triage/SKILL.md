---
name: support-triage
description: Triage the support inbox — classify each email by intent and urgency, draft a polite first reply, and propose a Jira ticket for real bugs or feature requests. Use when the user says "triage support email", "any urgent support tickets", "handle the support inbox", or "classify support mail".
---

# Support triage

Work the inbound **SUPPORT** mailbox and hand back a prioritized, actionable digest. Read email with `read_email` — this is **read-only**; the replies you write are drafts in text for a human to review and send, you don't send anything yourself.

## Classify each message

Two axes:

- **Intent** — one of: question, bug, feature-request, complaint, spam.
- **Urgency** — low / med / high. Treat as **high** anything that smells like an outage, a security issue, or a customer at real risk of churning. Most "how do I…" questions are low/med.

## For each real message

1. A one-line read: who, what they want, intent + urgency.
2. A **draft first reply** — polite, specific, acknowledges the issue and gives a next step or an honest "we're looking into it". Don't promise fixes or dates you can't back up.
3. If it's a genuine **bug or feature-request**, propose a Jira ticket: a suggested summary, type (Bug/Task), and a one-line description. Propose it — don't file it yet.

## Order and output

Lead with **high-urgency** items, then med, then low. Spam goes in a short "ignored" tail, not the body.

## Filing tickets

Only call `jira_create_issue` when the user asks ("file that one", "ticket the second bug") **or** there's a standing auto-file instruction in their profile. Otherwise stop at the proposal. When you do file, use `JIRA_DEFAULT_PROJECT` and return the issue key + link.

## Rules

- Never invent customer details or a fix that doesn't exist. If you're unsure of intent, say so and ask.
- If the mailbox or Jira isn't connected, return the relevant connect-* setup steps.
