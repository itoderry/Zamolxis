---
name: connect-slack
description: Connect Giskard to Slack so you can chat with it from a Slack DM or by @-mentioning it in a channel. Walks through creating the Slack app, enabling Socket Mode, the scopes and tokens, and where to paste them. Use when the user says "connect slack", "set up the slack bot", "add giskard to slack", or asks for Slack before it's configured.
---

# Connect Slack

Giskard talks to Slack over **Socket Mode** — no public URL or inbound webhook needed, so it works from a laptop behind a firewall. You create a Slack app once, copy two tokens, and paste them into Giskard. It then answers **direct messages** and **@-mentions** in any channel it's invited to.

You need two tokens:
- **Bot token** `xoxb-…` → `SLACK_BOT_TOKEN`
- **App-level token** `xapp-…` (scope `connections:write`) → `SLACK_APP_TOKEN`

## Steps

1. **Create the app.** Go to https://api.slack.com/apps → **Create New App** → **From scratch**. Name it (e.g. "Giskard") and pick your workspace.
2. **Enable Socket Mode.** Left sidebar → **Socket Mode** → toggle **Enable Socket Mode** on. When prompted, generate an **App-Level Token** with the `connections:write` scope — copy the `xapp-…` value (this is `SLACK_APP_TOKEN`).
3. **Add bot scopes.** Left sidebar → **OAuth & Permissions** → **Scopes → Bot Token Scopes**, add:
   - `app_mentions:read` (see @-mentions)
   - `chat:write` (reply)
   - `im:history`, `im:read`, `im:write` (direct messages)
   - (optional) `channels:history`, `groups:history` if you want it to read channel context.
4. **Subscribe to events.** Left sidebar → **Event Subscriptions** → toggle on. Under **Subscribe to bot events** add:
   - `app_mention`
   - `message.im`
   Save.
5. **Install to the workspace.** **OAuth & Permissions** → **Install to Workspace** → Allow. Copy the **Bot User OAuth Token** `xoxb-…` (this is `SLACK_BOT_TOKEN`).
6. **Paste into Giskard.** Settings → Credentials → the "slack" group:
   - `SLACK_BOT_TOKEN` = the `xoxb-…` token
   - `SLACK_APP_TOKEN` = the `xapp-…` token
   Then enable the channel: Settings → Channels → toggle **Slack** on (or set `GISKARD_CHANNEL_SLACK=true` in `.env`). Channels apply on the next reload/restart.
7. **Use it.** DM the bot, or invite it to a channel (`/invite @Giskard`) and @-mention it. The Main chat is mirrored across every connected channel, so a conversation started in Slack continues in the web UI and vice-versa.

## Troubleshooting

- **No response to a DM:** confirm `message.im` is in Event Subscriptions and the `im:*` scopes were added, then reinstall the app (scope changes require reinstall).
- **No response to a mention:** the bot must be **invited** to that channel, and `app_mention` must be subscribed.
- **"not_authed" / startup error in the log:** a token is wrong or missing — re-copy `xoxb-` (Bot token) and `xapp-` (App-level token, `connections:write`); they are not interchangeable.
- A bad Slack token only breaks the Slack channel — the web UI and other channels keep running.
