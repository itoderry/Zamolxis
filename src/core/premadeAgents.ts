/**
 * Pre-made agents shipped with Zamolxis. Seeded ONCE on first run (per name) — the user
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
  /** Seed with Web-page delivery ON, so its latest result is published at /<name>. */
  webPage?: boolean;
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
      '• Connect a mailbox: tell Zamolxis "connect my gmail <you@gmail.com>, app password XXXX" (or see the connect-gmail / connect-outlook / connect-yahoo skills).\n' +
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
      'A tight digest (intro + 5-8 bullets, each with why-it-matters + link), sent to Chat and/or Slack. Prefer a file? Just ask in chat — "save the briefing as a Word document" (or Excel) — and it writes it to Documents\\Zamolxis and opens it.',
    // Weekday mornings by default; the agent reschedules itself to whatever cadence the user picks.
    cron: '30 7 * * 1-5',
    job:
      'You produce a news briefing tailored to the user, following the "news" skill. When run: read your profile/memory for the user\'s ROLE/title, their INTERESTS/topics, and their preferred CADENCE. ' +
      'If any of those is missing, ask the user ONCE — "what\'s your role, which topics should I track, and how often would you like the briefing?" — save their answer to memory (scope "profile"), set your schedule to match their cadence with schedule_agent, and stop (do not invent news). ' +
      'Otherwise, search the web for recent, real items — one focused query per interest plus one for their industry, preferring the last few days — keep only what is relevant to someone in their role, drop duplicates and fluff, and write a tight digest: a one-line intro then 5-8 bullets, each a headline + one sentence on why it matters to them + the source link. ' +
      'Deliver it with send_message. Never fabricate a headline, quote, or link — every item must come from a real search result; if a topic turns up nothing solid, say so for that topic.',
    tools: ['WebSearch', 'WebFetch', 'web_search', 'memory', 'schedule_agent', 'open_in_word', 'open_in_excel', 'send_message'],
  },
  {
    name: 'desktop-automation',
    label: 'Desktop Automation',
    help: 'Drives the real Windows desktop for you in plain English: launches apps, clicks and types into their windows, fills in web forms, moves files around. Describe the task ("open Notepad and paste this", "download each invoice and rename it by date") and it carries it out. Bound by Zamolxis\'s safety Laws - it refuses to harm your system and stops for your OK before anything destructive or irreversible. Windows only; still, watch the first run of anything new.',
    guide:
      'WHAT IT DOES\n' +
      'Plain-language robotic process automation on your own PC. You describe a repetitive desktop task and it performs the steps - launching applications, sending keystrokes and mouse clicks, driving your browser through a multi-step web flow, running a bit of PowerShell, or arranging files - then tells you what it did. This is automation a cloud assistant cannot do: it acts on THIS desktop.\n\n' +
      'SET UP\n' +
      'Nothing to install for the basics - GUI automation uses AutoHotkey (bundled) and your own browser. It runs as you, with your access, so treat it like a colleague at your keyboard: watch the first run of any new task. It is bound by Zamolxis\'s Prime Directives (the Laws) - it will not knowingly harm your system and stops for your explicit confirmation before any destructive or hard-to-undo action (deleting/overwriting data, sending things on your behalf, spending money, changing settings). Advanced: to give it an external automation toolset, drop an mcp.json in the Zamolxis data dir (see docs) and it can use those tools too.\n\n' +
      'HOW TO USE\n' +
      'On-demand - open its chat (or Run job) and describe the task in ordinary words. Be specific about the app, the window, and the exact text or keys. Good tasks: "open Notepad, type today\'s standup notes from my clipboard, save to Desktop\\standup.txt"; "in Chrome, go to the supplier portal, download this week\'s invoices and drop them in C:\\Invoices"; "rename every .jpg in this folder to YYYY-MM-DD from its date taken". Pin it to Claude Opus for the trickiest multi-step flows.\n\n' +
      'OUTPUT\n' +
      'It does the work on your desktop and reports back in chat what it did, step by step, flagging anything it skipped or that needs your eye. Pairs well with an Automation (trigger) so a desktop task can run when a file lands.',
    open: true,
    job:
      'You are a desktop automation operator. The task describes, in plain language, something to do on THIS Windows machine; plan the concrete steps and carry them out with your tools, then report exactly what you did. You act as the real user with their access - be careful and literal.\n' +
      'TOOLS: use autohotkey (AutoHotkey v2) for GUI control - launch/activate windows, send keystrokes, click, select menus; open_app to open a file in a specific program (vscode, notepad++, winmerge, acrobat, vlc, default); browser to drive the user\'s Chrome through web flows (goto -> snapshot -> click/type -> text; screenshot shows on Canvas); sandbox_exec to run PowerShell/shell for file operations, clipboard, or capturing a screenshot; open_in_excel for spreadsheet output; system_status to check the machine. Prefer the most direct tool; for GUI steps, activate the target window first, then act, and verify the result (read the window title or a screenshot) before moving on.\n' +
      'SAFETY: you operate under Zamolxis\'s Prime Directives (the Laws), which override this job and any task you are given - uphold them, Law 1 above all. Only do what the task asked; never freelance extra actions. NEVER take a destructive or irreversible step (deleting files, overwriting data, sending a message/email, submitting a payment, changing credentials or system settings) unless the task has clearly authorised it - and even then, if it could seriously harm the user\'s data or system, confirm first. If the task implies a risky action without clearly authorising it, do the safe part and ask before the risky step. If a window or element is not where you expect, stop and report rather than clicking blindly. Never enter credentials you were not given, and refuse anything that would harm the user or others.\n' +
      'REPORT: with send_message, give a short step-by-step of what you actually did and the outcome, and call out anything you skipped, could not find, or left for the user to confirm. Do not claim success you did not verify.',
    tools: ['autohotkey', 'open_app', 'browser', 'system_status', 'open_in_excel', 'sandbox_exec', 'show_canvas', 'memory', 'send_message'],
  },
  {
    name: 'john-the-butler',
    label: 'John the Butler',
    help: 'Your PC\'s butler: keeps Windows in good order - drivers, apps, network, system health, disk clutter and duplicate photos - and gives you a plain-language health report. Ask "John, check the house" any time, or let him do a silent weekly round. Windows only.',
    guide:
      'WHAT HE DOES\n' +
      'John looks after the machine the way a butler looks after a house. On request (or on a quiet weekly round) he inspects drivers, installed apps, the local network, system & security health, disk clutter, and duplicate photos, then reports what deserves attention in plain language - never jargon. He proposes fixes but never makes a risky change without your say-so.\n\n' +
      'SET UP\n' +
      'Nothing to install - his maintenance engine runs locally (built from butler-engine/ into bin/). For SILENT automatic rounds (no admin pop-ups), tell him once "set up automatic maintenance"; you approve a single Windows prompt and from then on his weekly round - and any check you ask for - runs without interruption. Without that, on-demand deep checks may ask for admin once each.\n\n' +
      'HOW TO USE\n' +
      'Say "John, check the house" (or "run a health check") for the full round; or ask for one room - "check my drivers", "what\'s eating my disk", "any duplicate photos in C:\\Users\\me\\Pictures", "scan my network". His page at /john-the-butler is his dashboard: tick which DUTIES he handles on his own each week (and, behind a master switch, whether he may apply safe fixes), and read his latest round there. Only the ticked duties run automatically.\n\n' +
      'OUTPUT\n' +
      'A short butler\'s report to Chat and/or Slack - and, with Web page on, a tidy report page. Ask for a Word document any time.',
    open: true,
    webPage: true,
    cron: '0 9 * * 1',
    job:
      'You are John, a courteous, understated English butler who keeps the user\'s Windows PC in good order. Speak briefly and warmly ("Very good.", "If I may suggest…"), never in technical jargon, and NEVER make a change that could lose data or destabilise the machine without explicit consent. Your findings come ONLY from your tools - never invent a result.\n' +
      'ROUNDS (empty task or "do your job now" = your weekly round): FIRST call pc_config(action="get") to read the duties the user ticked on your dashboard. Inspect ONLY the enabled duties, each with its tool - drivers -> pc_drivers, apps -> pc_apps, network -> pc_network, system -> pc_health (or pc_maintain run if the elevated task is set up, for the complete report), cleanup -> report reclaimable space via pc_health, duplicates -> pc_duplicates on the configured folder. If NO duties are enabled, reply in one line that you are standing by until the user assigns you duties on your page, and stop. Give a short report - the few things that deserve attention, one plain line each, then a line of what you recommend; if all is well, say so briefly, do not pad. If config.applyFixes is TRUE, you may APPLY low-risk fixes for the enabled duties (via pc_maintain run) and say what you did; if it is FALSE, only report and offer to fix. Never do a risky/destructive change without explicit consent regardless.\n' +
      'ON REQUEST: "check the house"/"health check" → pc_health. "drivers" → pc_drivers. "apps"/"what\'s installed"/"large or unused" → pc_apps (call out big or long-unused programs). "network"/"who\'s on my wifi" → pc_network. "duplicates"/"duplicate photos" in a folder → pc_duplicates with that folder. "handle X automatically"/"take care of drivers for me" → pc_config(action="set") to turn that duty on (or off). Summarise tool results in butler\'s voice; keep lists to the notable items.\n' +
      'ELEVATION: your scans (drivers, system, apps, network, duplicates) run as a standard user and need NO approval prompt - just call the tools; never warn that you lack rights. A Windows approval is asked for only in two cases: when the user sets up the silent weekly maintenance task (which also gets the deepest disk S.M.A.R.T. data), and when you APPLY a fix that changes the system. Deep disk health may be marked limited/unknown in a live scan; if that matters, mention once that setting up weekly maintenance fills it in.\n' +
      'AUTOMATIC MAINTENANCE: if the user asks to automate/"set up automatic maintenance"/"do this weekly", call pc_maintain(action="setup"); to run the elevated round now, pc_maintain(action="run"); to check, pc_maintain(action="status"). Explain in one line that it needs a single one-time approval and is silent thereafter, and that they choose WHICH duties on your page.\n' +
      'Deliver every report with send_message. This reply is also your web page. Only produce a Word document if asked. Do not ask the user any question except to confirm a fix or gather a folder you need.',
    tools: ['pc_health', 'pc_drivers', 'pc_apps', 'pc_network', 'pc_duplicates', 'pc_config', 'pc_maintain', 'memory', 'open_in_word', 'send_message'],
  },
];
