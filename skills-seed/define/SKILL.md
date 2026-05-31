---
name: define
description: Define an English word or phrase (meaning, part of speech, examples). ANY model — http_get https://api.dictionaryapi.dev/api/v2/entries/en/<word> (free, no key). Use for "what does X mean", "definition of X".
---

# Define a word

- `http_get https://api.dictionaryapi.dev/api/v2/entries/en/<word>` → JSON array; each entry has `meanings[]` with `partOfSpeech` and `definitions[].definition` (and sometimes `example`).
- Give the main meaning(s) concisely with the part of speech; add a short example if useful.

## Rules
- A 404 / "No Definitions Found" means the word wasn't found (typo, or not English) — say so, don't invent a definition.
