import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectCompositions } from "../src/core.js";
import { applyMaterialization, planMaterialization } from "../src/materialize.js";

const EXPECTED = {
  claude: "2.1.233",
  codex: "0.147.0"
};

const observedAt = new Date().toISOString();
const versions = {
  claude: commandVersion("claude", ["--version"], /([0-9]+\.[0-9]+\.[0-9]+)/),
  codex: commandVersion("codex", ["--version"], /([0-9]+\.[0-9]+\.[0-9]+)/)
};
assert.deepEqual(versions, EXPECTED, "Installed harness versions differ from this conformance probe's exact-version contract.");

const work = await fs.mkdtemp(path.join(os.tmpdir(), "hix-live-conformance-"));
try {
  const claudeSource = path.join(work, ".claude", "skills");
  const codexBundle = path.join(work, "codex-bundle");
  const claudeBundle = path.join(work, "claude-bundle");
  const skillRoot = path.join(claudeSource, "review");
  const agentRoot = path.join(work, ".claude", "agents");
  await fs.mkdir(skillRoot, { recursive: true });
  await fs.mkdir(agentRoot, { recursive: true });
  await fs.writeFile(
    path.join(skillRoot, "SKILL.md"),
    "---\nname: review\ndescription: Review without editing.\neffort: high\ncontext: fork\nagent: Explore\n---\n\nReview carefully and return evidence.\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(agentRoot, "Explore.md"),
    "---\nname: Explore\ndescription: Read-only reviewer.\neffort: high\n---\n\nInspect the repository and cite evidence. Do not edit.\n",
    "utf8"
  );

  const common = { home: work };
  const codexPlan = await planMaterialization(
    "claude:user",
    "codex",
    { names: ["review"] },
    { ...common, out: codexBundle, codexAgent: "reviewer" }
  );
  assert.equal(codexPlan.unresolved.length, 0);
  const codexManifest = await applyMaterialization(codexPlan);
  assert.equal(codexManifest.roundTrip.sourceCapabilityInstructions, "Review carefully and return evidence.");
  assert.equal(codexManifest.roundTrip.sourceNativeAgentInstructions, "Inspect the repository and cite evidence. Do not edit.");
  assert.equal(codexManifest.runtimeRequirements[0].value, "read-only-no-escalation");
  assert.equal(codexManifest.runtimeRequirements[0].evidence.runtimeExecutionTested, false);

  const codexRoots = new Map([["codex:fixture", path.join(codexBundle, ".agents", "skills")]]);
  const observed = await inspectCompositions("codex:fixture", ["review"], { home: work, endpointRoots: codexRoots });
  assert(observed.compositions[0].members.some((item) => item.ref === "codex-agent:reviewer"));

  const claudePlan = await planMaterialization(
    "codex:fixture",
    "claude",
    { names: ["review"] },
    { home: work, out: claudeBundle, claudeAgent: "reviewer", endpointRoots: codexRoots }
  );
  assert.equal(claudePlan.unresolved.length, 0);
  const claudeManifest = await applyMaterialization(claudePlan);
  const recoveredSkill = await fs.readFile(path.join(claudeBundle, ".claude", "skills", "review", "SKILL.md"), "utf8");
  const recoveredAgent = await fs.readFile(path.join(claudeBundle, ".claude", "agents", "reviewer.md"), "utf8");
  assert.match(recoveredSkill, /Review carefully and return evidence\./);
  assert.match(recoveredAgent, /Inspect the repository and cite evidence\. Do not edit\./);
  assert.doesNotMatch(recoveredAgent, /Source capability instructions:/);

  console.log(JSON.stringify({
    schema: "hix.live-conformance/v1",
    observedAt,
    versions,
    pairing: "claude-2.1.233-to-codex-0.147.0",
    checks: [
      "installed-exact-versions",
      "claude-composed-capability-observed",
      "claude-to-codex-materialization",
      "codex-projection-composition-observed",
      "manifest-round-trip-payloads",
      "read-only-runtime-envelope-emitted",
      "codex-to-claude-round-trip"
    ],
    compositionHash: observed.compositions[0].compositionHash,
    manifestHashes: {
      codex: sha(JSON.stringify(codexManifest)),
      claude: sha(JSON.stringify(claudeManifest))
    },
    claims: { crossHarnessEquivalence: false, runtimeExecutionTested: false }
  }, null, 2));
} finally {
  await fs.rm(work, { recursive: true, force: true });
}

function commandVersion(command, args, pattern) {
  const output = execFileSync(command, args, { encoding: "utf8" });
  const match = pattern.exec(output);
  if (!match) throw new Error(`Could not parse ${command} version from ${JSON.stringify(output)}.`);
  return match[1];
}

function sha(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
