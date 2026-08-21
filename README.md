# hix

`hix` helps you inspect, review, compare, transfer, and materialize skills and agents across coding harnesses.

## Scope, stated up front

**Claude Code and Codex only.** Cursor and other harnesses are not supported. You can bind an arbitrary directory as a filesystem endpoint and inspect its bytes, but every execution dimension resolves to `unknown-target`, and `materialize` refuses any target outside `codex` and `claude`.

**Translation is not symmetric.** Claude to Codex resolves considerably more behavior dimensions than Codex to Claude. Moving a capability back the way it came will surface more unresolved dimensions requiring explicit operator choices. This reflects how much each harness documents about the other, not a judgement about either.

**HIX validates artifacts, not runtime behavior.** It reads what skills and agents declare and reports what cannot be carried. It does not prove a materialized capability behaves the same on the target. `hix probe` narrows this by observing what installed harnesses actually expose, but observation is not execution: nothing here runs a harness to confirm a control behaves as documented.

## Start with a portability/structure review

`hix review` is the primary entry point. It is a read-only portability/structure review of Agent Skills, native agents, their relationships, execution declarations, and runtime requirements. It does not claim to be a security audit or to prove behavioral equivalence across harnesses.

```sh
hix review claude:user
hix review codex:user
```

Add `--apply` only when you want a machine-readable review package and an agent-ready `handoff.md`.

## What do you need to do?

| Need | HIX feature | Example |
| --- | --- | --- |
| Review portability and structure before using or moving capabilities | `review` | `hix review codex:user` |
| Give review findings to Claude or Codex for improvement | `.hix/.../handoff.md` | Apply the review, make the bounded changes, then rerun it |
| Check which Claude/Codex versions this HIX release knows and has tested | `support` | `hix support claude 2.1.233` |
| See what the installed harnesses actually expose, and whether the support matrix has fallen behind them | `probe` | `hix probe --check` |
| See which skills are installed | `inspect` | `hix inspect claude:user` |
| See execution settings such as model, effort, invocation policy, or agent selection | `behavior` | `hix behavior claude:user --skill review` |
| See which skill and agent artifacts make up a capability | `compose` | `hix compose claude:user --skill review` |
| Compare skill sets between endpoints | `diff` | `hix diff claude:user codex:user` |
| Copy a portable skill package without rewriting it | `transfer` | `hix transfer fs:source claude:user --skill review` |
| Move a composed capability between Claude Code and Codex | `materialize` | `hix materialize claude:user codex --skill review --out ./out ...` |
| Use any directory of skills as an input | filesystem endpoints | `--endpoint-root fs:source=/path/to/skills` |
| Prevent accidental writes or replacement | dry-run + explicit authority flags | `--apply`, `--replace`, `--allow-risk <id>` |
| Use commands in CI | strict check mode | add `--check`; attention-required results exit 1 |
| See what cannot be carried safely | findings, blockers, resolutions, runtime requirements | emitted by `review`, `transfer`, and `materialize` |

## Install for local use

HIX requires Node.js 20+.

```sh
git clone https://github.com/intorenganzo/hix.git
cd hix
npm install
npm run check
npm link
```

After linking, use the `hix` command from any directory. Nothing is
published to npm; the linked checkout is the installation.

## Your first five minutes

Three read-only commands, in this order:

```sh
hix probe                # which harnesses this machine actually has,
                         # their versions, and whether HIX's support
                         # matrix has fallen behind them
hix inspect claude:user  # which skills are installed, as HIX sees them
hix review claude:user   # portability/structure findings for those
                         # skills and their related native agents
```

Use `codex:user` instead if you live in Codex. None of these write
anything; add `--apply` to `review` when you want the written review
package and an agent-ready `handoff.md`.

## Check harness version support

See the versions recorded by this HIX release:

```sh
hix support
```

Check one participant:

```sh
hix support claude
hix support codex
```

