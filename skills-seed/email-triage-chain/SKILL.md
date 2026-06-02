---
name: email-triage-chain
description: Pattern for chaining agents to triage email across multiple accounts — cheap "fetcher" agents read each mailbox, then hand off to one smart "processor" agent that interprets and digests them. Use when the user wants multi-account email handling with agents.
---

# Email triage with a chain of agents

Goal: cheap models do the rote fetching from each mailbox; a smart model does the thinking
once, on the combined result. Uses `read_email` (read-only) + `send_message` (agent→agent).

## Set up the accounts first
Each mailbox must be in `<dataDir>/emails.json` (see the connect-gmail / connect-outlook /
connect-yahoo / connect-imap-generic skills). Note each account `name`.

## Create the agents

**One fetcher per account** (cheap/local model, tools: `read_email`, `send_message`):
- Job, e.g. for Gmail: *"Call read_email with account 'gmail-personal' and unreadOnly true. Then call send_message to 'mailproc' with a plain list of the messages you got (sender, subject, date). Do nothing else."*
- Repeat for `hotmail-personal`, `yahoo-personal` (one agent each).

**One processor** (smart model, canElevate on):
- Name: `mailproc`. Job: *"You receive lists of emails from the fetcher agents. Combine them, drop newsletters/noise, flag anything urgent or needing a reply, and send_message to 'user' with a short prioritized digest grouped by account."*

The fetchers run on the dumb tier (fast, free); only `mailproc` uses the smart model — and
only once, on the gathered data.

## Run the chain
- **On demand:** run each fetcher (they each `send_message` to `mailproc`; `mailproc` then
  messages you). Or just tell Zamolxis "triage my email" and let it run the fetchers.
- **On a schedule:** schedule the fetchers (e.g. "every morning at 8") — each fires, hands to
  `mailproc`, and you get one digest. (Stagger or let `mailproc` collate as messages arrive.)

## How the hand-off works
`send_message(to: "mailproc", ...)` from a fetcher triggers `mailproc` to run on what it was
sent (bounded by the agent-hop loop guard). `mailproc` then `send_message(to: "user", ...)`,
which appears in your Main chat as a one-time link to its chat (and in mailproc's own chat).

## Keep it read-only
`read_email` never sends or deletes. If you later want the processor to *draft* replies,
that's a separate, approval-gated step — it won't send on its own.
