# Review skills and agents

Use `hix review` before changing, transferring, or materializing skills and agents. It is a portability/structure review, not a security audit or proof of cross-harness behavioral equivalence.

## Review everything discovered

Claude Code:

```sh
hix review claude:user
hix review claude:user --apply
```

Codex:

```sh
hix review codex:user
hix review codex:user --apply
```

Without `--skill`, HIX reviews all skills and all native agents discovered at the endpoint.

## Review selected skills

```sh
hix review claude:user \
  --skill review \
  --skill coding-standards
```

When HIX can relate a native agent to a selected skill composition, that agent is included in the review. Unrelated standalone agents are included only in a full review.

`hix evaluate` is an alias for `hix review`.

## Write the review package

Planning is read-only. `--apply` writes the package. Use `--replace` to replace a prior package. Replacement is allowed only when the destination is a regular directory containing a recognized `hix.review/v2` marker in `review.json`.

```sh
hix review codex:user --apply
hix review codex:user --apply --replace
```

Default layouts are participant-specific:

```text
.hix/
├── claude/
│   └── reviews/user/
│       ├── review.json
│       ├── review.md
│       ├── handoff.md
│       ├── skills/
│       │   ├── <skill>.json
│       │   └── <skill>.md
│       └── agents/
│           ├── <agent>.json
│           └── <agent>.md
└── codex/
    └── reviews/user/
        ├── review.json
        ├── review.md
        ├── handoff.md
        ├── skills/
        └── agents/
```

Project endpoints use `reviews/project/`. `--out` overrides the output directory.

## Outputs

`review.md` summarizes the run for a person.

`review.json` is the aggregate machine report using:

```text
hix.review/v2
```

Per-skill reports use:

```text
hix.skill-review/v1
```

Per-agent reports use:

```text
hix.agent-review/v1
```

`handoff.md` contains bounded enhancement tasks derived from error and warning findings. It can be given to Claude, Codex, or another participant together with the source artifacts.

## Status

Each reviewed skill or agent receives one of:

- `ready` — no error or warning finding;
- `needs-review` — warnings require review;
- `blocked` — one or more errors should be resolved first.

HIX does not assign a numeric quality score.

## What HIX checks

Current findings can include:

- conflicting execution declarations;
- unresolved skill-to-agent relationships;
- `context: fork` without an explicit agent choice;
- named agents that cannot be observed;
- model and effort declarations;
- missing agent descriptions;
- Claude agent permission/tool declarations;
- Codex agent sandbox declarations;
- Claude agent preloaded skills and missing preloads;
- runtime authority requirements;
- cross-harness behavior that is unmapped or needs a target-native realization.

The output includes evidence and a recommendation for each warning/error so another participant can act on the review without having to reconstruct why HIX raised it.

## Improve and review again

A typical loop is:

```text
hix review --apply
        ↓
review.md / handoff.md
        ↓
Claude, Codex, or human changes the capability
        ↓
hix review --apply --replace
        ↓
compare findings and hashes
        ↓
transfer or materialize
```

Review is advisory. Transfer and materialization still enforce their own blockers and explicit authority flags.
