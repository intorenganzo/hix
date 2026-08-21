import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { planProjection, applyProjection } from "../src/project.js";

async function tempHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), "hix-project-test-"));
}

async function writeSkill(root, name, body, extras = {}) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), body, "utf8");
  for (const [file, content] of Object.entries(extras)) {
    const target = path.join(dir, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
  return dir;
}

const portable = (name, instruction = "Do the thing.") => `---\nname: ${name}\ndescription: Use for ${name}.\n---\n\n${instruction}\n`;

const readOnlyRequirement = {
  dimension: "authority-enforcement",
  value: "read-only-no-escalation",
  status: "conformance-tested-structure",
  runtime: "codex",
  configuration: {
    child: { sandboxMode: "read-only" },
    parent: { sandboxMode: "read-only", approvalPolicy: "never" }
  },
  launch: {
    command: "codex",
    args: ["--sandbox", "read-only", "--ask-for-approval", "never"]
  },
  evidence: {
    kind: "runtime-conformance",
    assertion: "read-only-runtime-envelope-emitted",
    pairingId: "claude-2.1.229-to-codex-0.147.0",
    observedAt: "2026-08-13T01:58:13.933Z",
    participantVersions: {
      source: { participant: "claude", version: "2.1.229" },
      target: { participant: "codex", version: "0.147.0" }
    },
    scope: "structural observation, bidirectional materialization, and manifest-backed instruction round trip",
    refs: ["docs/conformance/claude-2.1.229-codex-0.147.0.json"],
    runtimeExecutionTested: false
  },
  reason: "No-write delegation requires both a read-only child default and a parent runtime that cannot escalate write authority."
};

test("Codex materialization dry-run surfaces model and agent choices without writing", async () => {
  const home = await tempHome();
  const source = path.join(home, "source");
  const out = path.join(home, "projection");
  const skill = `---\nname: deep-review\ndescription: Review deeply with evidence.\nmodel: source-model\neffort: high\ncontext: fork\nagent: Explore\ndisable-model-invocation: true\nallowed-tools: Read Grep\n---\n\nReview carefully. Do not modify anything.\n`;
  await writeSkill(source, "deep-review", skill);

  const plan = await planProjection(
    "claude:experiment",
    "codex",
    { names: ["deep-review"] },
    { home, out, endpointRoots: new Map([["claude:experiment", source]]) }
  );

  assert(plan.unresolved.some((item) => item.dimension === "custom-agent"));
  assert(plan.unresolved.some((item) => item.dimension === "model-selection"));
  assert.match(plan.source.compositionHash, /^[a-f0-9]{64}$/);
  await assert.rejects(fs.stat(out));
});

test("Codex materialization records source composition identity without embedding machine-specific paths", async () => {
  const home = await tempHome();
  const source = path.join(home, "source");
  const out = path.join(home, "projection");
  const skill = `---\nname: deep-review\ndescription: Review deeply with evidence.\nmodel: source-model\neffort: high\ncontext: fork\nagent: Explore\ndisable-model-invocation: true\nallowed-tools: Read Grep\n---\n\nReview carefully. Do not modify anything.\n`;
  await writeSkill(source, "deep-review", skill, { "references/checklist.md": "Check behavior.\n" });

  const plan = await planProjection(
    "claude:experiment",
    "codex",
    { names: ["deep-review"] },
    {
      home,
      out,
      codexAgent: "deep-review",
      codexModel: "target-model",
      endpointRoots: new Map([["claude:experiment", source]])
    }
  );
  assert.equal(plan.unresolved.length, 0);
  await applyProjection(plan);

  const projectedSkill = await fs.readFile(path.join(out, ".agents", "skills", "deep-review", "SKILL.md"), "utf8");
  assert.doesNotMatch(projectedSkill, /allowed-tools:/);
  assert.doesNotMatch(projectedSkill, /model: source-model/);
  assert.match(projectedSkill, /delegate the substantive work/i);

  const metadata = await fs.readFile(path.join(out, ".agents", "skills", "deep-review", "agents", "openai.yaml"), "utf8");
  assert.match(metadata, /allow_implicit_invocation: false/);

  const agent = await fs.readFile(path.join(out, ".codex", "agents", "deep-review.toml"), "utf8");
  assert.match(agent, /model = "target-model"/);
  assert.match(agent, /model_reasoning_effort = "high"/);
  assert.match(agent, /sandbox_mode = "read-only"/);
  assert.match(agent, /Review carefully\. Do not modify anything\./);
  assert.doesNotMatch(agent, /model: source-model/);

  assert.equal(await fs.readFile(path.join(out, ".agents", "skills", "deep-review", "references", "checklist.md"), "utf8"), "Check behavior.\n");
  const manifest = JSON.parse(await fs.readFile(path.join(out, "hix-projection.json"), "utf8"));
  assert.equal(manifest.schema, "hix.projection/v1");
  assert.equal(manifest.choices.codexModel, "target-model");
  assert.deepEqual(manifest.source, {
    endpoint: "claude:experiment",
    participant: "claude",
    capability: "deep-review",
    skill: "deep-review",
    hash: plan.source.hash,
    compositionHash: plan.source.compositionHash
  });
  assert.deepEqual(manifest.target, { participant: "codex" });
  assert.equal(manifest.roundTrip.schema, "hix.round-trip/v1");
  assert.equal(manifest.roundTrip.sourceCapabilityInstructions, "Review carefully. Do not modify anything.");
  assert(manifest.files.every((file) => !path.isAbsolute(file)));
  assert(!JSON.stringify(manifest).includes(home));
  assert(manifest.resolutions.some((item) => item.dimension === "model-selection" && item.authority === "explicit-operator-choice"));
  assert(manifest.resolutions.some((item) => item.dimension === "sandbox-default" && item.target.includes("sandbox_mode=read-only")));
  assert.deepEqual(manifest.runtimeRequirements, [readOnlyRequirement]);
  assert(manifest.resolutions.some((item) => item.dimension === "preapproved-tools" && item.authority === "safe-narrowing"));
  assert.deepEqual(manifest.claims, { crossHarnessEquivalence: false });
});

test("Codex materialization records the machine-readable read-only runtime envelope for Claude Explore", async () => {
  const home = await tempHome();
  const source = path.join(home, "source");
  const out = path.join(home, "projection");
  const skill = `---\nname: deep-review\ndescription: Review only.\nmodel: source-model\neffort: high\ncontext: fork\nagent: Explore\n---\n\nDo not modify anything.\n`;
  await writeSkill(source, "deep-review", skill);

  const plan = await planProjection(
    "claude:experiment",
    "codex",
    { names: ["deep-review"] },
    {
      home,
      out,
      codexAgent: "deep-review",
      codexModel: "target-model",
      endpointRoots: new Map([["claude:experiment", source]])
    }
  );

  assert.equal(plan.unresolved.length, 0);
  assert.deepEqual(plan.runtimeRequirements, [readOnlyRequirement]);
  await applyProjection(plan);
  const agent = await fs.readFile(path.join(out, ".codex", "agents", "deep-review.toml"), "utf8");
  assert.match(agent, /sandbox_mode = "read-only"/);
});

test("Codex materialization refuses to overwrite an existing output without replace authority", async () => {
  const home = await tempHome();
  const source = path.join(home, "source");
  const out = path.join(home, "projection");
  await writeSkill(source, "simple", portable("simple"));
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, "keep.txt"), "keep\n");

  const plan = await planProjection(
    "fs:source",
    "codex",
    { names: ["simple"] },
    { home, out, endpointRoots: new Map([["fs:source", source]]) }
  );
  await assert.rejects(() => applyProjection(plan), /already exists/);
  assert.equal(await fs.readFile(path.join(out, "keep.txt"), "utf8"), "keep\n");
});

