---
name: outlook-calendar
description: Read the user's Outlook calendar, contacts and tasks from the local classic Outlook desktop app with the outlook_pim tool. Use for "what's on my calendar today/this week", "when is my next meeting", "find <person>'s phone or email", "what are my open tasks".
---

# Outlook calendar, contacts & tasks (local, read-only)

The `outlook_pim` tool reads the user's calendar/contacts/tasks straight from classic Outlook on this machine - no cloud login. READ-ONLY: it cannot create, change, or respond to anything.

- Upcoming events: `outlook_pim` `action="calendar"` with `days=1` (today), `7` (week, default), up to 60.
- A person's details: `action="contacts", query="tony"` - matches name, company, email.
- Open to-dos: `action="tasks"`.

When answering: give events in chronological order with time, title, and location; flag overlaps. For "when am I free" questions, derive the gaps between events and say which day you assumed.
