# Changelog

## 0.3.0

Smarter, cheaper routing and full local-model control.

### Routing
- **Cheapest-capable-brain ladder** reworked: free cloud → paid → **local last** → frontier subscription tier (rescue/escalation only). The local model is no longer the default first stop.
- **Deterministic arithmetic**: a pure formula (e.g. `(2+45-32+56)/334`) is computed directly with no model.
- **Targeted escalation**: `escalate`, `escalate <model>`, or `escalate <number>` to jump to a specific tier (typos tolerated); input autocomplete for model names.

### Local models
- **Local-model panel** (Tools → Local model): install the runtime if missing, browse/pull a curated general-chat catalog (all tool-capable) with live progress, keep several models and switch the active one any time, delete unused ones.
- Per-model settings: **routing** (off / auto last-resort), **context window** (num_ctx), **keep-alive**, **temperature**; **GPU/CPU split** indicator and a per-model **Test** button.
- Active model + settings persist across restarts; the models rail shows `Local - <model>`.
- Installer now recommends **general-chat all-rounders** (tool-capable) instead of code-tuned defaults.

### Skills & tools
- **`/skill` calls** with `/` autocomplete to force a specific skill/tool.
- **Home Assistant device map**: `/hasync` (or the `ha_build_map` tool) scans HA and the smart model writes a dead-simple `home-assistant-devices` skill (by area, by type, with aliases + exact entity_ids) so the local model can control the house reliably.

### Control & safety
- **Per-(model, skill) ban list**: `/ban [skill] [model]` and `/unban`, editable in the Memory panel; a banned model refuses that capability and routing prefers a non-banned one. The smartest model can never be banned. Auto-bans the local model from a skill when you escalate right after it used that skill.

### Docs
- Added `DESCRIPTION.md` (clear overview + disclaimer).
