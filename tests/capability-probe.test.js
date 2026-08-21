import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  compareProbeToSupport,
  knownProbeParticipants,
  probeHarness,
  probeHarnesses,
  summarizeProbe
} from "../src/capability-probe.js";

// Surfaces are injected so the suite observes probe logic rather than whichever
// harness happens to be installed on the machine running the tests.
function fakeCapture(responses) {
  return (command, args) => responses[`${command} ${args.join(" ")}`];
}

const claudeCapture = fakeCapture({
  "claude --version": "2.1.233 (Claude Code)\n",
  "claude --help": "--json-schema --allowedTools --permission-mode --add-dir --agents --background --no-session-persistence --cloud",
  "claude agents --help": "--json"
});

async function tempHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), "hix-probe-"));
}

test("probe reports observed capability markers from the installed surface", async () => {
  const home = await tempHome();
  try {
    const probe = await probeHarness("claude", { home, captureSurface: claudeCapture });
    assert.equal(probe.installed, true);
    assert.equal(probe.version, "2.1.233");

    const summary = summarizeProbe(probe);
    assert.ok(summary.observed.includes("structured-output"));
    assert.ok(summary.observed.includes("permission-mode"));
    assert.equal(summary.unverified.length, 0);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("probe distinguishes an absent capability from an uncaptured surface", async () => {
  const home = await tempHome();
  try {
    const partial = fakeCapture({
      "claude --version": "2.1.233 (Claude Code)\n",
      "claude --help": "--permission-mode"
      // `claude agents --help` intentionally unavailable
    });
    const probe = await probeHarness("claude", { home, captureSurface: partial });
    const summary = summarizeProbe(probe);

    assert.ok(summary.absent.includes("structured-output"), "a captured surface without the flag is absent");
    assert.ok(summary.unverified.includes("agent-registry-json"), "an uncaptured surface is unverified, never absent");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("probe reports a documented capability that has never run here as an absent footprint", async () => {
  const home = await tempHome();
  try {
    const probe = await probeHarness("claude", { home, captureSurface: claudeCapture });
    const teams = probe.footprints.find((item) => item.id === "agent-teams-state");
    assert.equal(teams.present, false);
    assert.equal(teams.evidence, "absent");

    await fs.mkdir(path.join(home, ".claude", "tasks"), { recursive: true });
    const after = await probeHarness("claude", { home, captureSurface: claudeCapture });
    assert.equal(after.footprints.find((item) => item.id === "agent-teams-state").present, true);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("probe never claims runtime execution or model invocation", async () => {
  const home = await tempHome();
  try {
    const probe = await probeHarness("claude", { home, captureSurface: claudeCapture });
    assert.deepEqual(probe.claims, { runtimeExecutionTested: false, modelInvoked: false });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("probe treats a missing harness as an observation rather than a failure", async () => {
  const home = await tempHome();
  try {
    const probe = await probeHarness("codex", { home, captureSurface: () => undefined });
    assert.equal(probe.installed, false);
    assert.equal(probe.versionError, "command-unavailable");
    assert.ok(probe.markers.every((marker) => marker.evidence === "unavailable"));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("probe reports drift when the installed version is ahead of the support matrix", async () => {
  const home = await tempHome();
  try {
    const probe = await probeHarness("claude", { home, captureSurface: claudeCapture });
    const findings = compareProbeToSupport(probe, {
      participants: {
        claude: { knownVersion: "2.1.229", testedVersions: [{ version: "2.1.229" }] }
      }
    });

    const ids = findings.map((finding) => finding.id);
    assert.ok(ids.includes("probe-known-version-drift"));
    assert.ok(ids.includes("probe-installed-version-untested"));
    assert.ok(findings.every((finding) => typeof finding.message === "string" && finding.message.length));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("probe reports no drift when the support matrix already records the installed version", async () => {
  const home = await tempHome();
  try {
    const probe = await probeHarness("claude", { home, captureSurface: claudeCapture });
    const findings = compareProbeToSupport(probe, {
      participants: {
        claude: { knownVersion: "2.1.233", testedVersions: [{ version: "2.1.233" }] }
      }
    });
    assert.deepEqual(findings.filter((finding) => finding.severity === "attention"), []);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("probe reports an installed participant the support matrix does not record", async () => {
  const home = await tempHome();
  try {
    const probe = await probeHarness("claude", { home, captureSurface: claudeCapture });
    const findings = compareProbeToSupport(probe, { participants: {} });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].id, "probe-participant-unrecorded");
    assert.equal(findings[0].severity, "attention");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("probe rejects an unknown participant instead of inventing a target", async () => {
  await assert.rejects(() => probeHarness("cursor"), /Unknown probe participant cursor/);
  assert.deepEqual(knownProbeParticipants(), ["claude", "codex"]);
});

test("probing every known participant returns one record each", async () => {
  const home = await tempHome();
  try {
    const result = await probeHarnesses([], { home, captureSurface: () => undefined });
    assert.equal(result.probes.length, knownProbeParticipants().length);
    assert.equal(result.schema, "hix.capability-probe/v1");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