Check an exact version:

```sh
hix support claude 2.1.233
hix support codex 0.147.0
```

HIX reports **known** and **tested** separately. A known version has been reviewed as an input to HIX maintenance. A tested version has recorded conformance evidence for this HIX release. HIX does not infer support for an unrecorded newer version.

## Observe the installed harnesses

`hix support` reports what this release recorded. `hix probe` reports what is actually on this machine, and whether the two have diverged:

```sh
hix probe
hix probe codex
hix probe --check    # exit 1 when the matrix has fallen behind the install
```

The probe reads harness versions, published command and flag surfaces, and on-disk footprints. It never invokes a model, never executes work, and never writes.

Footprints answer a question the flag surface cannot. A capability can be documented and shipped while remaining default-off and unused; an absent footprint says it has never run here, which is not something `--help` can tell you.

The probe separates **absent** from **unverified**. A captured surface that lacks a flag is absent. A surface that could not be captured is unverified, never absent.

Drift is reported, never repaired. Adopting a new version into `harnesses/support.json` remains an explicit decision, made after running `npm run conformance:live` against that install.

## Review what you already have

Review all discovered Claude Code skills and agents:

```sh
hix review claude:user
hix review claude:user --apply
```

Review all discovered Codex skills and agents:

```sh
hix review codex:user
hix review codex:user --apply
```

Review selected skills only. HIX also includes native agents that it can relate to the selected skill compositions:

```sh
hix review claude:user \
  --skill deep-review \
  --skill coding-standards
```

A written review uses a participant-specific `.hix` layout:

```text
.hix/
├── claude/
│   └── reviews/user/
│       ├── review.json
│       ├── review.md
│       ├── handoff.md
│       ├── skills/
│       └── agents/
└── codex/
    └── reviews/user/
        ├── review.json
        ├── review.md
        ├── handoff.md
        ├── skills/
        └── agents/
```

`review.md` is the human summary. `review.json` is the machine-readable report. `handoff.md` turns blocking and warning findings into bounded improvement tasks that can be given to Claude, Codex, or another participant.

After making changes, rerun the review:

```sh
hix review claude:user --apply --replace
```

See [docs/review.md](docs/review.md) for the review schemas and output details.

