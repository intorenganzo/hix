# Harness version maintenance

HIX does not need automatic upstream change detection.

For each HIX release, the repository records two separate facts for every supported participant:

1. **Known version** — the exact Claude Code or Codex version whose relevant native surfaces have been reviewed against HIX's current parser/review/materialization code.
2. **Tested version** — an exact participant version that was actually exercised with the HIX release and has recorded test evidence.

These are intentionally different. Reading current release notes or source does not make a version tested.

## Support file

The release matrix lives in:

```text
harnesses/support.json
```

Example shape:

```json
{
  "hixVersion": "0.1.0",
  "participants": {
    "claude": {
      "knownVersion": "2.1.229",
      "testedVersions": [
        {
          "version": "2.1.229",
          "testedAt": "2026-08-12",
          "observedAt": "2026-08-13T01:58:13.933Z",
          "evidence": ["docs/conformance/claude-2.1.229-codex-0.147.0.json"]
        }
      ]
    },
    "codex": {
      "knownVersion": "0.147.0",
      "testedVersions": [
        {
          "version": "0.147.0",
          "testedAt": "2026-08-12",
          "observedAt": "2026-08-13T01:58:13.933Z",
          "evidence": ["docs/conformance/claude-2.1.229-codex-0.147.0.json"]
        }
      ]
    }
  },
  "testedPairings": [
    {
      "id": "claude-2.1.229-to-codex-0.147.0",
      "source": { "participant": "claude", "version": "2.1.229" },
      "target": { "participant": "codex", "version": "0.147.0" },
      "testedAt": "2026-08-12",
      "observedAt": "2026-08-13T01:58:13.933Z",
      "evidence": ["docs/conformance/claude-2.1.229-codex-0.147.0.json"]
    }
  ]
}
```

`knownVersion` means HIX has deliberately checked the participant version as an input to maintenance. It is not a compatibility guarantee.

A `testedVersions` entry is a compatibility claim and therefore requires evidence.

A `testedPairings` entry is stronger: it records that a specific source participant/version and target participant/version were exercised together for HIX materialization/conformance.

## Before a HIX release

### 1. Choose exact participant versions

Record the versions that will be checked:

```sh
claude --version
codex --version
```

Do not publish an open-ended range unless that range has an explicit test policy. Prefer exact versions.

### 2. Review changes relevant to HIX

Compare the candidate participant version with the version last known by HIX. Only HIX-relevant surfaces need review, for example:

- skill locations and metadata;
- native agent locations and metadata;
- model and reasoning-effort declarations;
- invocation policy;
- context/delegation behavior;
- tool and authority configuration;
- skill-to-agent / agent-to-skill composition;
- materialization targets used by HIX.

If the version changes but none of these surfaces changed, update `knownVersion` after that review. If they changed, update HIX code and fixtures first.

### 3. Run repository checks

```sh
npm run check
```

This validates the support matrix and runs HIX's unit/integration tests.

### 4. Run live conformance on the exact participant version

A participant should only be added to `testedVersions` after HIX is exercised against that installed version.

The minimum useful checks are:

- discover/inspect native skills;
- discover/review native agents;
- compose at least one representative composed capability;
- verify declarations HIX claims to understand;
- verify generated `.hix` review output;
- when materialization is supported, exercise the relevant source or target path and verify the generated native files.

Record the commands, fixture hashes, outputs, or a short conformance report as evidence. Do not use a bare statement such as "tested manually" as the only evidence.

The repository probe performs the structural/materialization portion against its pinned exact versions:

```sh
npm run conformance:live
```

Its report states explicitly whether runtime execution was tested; structural conformance must not be presented as a runtime-behavior proof.

### 5. Test cross-harness pairings separately

Individual participant tests do not prove cross-harness behavior.

For a release that claims Claude Code -> Codex or Codex -> Claude materialization, record the exact pairing under `testedPairings` after exercising it:

```json
{
  "id": "claude-2.1.229-to-codex-0.147.0",
  "source": { "participant": "claude", "version": "2.1.229" },
  "target": { "participant": "codex", "version": "0.147.0" },
  "testedAt": "2026-08-12",
  "observedAt": "2026-08-13T01:58:13.933Z",
  "evidence": ["<conformance evidence>"],
  "releaseTag": "hix-v0.1.0-claude-v2.1.229-codex-v0.147.0"
}
```

Reverse direction can be a separate pairing if the behavior exercised is different.

## Tagging releases and commits

Tag the release commit with the exact participant versions that were conformance-tested.

Useful tag forms are:

```text
hix-v0.1.0-claude-v2.1.229
hix-v0.1.0-codex-v0.147.0
hix-v0.1.0-claude-v2.1.229-codex-v0.147.0
```

Multiple Git tags may point at the same release commit.

Do not create a participant-version tag merely because that version is listed as `knownVersion`. Tags that include a participant version should mean HIX was actually tested against that exact version.

## When a participant updates

There is no requirement to detect the update automatically.

When someone wants to use HIX with a new Claude Code or Codex version:

1. check `harnesses/support.json`;
2. if the exact version is already in `testedVersions`, use the recorded evidence/tag as the compatibility record;
3. if it is only `knownVersion`, HIX has reviewed the version but has not claimed conformance;
4. if it is absent, review the upstream delta relevant to HIX;
5. run the live conformance checks;
6. update the matrix and tag the HIX release/commit if the tests pass.

HIX should not infer support for a future Claude Code version because `2.1.229` passed, or for `0.148.0` because `0.147.0` passed. A later policy can deliberately add version ranges if there is evidence to justify them.

## Validation rules

`npm run check:harnesses` verifies that:

- the HIX version in the support matrix matches `package.json`;
- each participant has a known exact version and upstream source;
- every tested version has a date and evidence;
- duplicate tested versions are rejected;
- every tested pairing names known participants and contains evidence;
- version-bearing release tags contain the participant versions they claim.

This check validates the compatibility record. It does not substitute for running the live harness conformance tests.
