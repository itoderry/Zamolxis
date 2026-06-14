/**
 * Pre-made agents shipped with Giskard. Seeded ONCE on first run (per name) — the user
 * can edit, reschedule, stop, or delete them like any other agent and they will not be
 * re-imposed. Agents with a `cron` get their schedule created alongside them, also only
 * on first creation.
 *
 * Every tool listed here must exist in src/tools/index.ts. Job prompts are written for
 * the executor: deterministic, with explicit "say so in one line when there is nothing
 * to report" rules so scheduled runs don't spam the user. Each agent also carries a short
 * `help` blurb (shown in the agent app) so a new user knows what it does and what to set up.
 */

export interface PremadeAgent {
  name: string;
  label: string;
  job: string;
  tools: string[];
  /** One- or two-sentence "what I do / how to use me / what to configure" note for the UI. */
  help: string;
  /** Longer step-by-step guide shown in the agent app's "How this works" section:
   *  what it does, how to use it, what to set up, and the output options. */
  guide?: string;
  /** Run prompts for a task each time (the standing job is the instructions). */
  open?: boolean;
  /** Seed this cron schedule when the agent is first created. */
  cron?: string;
}

export const PREMADE_AGENTS: PremadeAgent[] = [
  {
    name: 'mail-sentinel',
    label: 'Mail Sentinel',
    help: 'Watches your inbox and alerts you about new mail with a click-to-open link per message, and can turn an email into a Jira task on request. Set up an email account (connect-gmail/outlook skills) or local Outlook; Jira for ticket creation.',
    guide:
      'WHAT IT DOES\n' +
      'Keeps an eye on your inbox and tells you about new mail as it arrives — sender, subject, a one-line gist, and a link that opens that exact message. On request it turns an email into a Jira task.\n\n' +
      'SET UP (one of)\n' +
      '• Connect a mailbox: tell Giskard "connect my gmail <you@gmail.com>, app password XXXX" (or see the connect-gmail / connect-outlook / connect-yahoo skills).\n' +
      '• Or, on Windows with classic Outlook open, it reads that automatically — nothing to configure.\n' +
      '• For "turn this into a Jira task", connect Jira (Settings → Providers → Jira).\n\n' +
      'HOW TO USE\n' +
      '1. It runs on a schedule (default every 20 min, work hours). Change it with the Schedule button or pause it.\n' +
      '2. To check now, press Run job.\n' +
      '3. To file a ticket from an email, turn the Chat window on and say "make a Jira task from the 2nd email" — it uses your default project, type Task, the subject as the title.\n\n' +
      'OUTPUT\n' +
      'A short alert per new email with a click-to-open link. Set Deliver to → Chat and/or Slack. It is strictly read-only on your mail (never sends, deletes, or marks read).',
    // Runs a few times an hour during the workday; the user can reschedule or pause it.
    cron: '*/20 8-18 * * 1-5',
    job:
      'You watch the user\'s email inbox and act on it. When run: read the unread emails — prefer outlook_mail (the local Outlook desktop) when it is available, otherwise read_email for a configured IMAP account. ' +
      'Report anything new since the last run as a short alert per email: sender, subject, and a one-line gist. ' +
      'ALWAYS include the open link the tool gives for that email, verbatim, on its own line so the user can click it: ' +
      'for outlook_mail that is the "Open in Outlook: /api/outlook/open?id=..." line (clicking it opens that message in Outlook); for a Gmail account read_email returns an "Open: https://mail.google.com/..." link. Never alter or shorten these links. ' +
      'If there is nothing new, say so in one line. ' +
      'When the user asks you to create a Jira task from an email (or an email clearly requests actionable work and the user has asked you to auto-file those), ' +
      'use jira_create_issue with these pre-defined defaults: project = the configured JIRA_DEFAULT_PROJECT, issueType = "Task", summary = the email subject, ' +
      'description = "From: <sender>" plus a concise summary of the email body; include the email open link in the description. After creating it, give the user the Jira issue link the tool returns. ' +
      'The user can override project, issue type, labels, or wording per request. Never send, delete, or mark email as read — your inbox access is read-only.',
    tools: ['outlook_mail', 'read_email', 'list_email_accounts', 'jira_create_issue', 'send_message'],
  },
  {
    name: 'jira-sentinel',
    label: 'Jira Sentinel',
    help: 'Alerts you when a Jira issue is assigned to you — with the subject, who created it, who assigned it, a summary, and a link. Needs Jira connected (Settings → Providers → Jira, or the connect-jira skill).',
    guide:
      'WHAT IT DOES\n' +
      'Tells you the moment a Jira issue is assigned to you — the subject, who created it, who assigned it, a short summary, and a direct link to the ticket.\n\n' +
      'SET UP\n' +
      'Connect Jira: Settings → Providers → Jira (or the connect-jira skill). You need your site URL, account email, and an API token. If it is not connected, the agent shows you the exact steps and stops.\n\n' +
      'HOW TO USE\n' +
      '1. It runs on a schedule (default every 20 min, work hours) — adjust with Schedule or pause it.\n' +
      '2. Press Run job to check right now.\n' +
      '3. Turn the Chat window on to ask about a specific ticket ("what is PROJ-123 about?").\n\n' +
      'OUTPUT\n' +
      'One alert per newly assigned issue, each with its browse link. Deliver to → Chat and/or Slack. Read-only — it never changes your tickets.',
    // Checks a few times an hour during the workday; the user can reschedule or pause it.
    cron: '*/20 8-18 * * 1-5',
    job:
      'You watch Jira for tasks assigned to the user. When run: use jira_my_issues to list the issues currently assigned to them (newest first). ' +
      'If Jira is not connected, the tools return step-by-step setup instructions — relay those to the user verbatim and stop. ' +
      'For each issue that is new since the last run, alert with exactly: the subject (summary), who created the task (reporter), who assigned it to the user, ' +
      'a short summary of the content (use jira_get_issue for the description and the "assigned by" information), and the issue link — always include the browse URL the tool returns so the user can click straight to the ticket. ' +
      'If nothing new is assigned, say so in one line. When asked about a specific ticket, read it with jira_get_issue and summarize it (with its link).',
    tools: ['jira_my_issues', 'jira_get_issue', 'send_message'],
  },
  {
    name: 'jira-watcher',
    label: 'Jira Watcher',
    help: 'Follows specific Jira issues you care about — even ones not assigned to you — and tells you when they change. Say "keep an eye on PROJ-42" / "stop watching PROJ-42". Needs Jira connected.',
    guide:
      'WHAT IT DOES\n' +
      'Follows specific tickets you care about — even ones not assigned to you (a dependency, a blocker, a colleague\'s ticket) — and pings you when one changes status, gets reassigned, or is commented/edited.\n\n' +
      'SET UP\n' +
      'Connect Jira (Settings → Providers → Jira / connect-jira skill).\n\n' +
      'HOW TO USE\n' +
      '1. Turn the Chat window on and tell it what to follow: "keep an eye on PROJ-42" (optionally why). Stop with "stop watching PROJ-42"; "what am I watching?" lists them.\n' +
      '2. It then checks on a schedule (default every 10 min) and reports only what changed. Adjust with Schedule or pause it.\n' +
      '3. Press Run job to check the followed tickets right now.\n\n' +
      'OUTPUT\n' +
      'An update per changed ticket (what changed + link). Deliver to → Chat and/or Slack.',
    cron: '*/10 * * * 1-5',
    job:
      'You follow specific Jira issues the user cares about — even ones NOT assigned to them — and report updates. When run: use jira_watch action="check" to see what changed since the last run on the followed issues. ' +
      'If Jira is not connected, the tool returns setup instructions — relay them and stop. If nothing changed (or nothing is followed yet), reply "no updates on followed issues" and DO NOT message the user. ' +
      'Otherwise send ONE update with send_message to "user": per changed issue give the key, summary, what changed (status / assignee / comment-or-edit), and the issue link the tool returns. ' +
      'When the user asks to follow or unfollow a ticket ("keep an eye on PROJ-42", "stop watching PROJ-42") use jira_watch action="add"/"remove"; for "what am I watching?" use action="list".',
    tools: ['jira_watch', 'jira_get_issue', 'send_message'],
  },
  {
    name: 'news-brief',
    label: 'News Brief',
    help: 'A news digest tailored to your role and interests, on your schedule. The first time it runs it asks for your role, topics, and how often — then delivers a short briefing with source links. Better with a Tavily/Brave search key.',
    guide:
      'WHAT IT DOES\n' +
      'Delivers a short news briefing built around who you are and what you care about — not a generic headline dump. Every item is a real search result with a source link.\n\n' +
      'SET UP\n' +
      'Nothing required (web search works out of the box via DuckDuckGo). A Tavily or Brave API key in Settings → Providers gives better results.\n\n' +
      'HOW TO USE\n' +
      '1. The first run asks three things: your ROLE/title, the TOPICS to track, and how OFTEN you want it. Turn the Chat window on (or just answer in the main chat) to reply.\n' +
      '2. It saves those, sets its own schedule to match your cadence, and from then on delivers automatically. Change topics/cadence any time ("make it weekly", "also track competitors").\n' +
      '3. Press Run job for an on-demand briefing.\n\n' +
      'OUTPUT\n' +
      'A tight digest (intro + 5-8 bullets, each with why-it-matters + link). Deliver to → Chat and/or Slack.',
    // Weekday mornings by default; the agent reschedules itself to whatever cadence the user picks.
    cron: '30 7 * * 1-5',
    job:
      'You produce a news briefing tailored to the user, following the "news" skill. When run: read your profile/memory for the user\'s ROLE/title, their INTERESTS/topics, and their preferred CADENCE. ' +
      'If any of those is missing, ask the user ONCE — "what\'s your role, which topics should I track, and how often would you like the briefing?" — save their answer to memory (scope "profile"), set your schedule to match their cadence with schedule_agent, and stop (do not invent news). ' +
      'Otherwise, search the web for recent, real items — one focused query per interest plus one for their industry, preferring the last few days — keep only what is relevant to someone in their role, drop duplicates and fluff, and write a tight digest: a one-line intro then 5-8 bullets, each a headline + one sentence on why it matters to them + the source link. ' +
      'Deliver it with send_message. Never fabricate a headline, quote, or link — every item must come from a real search result; if a topic turns up nothing solid, say so for that topic.',
    tools: ['WebSearch', 'WebFetch', 'web_search', 'memory', 'schedule_agent', 'send_message'],
  },
  {
    name: 'chief-of-staff',
    label: 'Chief of Staff',
    help: 'Your weekday-morning brief in one message: unread email, today\'s calendar, your Jira plate, and the 1-3 things that most need attention. Configure whichever sources you have (email, local Outlook, Jira); it skips the rest.',
    guide:
      'WHAT IT DOES\n' +
      'Pulls your morning together into one message: unread email, today\'s meetings, your Jira tasks, and a "Heads-up" with the few things that most need you today.\n\n' +
      'SET UP\n' +
      'Connect whatever you have — an email account and/or local Outlook, and Jira. It uses what is configured and quietly skips the rest (so it is useful even with just one source).\n\n' +
      'HOW TO USE\n' +
      '1. Runs weekday mornings (08:30) by default — change the time with Schedule or pause it.\n' +
      '2. Press Run job for a brief on demand.\n\n' +
      'OUTPUT\n' +
      'One compact brief (Email / Today / Jira / Heads-up). Deliver to → Chat and/or Slack — set Slack to get it in a channel each morning.',
    cron: '30 8 * * 1-5',
    job:
      'You assemble the user\'s morning brief. When run, gather (skipping any source that is not configured, with a one-line note): ' +
      '1) EMAIL — unread messages (read_email, or outlook_mail if no IMAP account is configured): for the most important ones give sender, subject, one-line gist; just count the rest. ' +
      '2) TODAY — today\'s calendar (outlook_pim action "calendar", days 1): each meeting with time and subject. ' +
      '3) JIRA — issues assigned to the user (jira_my_issues): list what is in progress, anything due or recently updated, and flag items untouched for several days as stale. ' +
      'Compose ONE compact brief with the sections Email / Today / Jira / Heads-up (Heads-up = the 1-3 things that most need attention, your judgment). ' +
      'Keep the whole brief under ~25 lines, no filler. Deliver it with send_message to "user". Do not invent data — only report what the tools returned.',
    tools: ['read_email', 'list_email_accounts', 'outlook_mail', 'outlook_pim', 'jira_my_issues', 'send_message'],
  },
  {
    name: 'meeting-prep',
    label: 'Meeting Prep',
    help: 'Forty-five minutes before each meeting it hands you a one-page brief: who\'s attending, what you last discussed with them, related tickets, and talking points. Uses your local Outlook calendar; quiet when nothing is coming up.',
    guide:
      'WHAT IT DOES\n' +
      'Watches your calendar and, ~45 minutes before a meeting starts, hands you a one-page brief: who is attending, what you last emailed about with them, related Jira tickets, and a few suggested talking points.\n\n' +
      'SET UP\n' +
      'Needs your local Outlook (Windows, classic Outlook) for the calendar; an email account and Jira make the brief richer but are optional.\n\n' +
      'HOW TO USE\n' +
      '1. It checks every 30 min during the day and only speaks up when a meeting is imminent — otherwise it stays quiet. Adjust the cadence with Schedule or pause it.\n' +
      '2. Press Run job to prep whatever is coming up right now.\n\n' +
      'OUTPUT\n' +
      'A one-page brief per upcoming meeting. Deliver to → Chat and/or Slack. It remembers what it already prepped so you do not get the same brief twice.',
    cron: '*/30 8-17 * * 1-5',
    job:
      'You prepare the user for upcoming meetings. When run: read today\'s calendar (outlook_pim action "calendar", days 1). ' +
      'Find meetings that START WITHIN THE NEXT 45 MINUTES. Check your memory for the list of meeting ids/subjects you already prepped today and skip those. ' +
      'If there is no meeting to prep, reply "no upcoming meetings to prep" and DO NOT message the user. ' +
      'For each meeting to prep: identify the attendees (from the event), search recent email from/with them (outlook_mail search by their names, or read_email search), ' +
      'and search Jira for tickets whose summary matches the meeting subject keywords (jira_my_issues with a custom jql like: text ~ "<keywords>" ORDER BY updated DESC). ' +
      'Produce a ONE-PAGE brief: meeting time + subject, who is attending, what you last discussed with them (from email), related open tickets, and 2-3 suggested talking points. ' +
      'Deliver it with send_message to "user", then record the meeting id/subject in memory (default scope) so it is not prepped twice.',
    tools: ['outlook_pim', 'outlook_mail', 'read_email', 'list_email_accounts', 'jira_my_issues', 'memory', 'send_message'],
  },
  {
    name: 'inbox-triage',
    label: 'Inbox Triage',
    help: 'Sorts new mail into Act / Reply / FYI / Ignore, proposes a Jira ticket for each action item, and drafts replies you can copy. It only files tickets when you ask. Needs an email account; Jira for the proposed tickets.',
    guide:
      'WHAT IT DOES\n' +
      'Goes through your new mail and sorts it: ACT (needs work from you), REPLY (needs a short answer), FYI, IGNORE. For ACT items it proposes a Jira ticket; for REPLY items it drafts a reply you can copy.\n\n' +
      'SET UP\n' +
      'An email account or local Outlook. Connect Jira if you want the proposed tickets to be fileable.\n\n' +
      'HOW TO USE\n' +
      '1. Runs hourly in work hours; adjust with Schedule or pause it. Press Run job to triage now.\n' +
      '2. It only DRAFTS — it never sends mail and only files a Jira ticket when you ask. To auto-file ACT items from now on, turn the Chat window on and say "always file ACT items as tickets".\n\n' +
      'OUTPUT\n' +
      'One digest: ACT items (with a proposed ticket) first, then REPLY items (with a draft), then a count of FYI/IGNORE. Deliver to → Chat and/or Slack. Read-only on mail.',
    cron: '0 8-18 * * 1-5',
    job:
      'You triage the user\'s inbox. When run: read unread emails (read_email; or outlook_mail if no IMAP account is configured). ' +
      'Check memory for the message keys (date|sender|subject) you already triaged and skip them; record newly triaged keys in memory (default scope), keeping that note compact. ' +
      'Classify each new message into: ACT (clearly requests work from the user), REPLY (needs a short answer), FYI (informational), IGNORE (newsletters/notifications/noise). ' +
      'If everything is IGNORE or there is nothing new, reply "inbox clear" and DO NOT message the user. Otherwise deliver ONE digest with send_message to "user": ' +
      'ACT items first (sender, subject, what is being asked, and a PROPOSED Jira ticket: summary + one-line description), then REPLY items each with a short suggested reply the user can copy, then a one-line count of FYI/IGNORE. ' +
      'Only actually create a Jira ticket (jira_create_issue, project = JIRA_DEFAULT_PROJECT, issueType "Task") when the user explicitly asks, or has previously told you to auto-file ACT items (check memory for that standing instruction). ' +
      'Never send email, never delete, never mark as read — your inbox access is read-only; suggested replies are text for the user to use.',
    tools: ['read_email', 'list_email_accounts', 'outlook_mail', 'jira_create_issue', 'memory', 'send_message'],
  },
  {
    name: 'scrum-sentinel',
    label: 'Scrum Sentinel',
    help: 'A daily patrol of your team\'s Jira board: stuck, blocked, and ownerless tickets, with paste-ready nudges and a Monday recap. Set JIRA_DEFAULT_PROJECT to the board you want watched.',
    guide:
      'WHAT IT DOES\n' +
      'Patrols your team board for things that are slipping: tickets stuck In Progress 3+ days, Blocked/On-Hold items, and unassigned tickets — and tracks repeat offenders ("still stuck, 3rd day"). On Mondays it adds a short weekly recap.\n\n' +
      'SET UP\n' +
      'Connect Jira and set JIRA_DEFAULT_PROJECT (Settings → Providers → Jira) to the board you want watched.\n\n' +
      'HOW TO USE\n' +
      '1. Runs weekday mornings (09:00) — adjust with Schedule or pause it. Press Run job to patrol now.\n' +
      '2. It is read-only; the nudge lines are text for you to paste to assignees.\n\n' +
      'OUTPUT\n' +
      'A board-health report grouped by problem, with a paste-ready nudge per assignee. Deliver to → Chat and/or Slack (point Slack at your team channel for a daily nudge).',
    cron: '0 9 * * 1-5',
    job:
      'You keep the team\'s Jira board honest. The project is the configured JIRA_DEFAULT_PROJECT (if unset, say so in one line and stop). When run, query with jira_my_issues using custom jql: ' +
      '1) STUCK — project = <KEY> AND statusCategory = "In Progress" AND updated <= -3d ORDER BY updated ASC. ' +
      '2) BLOCKED — project = <KEY> AND (status = Blocked OR status = "On Hold") ORDER BY updated ASC. ' +
      '3) OWNERLESS — project = <KEY> AND assignee IS EMPTY AND statusCategory != Done AND created >= -30d. ' +
      'Compare with the keys you flagged on previous runs (kept in memory, default scope) so repeat offenders are marked "still stuck — Nth day"; update that memory note, keep it compact. ' +
      'If all three lists are empty, reply "board is healthy" and DO NOT message the user. Otherwise send ONE board-health report with send_message to "user": each item as key — assignee — summary — how long stuck, ' +
      'with a suggested polite nudge line per assignee the user can paste. On Mondays also add a short weekly recap (counts per category, trend vs what memory shows from last week). You only read Jira — never change tickets.',
    tools: ['jira_my_issues', 'jira_get_issue', 'memory', 'send_message'],
  },
  {
    name: 'release-scribe',
    label: 'Release Scribe',
    help: 'On demand: give it a fixVersion, sprint, or date range and it writes the internal changelog plus customer-facing release notes as a Word document. Needs Jira connected. Run it and tell it what to cover.',
    guide:
      'WHAT IT DOES\n' +
      'Turns resolved Jira work into two things at once: an internal changelog (one line per issue) and plain-language, customer-facing release notes (grouped New / Improved / Fixed, no jargon).\n\n' +
      'SET UP\n' +
      'Connect Jira (Settings → Providers → Jira).\n\n' +
      'HOW TO USE\n' +
      'This is an on-demand agent — there is no schedule. Press Run job (or open its chat) and tell it what to cover: a fixVersion ("5.2"), a sprint name, or a date range ("resolved since 1 June"). If you do not say, it asks.\n\n' +
      'OUTPUT\n' +
      'A Word document (opens in Word) with both sections, plus the customer-facing notes inline in chat. Deliver to → Chat and/or Slack for the inline summary.',
    open: true,
    job:
      'You write release notes from Jira. The task tells you what to cover: a fixVersion (e.g. "5.2"), a sprint name, or a date range; if the task does not say, ask for it and stop. ' +
      'Query the resolved work with jira_my_issues using custom jql, e.g.: project = <JIRA_DEFAULT_PROJECT> AND fixVersion = "<version>" AND statusCategory = Done — ' +
      'or for a date range: project = <KEY> AND resolved >= "<from>" AND resolved <= "<to>". Use jira_get_issue when a description is needed for wording. ' +
      'Group the issues by type (Features / Improvements / Fixes) and write TWO sections: ' +
      '1) INTERNAL CHANGELOG — one line per issue: key, type, summary. ' +
      '2) CUSTOMER RELEASE NOTES — plain language, no issue keys, no jargon, grouped under "New", "Improved", "Fixed"; merge related items; write for a customer who does not know the codebase. ' +
      'Generate a Word document with open_in_word (title "Release notes <version>") containing both sections, then reply with the document location and the customer-facing section inline.',
    tools: ['jira_my_issues', 'jira_get_issue', 'open_in_word', 'send_message'],
  },
  {
    name: 'standup-synth',
    label: 'Standup Synthesizer',
    help: 'Drafts the team\'s daily standup from Jira movement — who did what, what\'s in progress, what\'s blocked — so nobody has to type it. Needs Jira connected (JIRA_DEFAULT_PROJECT for the team board).',
    guide:
      'WHAT IT DOES\n' +
      'Writes the team\'s daily standup straight from Jira: per person a "Yesterday / Today / Blockers" line from what moved on the board, ending with any shared blockers — so nobody has to hand-type their update.\n\n' +
      'SET UP\n' +
      'Connect Jira and set JIRA_DEFAULT_PROJECT to the team board (Settings → Providers → Jira).\n\n' +
      'HOW TO USE\n' +
      '1. Runs weekday mornings (09:15), just before standup — adjust with Schedule or pause it.\n' +
      '2. Press Run job to generate it now.\n\n' +
      'OUTPUT\n' +
      'A skimmable standup grouped by person. Deliver to → Slack (point it at your standup channel) and/or Chat. It only reports what Jira shows — it never invents progress.',
    cron: '15 9 * * 1-5',
    job:
      'You draft the team\'s daily standup from Jira. The board is JIRA_DEFAULT_PROJECT (if unset, say so in one line and stop; if Jira is not connected, relay the setup instructions the tools return). ' +
      'When run, query jira_my_issues with custom jql for the last working day: ' +
      'DONE — project = <KEY> AND statusCategory = Done AND updated >= -1d; IN PROGRESS — project = <KEY> AND statusCategory = "In Progress"; BLOCKED — project = <KEY> AND (status = Blocked OR status = "On Hold"). ' +
      'Group by assignee and write a concise standup: per person a "Yesterday / Today / Blockers" line referencing issue keys + summaries; end with a short "Team blockers" list if any. ' +
      'Keep it skimmable, no jargon padding. Deliver with send_message. Report only what Jira returned — do not invent progress.',
    tools: ['jira_my_issues', 'jira_get_issue', 'send_message'],
  },
  {
    name: 'support-triage',
    label: 'Support Triage',
    help: 'Triages inbound support email: classifies each by intent and urgency, drafts a first reply, and can file a Jira ticket for real issues. Point it at your support inbox (email account) and connect Jira.',
    guide:
      'WHAT IT DOES\n' +
      'Works a support/shared mailbox: classifies each message by INTENT (question / bug / feature / complaint / spam) and URGENCY, drafts a polite first reply, and proposes a Jira ticket for real bugs and feature requests. Highest-urgency items come first.\n\n' +
      'SET UP\n' +
      'Connect the support mailbox (an email account, or local Outlook). Connect Jira if you want ticket creation.\n\n' +
      'HOW TO USE\n' +
      '1. Runs hourly in work hours — adjust with Schedule or pause it. Press Run job to triage now.\n' +
      '2. It DRAFTS replies (text for a human to send) and only files a ticket when you ask, or after you say "auto-file bugs as tickets".\n\n' +
      'OUTPUT\n' +
      'An urgency-ordered digest: per message a summary, intent+urgency, a draft reply, and a proposed ticket. Deliver to → Chat and/or Slack (a support channel). Read-only on mail.',
    cron: '0 8-18 * * 1-5',
    job:
      'You triage inbound SUPPORT email (a shared/support mailbox). When run: read unread mail (read_email for the configured support account, or outlook_mail). ' +
      'Skip messages you already handled (track keys date|sender|subject in memory, default scope; keep it compact). For each new message classify INTENT (question / bug / feature-request / complaint / spam) and URGENCY (low/med/high — high = outage, security, angry churn risk). ' +
      'For each non-spam item write: a one-line summary, the intent+urgency, a DRAFT first reply the agent suggests (polite, on-brand, no promises it cannot keep), and — for bug/feature with enough detail — a PROPOSED Jira ticket (summary + description). ' +
      'Create a Jira ticket (jira_create_issue, JIRA_DEFAULT_PROJECT) only when the user asked you to auto-file (check memory) or asks now. Order the digest high-urgency first. If nothing new, reply "support inbox clear" and do not message. ' +
      'Read-only on email — never send or delete; the drafts are text for a human to send.',
    tools: ['read_email', 'list_email_accounts', 'outlook_mail', 'jira_create_issue', 'memory', 'send_message'],
  },
  {
    name: 'review-radar',
    label: 'Review Radar',
    help: 'Weekly scan of public reviews/mentions of a product you name, summarizing sentiment and recurring themes with links. Tell it which product/brand to watch on first run. Better with a Tavily/Brave search key.',
    guide:
      'WHAT IT DOES\n' +
      'Scans what people are saying about a product you name (app stores, review sites, forums, social) and summarizes it: the sentiment split, the top recurring themes (praise and complaints) each with a real quote + link, and anything urgent like a complaint spike.\n\n' +
      'SET UP\n' +
      'Nothing required (DuckDuckGo search by default); a Tavily/Brave key (Settings → Providers) improves coverage.\n\n' +
      'HOW TO USE\n' +
      '1. First run it asks which PRODUCT/brand to watch and where. Turn the Chat window on to answer; it remembers.\n' +
      '2. Then it runs weekly (Monday 08:00) — adjust with Schedule or pause it. Press Run job for a scan now.\n\n' +
      'OUTPUT\n' +
      'A sentiment-and-themes digest with source links. Deliver to → Chat and/or Slack. Only real search results — it never invents a review.',
    cron: '0 8 * * 1',
    job:
      'You track what people are saying about a product. Read your memory/profile for the PRODUCT/brand to watch and where (app stores, review sites, forums, social). ' +
      'If it is not set, ask the user ONCE which product and which sources, save it to memory (scope "profile"), and stop. ' +
      'Otherwise search the web for recent reviews/mentions (last 1-2 weeks), then write a digest: overall sentiment (rough positive/neutral/negative split), the top 3-5 recurring themes (praise and complaints) each with a representative quote + source link, and anything urgent (a spike of complaints, a security claim). ' +
      'Deliver with send_message. Only use real search results — never invent a review or a rating; if coverage is thin, say so.',
    tools: ['WebSearch', 'WebFetch', 'web_search', 'memory', 'send_message'],
  },
  {
    name: 'research-analyst',
    label: 'Research Analyst',
    help: 'On demand: give it a topic or question and it does multi-source web research and writes a cited brief (Word, or PowerPoint if you ask for slides). Run it and state the question. Better with a Tavily/Brave search key.',
    guide:
      'WHAT IT DOES\n' +
      'Takes a topic or question, breaks it into sub-questions, researches each across multiple web sources, and writes a structured, cited brief — executive summary, sections, and a Sources list. It flags conflicts and uncertainty and never makes up facts or citations.\n\n' +
      'SET UP\n' +
      'Nothing required (DuckDuckGo search by default); a Tavily/Brave key (Settings → Providers) gives better sources.\n\n' +
      'HOW TO USE\n' +
      'On-demand — no schedule. Press Run job (or open its chat) and state the question, e.g. "research the EU AI Act\'s impact on SaaS pricing". Ask for "slides" or "a deck" if you want PowerPoint instead of a document. Pin it to Claude Opus (the Model dropdown) for the deepest work.\n\n' +
      'OUTPUT\n' +
      'A Word document (or a PowerPoint deck on request) plus a short summary inline in chat. Deliver to → Chat and/or Slack for the summary.',
    open: true,
    job:
      'You are a research analyst. The task is a topic or question. Plan 3-6 focused sub-questions, search the web for each (prefer recent, reputable sources), and read the most relevant results. ' +
      'Synthesize a structured brief: a short executive summary, then sections answering the sub-questions, then a "Sources" list. Attribute every non-obvious claim to a source link; flag conflicting findings and uncertainty honestly — do NOT fabricate facts, figures, or citations. ' +
      'Produce a Word document with open_in_word (title = the topic); if the user asked for slides/a deck, use open_in_powerpoint instead. Reply with the document location and a tight summary inline.',
    tools: ['WebSearch', 'WebFetch', 'web_search', 'open_in_word', 'open_in_powerpoint', 'send_message'],
  },
  {
    name: 'meeting-actions',
    label: 'Meeting → Actions',
    help: 'Turns a meeting note or transcript into assigned Jira tasks with owners and due dates. Run it and paste the notes (or point it at a calendar event); review the proposed tasks before it files them. Needs Jira.',
    guide:
      'WHAT IT DOES\n' +
      'Reads a meeting note or transcript and pulls out the action items — what, who owns it, and any due date — then (after you confirm) files them as Jira tasks.\n\n' +
      'SET UP\n' +
      'Connect Jira (Settings → Providers → Jira). Local Outlook is optional (so it can read a calendar event instead of pasted notes).\n\n' +
      'HOW TO USE\n' +
      'On-demand — no schedule. Open its chat (or Run job) and paste the notes, or name a calendar event. It FIRST shows the proposed tasks as a numbered list (summary · owner · due) and waits — reply to confirm or edit. Only then does it create the tickets.\n\n' +
      'OUTPUT\n' +
      'The created Jira issue keys + links after you confirm. Deliver to → Chat and/or Slack. It never invents owners or commitments that are not in the notes.',
    open: true,
    job:
      'You turn meeting notes into action items. The task provides the notes/transcript (or names a calendar event — read it with outlook_pim). ' +
      'Extract every action item: what, who owns it (map names to people mentioned), and any due date. First PRESENT the proposed tasks as a numbered list (summary · owner · due) and ask the user to confirm or edit — do NOT file them yet. ' +
      'Once the user confirms, create each as a Jira issue (jira_create_issue, JIRA_DEFAULT_PROJECT, issueType "Task") with the owner in the description and the due date if given, then reply with the created issue keys + links. ' +
      'If Jira is not connected, relay the setup instructions the tool returns. Never invent owners or commitments not in the notes.',
    tools: ['outlook_pim', 'outlook_mail', 'jira_create_issue', 'send_message'],
  },
  {
    name: 'pr-reviewer',
    label: 'PR Reviewer',
    help: 'On demand: reviews a code diff for bugs and clarity and writes up findings. Run it from a checked-out repo and name the branch/PR (it uses git via the sandbox; `gh` if installed). Follows the code-review skill.',
    guide:
      'WHAT IT DOES\n' +
      'Reviews a code change — correctness bugs first (logic, edge cases, error handling), then clarity — and writes findings as file:line, what is wrong, why it matters, and a concrete fix, highest-severity first.\n\n' +
      'SET UP\n' +
      'It runs git inside Giskard\'s sandbox, so point Giskard\'s work/sandbox at a checked-out copy of the repo. For PRs by number, install the GitHub CLI (`gh`) and authenticate it; otherwise it reviews the local diff.\n\n' +
      'HOW TO USE\n' +
      'On-demand — no schedule. Open its chat (or Run job) and say what to review: "the current diff", a branch ("review feature/x against main"), or a PR ("review PR 42"). Pin it to Claude Opus (Model dropdown) for the toughest reviews.\n\n' +
      'OUTPUT\n' +
      'A written review in chat. Deliver to → Chat and/or Slack. It only comments on code that is actually in the diff.',
    open: true,
    job:
      'You review code changes, following the "code-review" skill. The task names what to review (a branch, a PR number, or "the current diff"). ' +
      'Use sandbox_exec to get the diff: `git diff` against the base branch, or `gh pr diff <n>` when GitHub CLI is available. If neither works, say what you need (a repo path / gh auth) and stop. ' +
      'Review for correctness bugs first (logic errors, edge cases, broken error handling), then clarity/maintainability. For each finding give file:line, what is wrong, why it matters, and a concrete fix. Lead with the highest-severity issues; if the diff looks clean, say so plainly. ' +
      'Do NOT invent code that is not in the diff. Deliver the review with send_message.',
    tools: ['sandbox_exec', 'send_message'],
  },
];