test("Codex materialization blocks unsupported lifecycle behavior rather than widening scope", async () => {
  const home = await tempHome();
  const source = path.join(home, "source");
  const out = path.join(home, "projection");
  const skill = `---\nname: hooked\ndescription: Hooked skill.\nhooks:\n  PreToolUse:\n    - matcher: Bash\n---\n\nDo work.\n`;
  await writeSkill(source, "hooked", skill);
  const plan = await planProjection(
    "claude:experiment",
    "codex",
    { names: ["hooked"] },
    { home, out, endpointRoots: new Map([["claude:experiment", source]]) }
  );
  assert(plan.unresolved.some((item) => item.dimension === "lifecycle-hooks"));
  await assert.rejects(() => applyProjection(plan), /Materialization is unresolved/);
});

test("Codex materialization replacement requires a hix marker even with replace authority", async () => {
  const home = await tempHome();
  const source = path.join(home, "source");
  const out = path.join(home, "projection");
  await writeSkill(source, "simple", portable("simple"));
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, "keep.txt"), "keep\n");
  const plan = await planProjection(
    "fs:source",
    "codex",
    { names: ["simple"] },
    { home, out, endpointRoots: new Map([["fs:source", source]]) }
  );
  await assert.rejects(() => applyProjection(plan, { replace: true }), /not a hix materialization/);
  assert.equal(await fs.readFile(path.join(out, "keep.txt"), "utf8"), "keep\n");
});

test("Codex materialization rejects unsafe custom-agent names", async () => {
  const home = await tempHome();
  const source = path.join(home, "source");
  await writeSkill(source, "deep-review", `---\nname: deep-review\ndescription: Review.\nmodel: source-model\n---\n\nReview.\n`);
  await assert.rejects(
    () => planProjection(
      "fs:source",
      "codex",
      { names: ["deep-review"] },
      {
        home,
        out: path.join(home, "projection"),
        codexAgent: "../escape",
        codexModel: "target-model",
        endpointRoots: new Map([["fs:source", source]])
      }
    ),
    /--codex-agent/
  );
});
