# Known divergences

hix's Agent Skills frontmatter validation is deliberately stricter than other
validators in some places. This document records the intentional divergences
so a future contributor does not "fix" them without first re-reading the
rationale below. Each item names the enforcing code and its regression test.

## ASCII-only skill names (intentional)

hix enforces skill names against `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` with a 64
character maximum, and additionally requires the name to equal its parent
directory name (`src/frontmatter.js`).

The reference validator for the Agent Skills specification accepts Unicode
alphanumerics after NFKC normalization, so a name such as `café-tools` can
pass there while hix rejects it.

hix keeps the ASCII-strict reading deliberately. Skill names are used as
filesystem path segments and as cross-harness identifiers; the stricter
grammar avoids normalization ambiguity across platforms and harnesses (for
example, a composed and a decomposed Unicode form of the same visible name
would otherwise be treated as equal on some filesystems and distinct on
others). This divergence is regression-tested in `tests/frontmatter.test.js`.

## Stricter metadata and compatibility validation (intentional)

hix requires `metadata` values to be strings, and `compatibility` to be a
1-500 character string, following the specification prose even in places
where reference tooling checks less. A `metadata` map with a non-string
value, or an empty `compatibility` string, is rejected by hix
(`agent-skills-invalid-metadata`, `agent-skills-invalid-compatibility`)
even though some other validators do not enforce these constraints.

## Claude-specific hygiene surfaced as warnings, not spec errors

Some harness packaging validators reject `<` or `>` characters in a skill's
`description`. The Agent Skills specification does not require this. hix
review reports this as a warning-severity portability finding
(`claude-description-angle-brackets`) rather than a spec-level error, so a
skill using these characters remains spec-valid under hix while still being
flagged for portability toward harnesses that reject them.

## Why this file exists

These divergences are the result of deliberate design decisions, not gaps.
Bringing hix's behavior into exact alignment with another validator on any
of the points above would remove intentional safety margin (name grammar) or
weaken enforcement of the specification's own prose (metadata,
compatibility). If a divergence listed here turns out to be wrong, update
this document and the corresponding test in the same change, and explain
why the stricter behavior no longer holds.
