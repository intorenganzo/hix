import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectCompositions } from "../src/core.js";
import { planProjection as planCodexMaterialization, applyProjection as applyCodexMaterialization } from "../src/project.js";
import { planMaterialization, applyMaterialization } from "../src/materialize.js";

async function tempHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), "hix-claude-target-test-"));
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

test("materialize a composed Codex capability into Claude native skill and agent artifacts", async () => {
  const home = await tempHome();
  const source = path.join(home, "source");
  const codexOut = path.join(home, "codex-bundle");
  const claudeOut = path.join(home, "claude-bundle");
  const skill = `---\nname: review\ndescription: Review without editing.\nmodel: source-model\neffort: high\ncontext: fork\nagent: Explore\ndisable-model-invocation: true\n---\n\nReview carefully and return evidence.\n`;
  await writeSkill(source, "review", skill);

  const codexPlan = await planCodexMaterialization(
    "claude:source",
    "codex",
    { names: ["review"] },
    {
      home,
      out: codexOut,
      codexAgent: "reviewer",
      codexModel: "target-codex-model",
      endpointRoots: new Map([["claude:source", source]])
    }
  );
  assert.equal(codexPlan.unresolved.length, 0);
  await applyCodexMaterialization(codexPlan);

  const codexEndpointRoots = new Map([["codex:bundle", path.join(codexOut, ".agents", "skills")]]);
  const codexObserved = await inspectCompositions("codex:bundle", ["review"], { home, endpointRoots: codexEndpointRoots });
  const sourceCompositionHash = codexObserved.compositions[0].compositionHash;
  assert(codexObserved.compositions[0].members.some((item) => item.ref === "codex-agent:reviewer"));
  assert.equal(codexObserved.compositions[0].runtimeRequirements[0].value, "read-only-no-escalation");

  const claudePlan = await planMaterialization(
    "codex:bundle",
    "claude",
    { names: ["review"] },
    {
      home,
      out: claudeOut,
      claudeAgent: "reviewer",
      claudeModel: "opus",
      endpointRoots: codexEndpointRoots
    }
  );
  assert.equal(claudePlan.unresolved.length, 0);
  assert.equal(claudePlan.source.compositionHash, sourceCompositionHash);
  await applyMaterialization(claudePlan);

  const targetSkill = await fs.readFile(path.join(claudeOut, ".claude", "skills", "review", "SKILL.md"), "utf8");
  assert.match(targetSkill, /context: fork/);
  assert.match(targetSkill, /agent: reviewer/);
  assert.match(targetSkill, /disable-model-invocation: true/);
  assert.match(targetSkill, /Review carefully and return evidence\./);
  assert.doesNotMatch(targetSkill, /Codex custom agent/);
  assert.doesNotMatch(targetSkill, /target-codex-model/);

  const targetAgent = await fs.readFile(path.join(claudeOut, ".claude", "agents", "reviewer.md"), "utf8");
  assert.match(targetAgent, /name: reviewer/);
  assert.match(targetAgent, /model: opus/);
  assert.match(targetAgent, /effort: high/);
  assert.match(targetAgent, /permissionMode: plan/);
  assert.match(targetAgent, /tools: Read, Glob, Grep/);
  assert.match(targetAgent, /Execute the provided capability task/);
  assert.doesNotMatch(targetAgent, /generated Codex materialization/);
  assert.doesNotMatch(targetAgent, /Source capability instructions:/);

  const manifest = JSON.parse(await fs.readFile(path.join(claudeOut, "hix-projection.json"), "utf8"));
  assert.equal(manifest.target.participant, "claude");
  assert.equal(manifest.source.compositionHash, sourceCompositionHash);
  assert.equal(manifest.choices.claudeModel, "opus");
  assert(manifest.files.includes(".claude/skills/review/SKILL.md"));
  assert(manifest.files.includes(".claude/agents/reviewer.md"));
  assert.equal(manifest.runtimeRequirements[0].runtime, "claude");
  assert.equal(manifest.runtimeRequirements[0].configuration.agent.permissionMode, "plan");
  assert.equal(manifest.roundTrip.sourceCapabilityInstructions, "Review carefully and return evidence.");

  const claudeEndpointRoots = new Map([["claude:bundle", path.join(claudeOut, ".claude", "skills")]]);
  const claudeObserved = await inspectCompositions("claude:bundle", ["review"], { home, endpointRoots: claudeEndpointRoots });
  const targetComposition = claudeObserved.compositions[0];
  assert(targetComposition.members.some((item) => item.ref === "claude-agent:reviewer"));
  assert(targetComposition.declarations.some((item) => item.dimension === "model-selection" && item.value === "opus"));
  assert(targetComposition.declarations.some((item) => item.dimension === "reasoning-effort" && item.value === "high"));
  assert.equal(targetComposition.runtimeRequirements[0].runtime, "claude");
});

test("materialize a standalone Codex skill invocation policy directly into Claude skill frontmatter", async () => {
  const home = await tempHome();
  const source = path.join(home, "codex-skills");
  const out = path.join(home, "claude-bundle");
  await writeSkill(
    source,
    "manual-review",
    `---\nname: manual-review\ndescription: Run a manual review.\n---\n\nReview when explicitly invoked.\n`,
    { "agents/openai.yaml": "policy:\n  allow_implicit_invocation: false\n" }
  );

  const plan = await planMaterialization(
    "codex:source",
    "claude",
    { names: ["manual-review"] },
    {
      home,
      out,
      endpointRoots: new Map([["codex:source", source]])
    }
  );
  assert.equal(plan.unresolved.length, 0);
  assert.equal(plan.needsClaudeAgent, false);
  await applyMaterialization(plan);

  const targetSkill = await fs.readFile(path.join(out, ".claude", "skills", "manual-review", "SKILL.md"), "utf8");
  assert.match(targetSkill, /disable-model-invocation: true/);
  await assert.rejects(fs.stat(path.join(out, ".claude", "skills", "manual-review", "agents", "openai.yaml")));
});

test("Codex model selection requires an explicit Claude model choice", async () => {
  const home = await tempHome();
  const source = path.join(home, "source");
  const codexOut = path.join(home, "codex-bundle");
  await writeSkill(source, "review", `---\nname: review\ndescription: Review.\nmodel: source-model\ncontext: fork\nagent: Explore\n---\n\nReview.\n`);

  const codexPlan = await planCodexMaterialization(
    "claude:source",
    "codex",
    { names: ["review"] },
    {
      home,
      out: codexOut,
      codexAgent: "reviewer",
      codexModel: "target-codex-model",
      endpointRoots: new Map([["claude:source", source]])
    }
  );
  await applyCodexMaterialization(codexPlan);

  const plan = await planMaterialization(
    "codex:bundle",
    "claude",
    { names: ["review"] },
    {
      home,
      out: path.join(home, "claude-bundle"),
      claudeAgent: "reviewer",
      endpointRoots: new Map([["codex:bundle", path.join(codexOut, ".agents", "skills")]])
    }
  );
  assert(plan.unresolved.some((item) => item.dimension === "model-selection" && item.reason.includes("--claude-model")));
});
