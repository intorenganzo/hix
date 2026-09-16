import assert from "node:assert/strict";
import test from "node:test";
import { compareVersions, findReviewedRange, findTestedPairing, inspectHarnessSupport, readHarnessSupport } from "../src/support.js";

test("support matrix separates known from tested harness versions", async () => {
  const matrix = await readHarnessSupport();
  assert.equal(matrix.schema, "hix.harness-support/v1");

  for (const [participant, support] of Object.entries(matrix.participants)) {
    const result = await inspectHarnessSupport(participant, support.knownVersion);
    assert.equal(result.known, true);
    assert.equal(result.tested, support.testedVersions.some((item) => item.version === support.knownVersion));
  }
});

test("support query does not infer compatibility for an unrecorded version", async () => {
  const result = await inspectHarnessSupport("claude", "999.999.999");
  assert.equal(result.known, false);
  assert.equal(result.tested, false);
  assert.equal(result.reviewed, false);
});

test("a version inside a reviewed range is reviewed and known, never tested", async () => {
  const result = await inspectHarnessSupport("claude", "2.1.235");
  assert.equal(result.reviewed, true);
  assert.equal(result.known, true);
  assert.equal(result.tested, false);
  assert.equal(result.reviewedRange.from, "2.1.233");
  assert.equal(result.reviewedRange.to, "2.1.237");
  assert.ok(result.evidence.length, "a reviewed range answer carries its delta-review evidence");
});

test("reviewed ranges use numeric version order, not string order", () => {
  assert.equal(compareVersions("0.9.0", "0.10.0"), -1);
  assert.equal(compareVersions("2.1.233", "2.1.233"), 0);
  const range = { from: "0.147.0", to: "0.154.0" };
  assert.ok(findReviewedRange({ reviewedRanges: [range] }, "0.150.0"));
  assert.equal(findReviewedRange({ reviewedRanges: [range] }, "0.155.0"), undefined);
});

test("support query rejects unknown participants", async () => {
  await assert.rejects(() => inspectHarnessSupport("unknown-harness"), /Unknown participant/);
});

test("support matrix records exact timestamped participant and pairing evidence", async () => {
  const pairing = await findTestedPairing("claude", "codex");
  assert.equal(pairing.id, "claude-2.1.229-to-codex-0.147.0");
  assert.equal(pairing.source.version, "2.1.229");
  assert.equal(pairing.target.version, "0.147.0");
  assert.match(pairing.observedAt, /^2026-08-13T01:58:13\.933Z$/);
  assert.deepEqual(pairing.evidence, ["docs/conformance/claude-2.1.229-codex-0.147.0.json"]);
});