HIX parses YAML and TOML with shared format adapters. Skills are validated against the [Agent Skills specification](https://agentskills.io/specification): required `name` and `description`, the official name grammar and parent-directory match, field length limits, string metadata values, and the experimental space-separated `allowed-tools` shape. Invalid skills remain inspectable and reviewable, but transfer and materialization block.

## Understand a capability before moving it

Inspect installed skill packages:

```sh
hix inspect claude:user
hix inspect codex:user
```

Inspect execution declarations:

```sh
hix behavior claude:user --skill review
hix behavior codex:user --skill review
```

Inspect a composed capability:

```sh
hix compose claude:user --skill review
hix compose codex:user --skill review
```

`compose` includes native agent artifacts when HIX has machine-readable evidence that they belong to the selected capability. The resulting composition hash changes when an observed member changes, even if `SKILL.md` did not.

Compare endpoints:

```sh
hix diff claude:user codex:user
```

## Copy a portable skill package

Use `transfer` when the whole thing being moved is the skill package itself.

```sh
hix transfer fs:source claude:user \
  --endpoint-root fs:source=/path/to/skills \
  --skill review
```

The command is a dry run until `--apply` is supplied:

```sh
hix transfer fs:source claude:user \
  --endpoint-root fs:source=/path/to/skills \
  --skill review \
  --apply
```

If the destination already contains different content, HIX prints a unified diff and requires `--replace`. If the source contains behavior that cannot be transferred losslessly, HIX assigns every risk a stable ID. Accept only the risks you reviewed:

```sh
hix transfer claude:user codex:user \
  --skill review \
  --allow-risk behavior-model-selection-native-projection-required
```

Repeat `--allow-risk <id>` for each accepted risk. There is no blanket lossy authorization.

For CI, add `--check` to read-only commands. Differences, review findings that need attention, invalid skills, unresolved materializations, or transfer blockers then produce exit code 1 while still printing machine-readable output with `--json` when requested.

If HIX observes external agent members or runtime requirements, `transfer` blocks rather than claiming that copying only the skill directory moved the whole capability. Use `materialize` instead.

## Move a composed capability

Use `materialize` when a capability is represented differently by the target harness.

Claude Code to Codex:

```sh
hix materialize claude:user codex \
  --skill review \
  --out ./hix-codex-review \
  --codex-agent review \
  --codex-model <target-model>
```

Codex to Claude Code:

```sh
hix materialize codex:user claude \
  --skill review \
  --out ./hix-claude-review \
  --claude-agent review \
  --claude-model <target-model>
```

Materialization is also a dry run until `--apply` is supplied. HIX reports:

- target-native files it plans to create;
- explicit operator choices that are still required;
- behavior it can map directly;
- behavior that needs a composed target realization;
- runtime requirements that must accompany the generated files;
- behavior for which no safe target realization is known.

Cross-vendor model identity is never guessed. When the source selects a model, choose the target model explicitly.

The two directions are not equally well supported. Claude to Codex resolves considerably more behavior dimensions than Codex to Claude, so a return trip will report more unresolved dimensions and require more explicit operator choices. Materializing a capability out and back does not reliably reproduce the original, and HIX does not claim it does.

`hix project` remains an alias for `hix materialize`.

## Built-in endpoints

| Endpoint | Skills | Native agents |
| --- | --- | --- |
| `claude:user` | `~/.claude/skills` | `~/.claude/agents` |
| `claude:project` | `<project>/.claude/skills` | `<project>/.claude/agents` |
| `codex:user` | `~/.agents/skills` | `~/.codex/agents` |
| `codex:project` | `<project>/.agents/skills` | `<project>/.codex/agents` |
| `codex:legacy` | `~/.codex/skills` | `~/.codex/agents` |

Bind another skills directory explicitly:

```sh
hix inspect fs:source \
  --endpoint-root fs:source=/path/to/skills
```

Harness-shaped override endpoints are also supported when you want HIX to inspect native adjacent files:

```sh
hix compose claude:bundle \
  --endpoint-root claude:bundle=/path/to/bundle/.claude/skills \
  --skill review
```

## Machine-readable outputs

HIX currently emits machine-readable artifacts including:

- `hix.harness-support/v1` for release/harness compatibility metadata;
- `hix.observed-composition/v1` from composition inspection;
- `hix.review/v2` aggregate harness reviews;
- `hix.skill-review/v1` per-skill reviews;
- `hix.agent-review/v1` per-agent reviews;
- `hix.projection-plan/v1` materialization plans;
- `hix.projection/v1` applied materialization manifests.

Use `--json` on read/planning commands when you want output on stdout instead of Markdown-oriented terminal output.

## Harness version maintenance

The release compatibility record lives at [`harnesses/support.json`](harnesses/support.json).

For each participant it records:

- the exact version HIX has most recently reviewed (`knownVersion`);
- exact versions that were actually conformance-tested (`testedVersions`);
- recorded source/target version pairs that were exercised together (`testedPairings`).

No automatic upstream monitoring is required. When Claude Code or Codex changes, review the relevant delta, test HIX against the exact version, record the evidence, and tag the release commit with the participant versions that passed.

`hix probe --check` (also `npm run check:drift`) reports when the installed harness has moved past the recorded matrix, so drift is detected rather than discovered later. It is a signal to run `npm run conformance:live` and record new evidence, not a substitute for doing so.

See [docs/harness-maintenance.md](docs/harness-maintenance.md) for the release checklist and tag convention. `npm run check` validates the support metadata as part of the normal test command.
