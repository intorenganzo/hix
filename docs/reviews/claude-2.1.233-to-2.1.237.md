# Upstream delta review: Claude Code 2.1.233 → 2.1.237

Reviewed: 2026-09-16
Source: `https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md` (fetched 2026-09-16; entries present for all of 2.1.234–2.1.237)
Method: changelog review against the HIX-relevant surfaces listed in `docs/harness-maintenance.md` (skill locations/metadata, native agent locations/metadata, model and reasoning-effort declarations, invocation policy, context/delegation behavior, tool/authority configuration, composition, materialization targets). Performed by an AI research agent; adopted into this repository as the recorded review.

## Verdict

**No HIX-relevant surface changes in 2.1.234–2.1.237.** Nothing renames, moves, or alters any file format, skill/agent location, frontmatter field, or settings schema that HIX parses or materializes. This review supports the reviewed range `2.1.233–2.1.237` in `harnesses/support.json`. It is a review claim, not conformance evidence; only `testedVersions` entries carry conformance evidence.

## Per-version notes (HIX-adjacent items and why they do not qualify)

### 2.1.234
- "Removed the 'Default teammate model' setting from `/config`; agent-team teammates now use the leader's model unless the spawn names one" — changes runtime model-resolution semantics for agent teams; does not touch `.claude/agents` frontmatter, which still wins when the spawn names a model. No parsed or materialized surface changed.
- "Reduced the context cost of loading the built-in `claude-api` skill … by loading reference docs on demand" — built-in skill loading optimization; SKILL.md format and discovery unchanged.
- "Added the optional `CLAUDE_CODE_PROJECT_DIR_NAME` environment variable …" — affects per-project transcript directory naming only; HIX does not read transcript paths.
- "Background task notifications delivered between turns are now sent to the model inside `<system-reminder>` tags …" — delivery detail; no format HIX touches.

### 2.1.235
- "Fixed the Agent tool advertising a general-purpose default in sessions where that agent is unavailable …" — invocation-behavior bugfix; no schema change.
- New `spellcheck` setting in settings.json — unrelated to skills/agents/permissions surfaces HIX reads.

### 2.1.236
- "Fixed skills hot-reload in SDK/VS Code sessions raising an error … after the session's working directory was deleted (2.1.229+)" — discovery bugfix only; locations and formats unchanged.
- "Added `ANTHROPIC_DEFAULT_MODEL` environment variable …" — session-level model declaration, not skill/agent configuration.

### 2.1.237
- No HIX-relevant entries ("Fixed prompt caching for sessions using an LLM gateway or custom base URL"; new built-in "Concise" output style).

Remaining entries across the range are TUI, Remote Control, permissions-preview, rendering, and platform bugfixes with no bearing on the reviewed surfaces.
