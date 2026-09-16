# Upstream delta review: Codex CLI 0.147.0 → 0.154.0

Reviewed: 2026-09-16
Source: GitHub release bodies for rust-v0.148.0 through rust-v0.154.0 (fetched 2026-09-16 via the GitHub API). Versions in range: 0.148.0, 0.149.0, 0.149.1, 0.150.0, 0.150.1, 0.151.0, 0.152.0, 0.152.1, 0.153.0, 0.153.1, 0.153.2, 0.153.3, 0.153.4, 0.154.0.
Method: release-note review against the HIX-relevant surfaces in `docs/harness-maintenance.md`, followed by classification against the surfaces HIX actually reads and writes (`src/endpoints.js`, `src/composition.js`, `src/project.js`, `src/capability-probe.js`). Performed by an AI research agent; classification adopted after inspection of the HIX source.

## Verdict

**Upstream HIX-relevant changes: YES. HIX-parsed/materialized surfaces: unchanged, with recorded unknowns — no reviewed range is claimed for this interval.**

Consequence for `harnesses/support.json`: `knownVersion` advances to 0.154.0 after this review; 0.154.0 becomes a tested version only through live conformance evidence; the interior versions 0.148.0–0.153.4 carry no claim of any kind.

## Classification against HIX's actual surfaces

| Upstream change | Version | HIX impact |
| --- | --- | --- |
| Skill frontmatter model annotations added (#38467, #38475) then removed (#39068) | 0.148 → 0.149 | None net: 0.154 skill frontmatter matches 0.147 expectations. HIX emits model selection to `.codex/agents/<agent>.toml:model`, never to skill frontmatter. |
| Skill validation rejects TODO placeholders (#38384) | 0.148.0 | Target-side acceptance change. HIX copies source instructions verbatim; a source skill containing TODO placeholders now fails Codex validation at install. HIX validates artifacts, not target acceptance; recorded as a known target behavior. |
| Repository-local Codex skills removed (#38635); legacy core skill loader removed (#37457, #37505) | 0.148.0 | `codex:legacy` (`~/.codex/skills`) and `codex:project` endpoints still read bytes on disk correctly, but whether the 0.154 runtime still loads those locations is **unknown from notes** — the endpoint remains an inspection surface, not a runtime-loading claim. |
| New/renamed config.toml keys: `tools.update_plan.enabled` (0.152), `tui.disable_paste_burst`, `tui.auto_recap`, `features.context_management.experimental_mode` (0.153); unnamed renames #37400, #39830 | 0.148–0.153 | None: HIX does not parse `config.toml` contents; the probe checks file presence only. |
| MCP server-name charset widened; per-tool `output_token_limit` (0.152); `codex mcp-server` entry point removed (0.154) | 0.152–0.154 | None: HIX does not parse `[mcp_servers]`. The probe's `mcp` marker matches the `mcp` subcommand, still present (observed live at 0.154.0). |
| Session rollout compression (0.152/0.153); worktrees, queue, agents dashboard, export (0.148–0.154) | 0.148–0.154 | None: HIX does not read session rollout files (probe checks `~/.codex/sessions` presence only). New CLI capabilities are candidates for future probe markers, not parsing changes. |
| Bundled default model changed to GPT-6-Astra (#42874) | 0.153.4 | None: HIX assumes no model equivalence and never infers a default; Codex model selection always requires an explicit `--codex-model`. |
| Reasoning-effort enum gained `max`/`ultra` (0.149) | 0.149.0 | Additive: HIX passes effort values through as declared; no enum is hardcoded. |

## Explicit unknowns

1. 0.149.1 published no release notes; its content is unreviewed.
2. PR-level renames #37400 ("tool registry metadata setting") and #39830 ("history notes extension") do not name the affected keys. Moot for HIX today (config.toml is unparsed) but recorded in case HIX ever reads those keys.
3. Whether the 0.154 runtime still loads `~/.codex/skills` (the `codex:legacy` endpoint's location) is unverified; the endpoint's "legacy" designation already communicates deprecated status.

## Follow-up candidates (not required for this maintenance pass)

- A review/materialization note when a skill body contains TODO placeholders, since Codex 0.148+ rejects them at validation.
- Probe markers for `worktree` and `queue` surfaces once their help-text anchors are confirmed.
