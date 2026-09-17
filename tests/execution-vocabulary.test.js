import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { KNOWN_EFFORTS, CLAUDE_EFFORTS, CODEX_EFFORTS } from "../src/execution-vocabulary.js";
import { planMaterialization } from "../src/materialize.js";
import { planProjection, applyProjection } from "../src/project.js";
import { planReview } from "../src/review.js";

async function tempHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), "hix-vocabulary-test-"));
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

test("ultra is known cross-harness vocabulary, not a structurally unknown value", () => {
  assert(KNOWN_EFFORTS.has("ultra"));
  assert(CODEX_EFFORTS.has("ultra"));
  assert(!CLAUDE_EFFORTS.has("ultra"));
  for (const value of CLAUDE_EFFORTS) assert(KNOWN_EFFORTS.has(value));
  for (const value of CODEX_EFFORTS) assert(KNOWN_EFFORTS.has(value));
});

test("Codex materialization accepts ultra as a native reasoning effort", async () => {
  const home = await tempHome();
  const source = path.join(home, "source");
  await writeSkill(source, "review", `---\nname: review\ndescription: Review.\neffort: ultra\n---\n\nReview carefully.\n`);

  const plan = await planProjection(
    "claude:source",
    "codex",
    { names: ["review"] },
    { home, out: path.join(home, "bundle"), codexAgent: "reviewer", endpointRoots: new Map([["claude:source", source]]) }
  );
  assert.equal(plan.unresolved.length, 0);
  const resolution = plan.resolutions.find((item) => item.dimension === "reasoning-effort");
  assert(resolution);
  assert.match(resolution.target, /model_reasoning_effort=ultra/);
});

test("Claude materialization treats ultra as unresolved until the operator chooses an effort", async () => {
  const home = await tempHome();
  const source = path.join(home, "source");
  const bundle = path.join(home, "bundle");
  await writeSkill(source, "review", `---\nname: review\ndescription: Review.\neffort: ultra\n---\n\nReview carefully.\n`);

  const toCodex = await planProjection(
    "claude:source",
    "codex",
    { names: ["review"] },
    { home, out: bundle, codexAgent: "reviewer", endpointRoots: new Map([["claude:source", source]]) }
  );
  assert.equal(toCodex.unresolved.length, 0);
  await applyProjection(toCodex);

  const endpointRoots = new Map([["codex:bundle", path.join(bundle, ".agents", "skills")]]);
  const blocked = await planMaterialization(
    "codex:bundle",
    "claude",
    { names: ["review"] },
    { home, out: path.join(home, "claude-blocked"), claudeAgent: "reviewer", endpointRoots }
  );
  assert(blocked.unresolved.some((item) => item.dimension === "reasoning-effort" && item.reason.includes("--claude-effort")));

  const resolved = await planMaterialization(
    "codex:bundle",
    "claude",
    { names: ["review"] },
    { home, out: path.join(home, "claude-resolved"), claudeAgent: "reviewer", claudeEffort: "high", endpointRoots }
  );
  assert(!resolved.unresolved.some((item) => item.dimension === "reasoning-effort"));
  const resolution = resolved.resolutions.find((item) => item.dimension === "reasoning-effort");
  assert.equal(resolution.authority, "explicit-operator-choice");
  assert.equal(resolved.targetEffort, "high");
});

test("ultra declared by a Codex-native agent is also unresolved for the Claude target", async () => {
  const home = await tempHome();
  const bundle = path.join(home, "bundle");
  const skills = path.join(bundle, ".agents", "skills");
  await writeSkill(skills, "review", `---\nname: review\ndescription: Review.\nagent: reviewer\n---\n\nReview carefully.\n`);
  await fs.mkdir(path.join(bundle, ".codex", "agents"), { recursive: true });
  await fs.writeFile(
    path.join(bundle, ".codex", "agents", "reviewer.toml"),
    `name = "reviewer"\ndescription = "Review agent"\nmodel_reasoning_effort = "ultra"\ndeveloper_instructions = "Review carefully."\n`,
    "utf8"
  );

  const endpointRoots = new Map([["codex:bundle", skills]]);
  const blocked = await planMaterialization(
    "codex:bundle",
    "claude",
    { names: ["review"] },
    { home, out: path.join(home, "claude-blocked"), claudeAgent: "reviewer", endpointRoots }
  );
  assert(blocked.unresolved.some((item) => item.dimension === "reasoning-effort" && item.reason.includes("--claude-effort")));

  const resolved = await planMaterialization(
    "codex:bundle",
    "claude",
    { names: ["review"] },
    { home, out: path.join(home, "claude-resolved"), claudeAgent: "reviewer", claudeEffort: "high", endpointRoots }
  );
  assert.equal(resolved.unresolved.length, 0);
  assert.equal(resolved.targetEffort, "high");
});

test("review warns on a truly unknown effort value and accepts known ones", async () => {
  const home = await tempHome();
  const skills = path.join(home, ".claude", "skills");
  await writeSkill(skills, "odd-effort", `---\nname: odd-effort\ndescription: Odd.\neffort: extreme\n---\n\nWork.\n`);
  await writeSkill(skills, "ultra-effort", `---\nname: ultra-effort\ndescription: Ultra.\neffort: ultra\n---\n\nWork.\n`);

  const plan = await planReview("claude:user", {}, { home });
  const odd = plan.report.skills.find((item) => item.id === "odd-effort");
  assert(odd.findings.some((item) => item.id === "unknown-effort-level"));
  const ultra = plan.report.skills.find((item) => item.id === "ultra-effort");
  assert(!ultra.findings.some((item) => item.id === "unknown-effort-level"));
});

test("conflicting declarations force refusal before the planner's last-wins declaration map can be applied", async () => {
  const home = await tempHome();
  const source = path.join(home, "source");
  await writeSkill(
    source,
    "manual-policy",
    `---\nname: manual-policy\ndescription: Demonstrate policy conflict.\ndisable-model-invocation: true\n---\n\nDo the work.\n`,
    { "agents/openai.yaml": "policy:\n  allow_implicit_invocation: true\n" }
  );

  const plan = await planProjection(
    "claude:source",
    "codex",
    { names: ["manual-policy"] },
    { home, out: path.join(home, "bundle"), endpointRoots: new Map([["claude:source", source]]) }
  );
  assert(plan.unresolved.some((item) => item.dimension === "implicit-invocation" && /contradictory/.test(item.reason)));
  await assert.rejects(() => applyProjection(plan), /Materialization is unresolved/);
});
