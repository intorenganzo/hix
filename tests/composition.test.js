import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectCompositions, planTransfer } from "../src/core.js";
import { applyMaterialization, planMaterialization } from "../src/materialize.js";
import { planProjection, applyProjection } from "../src/project.js";

async function tempHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), "hix-composition-test-"));
}

async function writeSkill(root, name, body) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), body, "utf8");
  return dir;
}

test("compose observes a Claude skill plus execution relationships as one capability", async () => {
  const home = await tempHome();
  const skill = `---\nname: review\ndescription: Review carefully.\nmodel: source-model\neffort: high\ncontext: fork\nagent: Explore\n---\n\nReview without editing.\n`;
  await writeSkill(path.join(home, ".claude", "skills"), "review", skill);

  const result = await inspectCompositions("claude:user", ["review"], { home });
  const composition = result.compositions[0];

  assert.equal(composition.kind, "observed-composed-capability");
  assert.equal(composition.id, "review");
  assert.match(composition.compositionHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(composition.members.map((item) => item.ref), ["skill:review"]);
  assert(composition.relations.some((item) =>
    item.kind === "executes-via" && item.to === "claude-agent:Explore" && item.status === "native-reference"
  ));
  assert(composition.declarations.some((item) => item.dimension === "model-selection" && item.value === "source-model"));
  assert(composition.declarations.some((item) => item.dimension === "context-isolation" && item.value === "fork"));
});

test("a Claude skill plus custom-agent file moves as one observed composition into Codex", async () => {
  const home = await tempHome();
  const project = path.join(home, "project");
  const out = path.join(home, "materialized");
  const skill = `---\nname: review\ndescription: Review carefully.\ncontext: fork\nagent: reviewer\n---\n\nDelegate the review and return findings.\n`;
  await writeSkill(path.join(home, ".claude", "skills"), "review", skill);
  await fs.mkdir(path.join(home, ".claude", "agents"), { recursive: true });
  await fs.writeFile(
    path.join(home, ".claude", "agents", "reviewer.md"),
    "---\nname: reviewer\neffort: high\n---\n\nReview deeply and preserve evidence.\n",
    "utf8"
  );

  const result = await inspectCompositions("claude:user", ["review"], { home, project });
  const composition = result.compositions[0];
  const nativeMember = composition.members.find((item) => item.ref === "claude-agent:reviewer");
  assert(nativeMember);
  assert.equal(nativeMember.path, ".claude/agents/reviewer.md");
  assert(composition.relations.some((item) =>
    item.to === "claude-agent:reviewer" && item.status === "observed-native-member"
  ));
  assert(composition.declarations.some((item) =>
    item.nativeFamily === "claude-agent" && item.dimension === "reasoning-effort" && item.value === "high"
  ));

  const transfer = await planTransfer(
    "claude:user",
    "claude:project",
    { all: false, names: ["review"] },
    { home, project }
  );
  assert(transfer.plans[0].blockers.some((item) => item.id === "composed-capability-requires-materialization"));

  const materialization = await planProjection(
    "claude:user",
    "codex",
    { names: ["review"] },
    { home, out, codexAgent: "reviewer" }
  );
  assert.equal(materialization.unresolved.length, 0);
  assert(materialization.resolutions.some((item) =>
    item.dimension === "composition-member" && item.authority === "observed-native-member"
  ));
  await applyProjection(materialization);

  const agent = await fs.readFile(path.join(out, ".codex", "agents", "reviewer.toml"), "utf8");
  assert.match(agent, /model_reasoning_effort = "high"/);
  assert.match(agent, /Review deeply and preserve evidence\./);
  assert.match(agent, /Delegate the review and return findings\./);
  const manifest = JSON.parse(await fs.readFile(path.join(out, "hix-projection.json"), "utf8"));
  assert.equal(manifest.roundTrip.sourceNativeAgentInstructions, "Review deeply and preserve evidence.");
  assert.equal(manifest.roundTrip.sourceCapabilityInstructions, "Delegate the review and return findings.");

  const claudeOut = path.join(home, "materialized-back");
  const reverse = await planMaterialization(
    "codex:bundle",
    "claude",
    { names: ["review"] },
    {
      home,
      out: claudeOut,
      claudeAgent: "reviewer",
      endpointRoots: new Map([["codex:bundle", path.join(out, ".agents", "skills")]])
    }
  );
  assert.equal(reverse.unresolved.length, 0);
  await applyMaterialization(reverse);
  const recoveredAgent = await fs.readFile(path.join(claudeOut, ".claude", "agents", "reviewer.md"), "utf8");
  assert.match(recoveredAgent, /Review deeply and preserve evidence\./);
  assert.doesNotMatch(recoveredAgent, /Source native-agent instructions:/);
});

test("a Codex materialization can be observed again as a multi-artifact composition", async () => {
  const home = await tempHome();
  const source = path.join(home, "source");
  const out = path.join(home, "bundle");
  const skill = `---\nname: review\ndescription: Review carefully.\nmodel: source-model\neffort: high\ncontext: fork\nagent: Explore\ndisable-model-invocation: true\n---\n\nReview without editing.\n`;
  await writeSkill(source, "review", skill);

  const plan = await planProjection(
    "claude:source",
    "codex",
    { names: ["review"] },
    {
      home,
      out,
      codexAgent: "reviewer",
      codexModel: "target-model",
      endpointRoots: new Map([["claude:source", source]])
    }
  );
  assert.equal(plan.unresolved.length, 0);
  await applyProjection(plan);

  const endpointRoots = new Map([["codex:bundle", path.join(out, ".agents", "skills")]]);
  const first = await inspectCompositions("codex:bundle", ["review"], { home, endpointRoots });
  const composition = first.compositions[0];

  assert(composition.members.some((item) => item.ref === "codex-agent:reviewer"));
  assert(composition.relations.some((item) =>
    item.kind === "executes-via" && item.to === "codex-agent:reviewer" && item.status === "recorded-projection"
  ));
  assert(composition.declarations.some((item) => item.dimension === "model-selection" && item.value === "target-model"));
  assert(composition.declarations.some((item) => item.dimension === "reasoning-effort" && item.value === "high"));
  assert(composition.declarations.some((item) => item.dimension === "sandbox-mode" && item.value === "read-only"));
  assert.equal(composition.runtimeRequirements.length, 1);
  assert(composition.evidence.some((item) => item.kind === "hix-projection-manifest"));

  const before = composition.compositionHash;
  await fs.appendFile(path.join(out, ".codex", "agents", "reviewer.toml"), "# changed\n", "utf8");
  const second = await inspectCompositions("codex:bundle", ["review"], { home, endpointRoots });
  assert.notEqual(second.compositions[0].compositionHash, before);
});
