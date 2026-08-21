import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { diffEndpoints, inspectEndpoint, inspectBehavior, planTransfer, applyTransfer } from "../src/core.js";
import { resolveEndpoint } from "../src/endpoints.js";

async function tempHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), "hix-test-"));
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

test("Codex user and legacy endpoints remain distinct", async () => {
  const home = await tempHome();
  const user = await resolveEndpoint("codex:user", { home });
  const legacy = await resolveEndpoint("codex:legacy", { home });
  assert.equal(user.root, path.join(home, ".agents", "skills"));
  assert.equal(legacy.root, path.join(home, ".codex", "skills"));
});

test("neutral filesystem endpoints require explicit roots and carry no repository convention", async () => {
  const home = await tempHome();
  await assert.rejects(() => resolveEndpoint("fs:catalog", { home }), /--endpoint-root/);

  const root = path.join(home, "catalog", "skills");
  const endpoint = await resolveEndpoint("fs:catalog", {
    home,
    endpointRoots: new Map([["fs:catalog", root]])
  });
  assert.equal(endpoint.root, root);
  assert.equal(endpoint.behavior, "neutral");
  assert.equal(endpoint.participant, "fs");
  assert.equal(endpoint.scope, "catalog");
});

test("inspect and diff preserve whole skill artifacts", async () => {
  const home = await tempHome();
  await writeSkill(path.join(home, ".claude", "skills"), "review", portable("review"), { "scripts/check.sh": "echo ok\n" });
  await writeSkill(path.join(home, ".agents", "skills"), "review", portable("review", "Different.\n"));

  const inspection = await inspectEndpoint("claude:user", { home });
  assert.equal(inspection.skills.length, 1);
  assert(inspection.skills[0].entries.some((entry) => entry.path === "scripts/check.sh"));

  const diff = await diffEndpoints("claude:user", "codex:user", { home });
  assert.equal(diff.differences[0].status, "changed");
  assert(diff.differences[0].changedFiles.includes("SKILL.md"));
  assert(diff.differences[0].changedFiles.includes("scripts/check.sh"));
  assert(diff.differences[0].diffs.some((item) => item.path === "SKILL.md" && item.patch.includes("Different.")));
});

test("transfer is explicitly selected, dry-run first, then hash-verified on apply", async () => {
  const home = await tempHome();
  await writeSkill(path.join(home, ".claude", "skills"), "review", portable("review"), { "references/notes.md": "details\n" });

  const plan = await planTransfer("claude:user", "codex:user", { all: false, names: ["review"] }, { home });
  assert.equal(plan.plans[0].action, "create");
  await assert.rejects(fs.stat(path.join(home, ".agents", "skills", "review")));

  const result = await applyTransfer(plan, { home });
  assert.equal(result[0].action, "create");

  const diff = await diffEndpoints("claude:user", "codex:user", { home });
  assert.equal(diff.differences[0].status, "equal");

  const history = await fs.readFile(path.join(home, ".harness-interchange", "history.jsonl"), "utf8");
  assert.match(history, /"source":"claude:user"/);
  assert.match(history, /"target":"codex:user"/);
});

test("participant-specific Claude frontmatter blocks Codex transfer until accepted", async () => {
  const home = await tempHome();
  const claudeSpecific = `---\nname: deploy\ndescription: Deploy.\ndisable-model-invocation: true\nmodel: source-model\n---\n\nDeploy carefully.\n`;
  await writeSkill(path.join(home, ".claude", "skills"), "deploy", claudeSpecific);

  const blocked = await planTransfer("claude:user", "codex:user", { all: true, names: [] }, { home });
  assert(blocked.plans[0].blockers.some((item) => item.id === "unaccepted-portability-risks"));
  const invocationRisk = blocked.plans[0].notices.find((notice) => notice.message.includes("disable-model-invocation"));
  assert(invocationRisk);
  assert.match(invocationRisk.message, /SKILL\.md:disable-model-invocation=true => implicit-invocation=false/);

  const partiallyAllowed = await planTransfer(
    "claude:user",
    "codex:user",
    { all: true, names: [] },
    { home, allowedRisks: [invocationRisk.id] }
  );
  const remaining = partiallyAllowed.plans[0].blockers.find((item) => item.id === "unaccepted-portability-risks");
  assert(remaining);
  assert(!remaining.evidence.includes(invocationRisk.id));

  const allowed = await planTransfer(
    "claude:user",
    "codex:user",
    { all: true, names: [] },
    { home, allowedRisks: blocked.plans[0].notices.filter((item) => item.severity === "risk").map((item) => item.id) }
  );
  assert.equal(allowed.plans[0].blockers.length, 0);
});

test("divergent target requires explicit replace authority", async () => {
  const home = await tempHome();
  await writeSkill(path.join(home, ".claude", "skills"), "review", portable("review", "source\n"));
  await writeSkill(path.join(home, ".agents", "skills"), "review", portable("review", "target\n"));

  const blocked = await planTransfer("claude:user", "codex:user", { all: true, names: [] }, { home });
  assert.equal(blocked.plans[0].action, "replace");
  assert(blocked.plans[0].blockers.some((item) => item.id === "destination-replacement-not-authorized"));
  assert(blocked.plans[0].diffs.some((item) => item.patch.includes("-target") && item.patch.includes("+source")));

  const allowed = await planTransfer(
    "claude:user",
    "codex:user",
    { all: true, names: [] },
    { home, replace: true }
  );
  await applyTransfer(allowed, { home });
  const diff = await diffEndpoints("claude:user", "codex:user", { home });
  assert.equal(diff.differences[0].status, "equal");
});

test("neutral filesystem endpoints are bidirectional without installer or catalog semantics", async () => {
  const home = await tempHome();
  const root = path.join(home, "catalog", "skills");
  const endpointRoots = new Map([["fs:catalog", root]]);
  await writeSkill(root, "portable-review", portable("portable-review"));

  const inspection = await inspectEndpoint("fs:catalog", { home, endpointRoots });
  assert.deepEqual(inspection.skills.map((skill) => skill.name), ["portable-review"]);

  const plan = await planTransfer(
    "fs:catalog",
    "claude:user",
    { all: false, names: ["portable-review"] },
    { home, endpointRoots }
  );
  await applyTransfer(plan, { home });

  const diff = await diffEndpoints("fs:catalog", "claude:user", { home, endpointRoots });
  assert.equal(diff.differences[0].status, "equal");
});

test("Claude execution behavior is first-class and retains native declarations", async () => {
  const home = await tempHome();
  const skill = `---\nname: deep-review\ndescription: Review deeply.\nmodel: source-model\neffort: high\ncontext: fork\nagent: Explore\ndisable-model-invocation: true\nuser-invocable: true\nallowed-tools: Read Grep\nhooks:\n  PreToolUse:\n    - matcher: Bash\npaths:\n  - src/**\nshell: bash\n---\n\nInspect first. !\`git status --short\`\n`;
  await writeSkill(path.join(home, ".claude", "skills"), "deep-review", skill);

  const result = await inspectBehavior("claude:user", ["deep-review"], { home });
  const declarations = new Map(result.skills[0].behavior.declarations.map((item) => [item.dimension, item]));

  assert.equal(declarations.get("model-selection").value, "source-model");
  assert.equal(declarations.get("reasoning-effort").value, "high");
  assert.equal(declarations.get("context-isolation").value, "fork");
  assert.equal(declarations.get("execution-agent").value, "Explore");
  assert.equal(declarations.get("implicit-invocation").value, false);
  assert.equal(declarations.get("preapproved-tools").value, "Read Grep");
  assert.equal(declarations.get("lifecycle-hooks").value, "configured");
  assert.deepEqual(declarations.get("activation-paths").value, ["src/**"]);
  assert.equal(declarations.get("skill-shell").value, "bash");
  assert.equal(declarations.get("dynamic-context").value, true);
});

test("Claude to Codex planning distinguishes direct, projected, and unmapped behavior", async () => {
  const home = await tempHome();
  const skill = `---\nname: deep-review\ndescription: Review deeply.\nmodel: source-model\neffort: high\ncontext: fork\nagent: Explore\ndisable-model-invocation: true\nuser-invocable: false\nallowed-tools: Read Grep\nhooks:\n  PreToolUse:\n    - matcher: Bash\n---\n\nReview.\n`;
  await writeSkill(path.join(home, ".claude", "skills"), "deep-review", skill);

  const plan = await planTransfer("claude:user", "codex:user", { all: true, names: [] }, { home });
  const mappings = new Map(plan.plans[0].behaviorMappings.map((item) => [item.dimension, item]));

  assert.equal(mappings.get("model-selection").status, "native-projection-required");
  assert.equal(mappings.get("model-selection").target, ".codex/agents/<agent>.toml:model");
  assert.equal(mappings.get("reasoning-effort").target, ".codex/agents/<agent>.toml:model_reasoning_effort");
  assert.equal(mappings.get("context-isolation").target, "Codex subagent workflow");
  assert.equal(mappings.get("implicit-invocation").status, "direct-native-projection");
  assert.equal(mappings.get("implicit-invocation").target, "agents/openai.yaml:policy.allow_implicit_invocation");
  assert.equal(mappings.get("preapproved-tools").status, "portable");
  assert.equal(mappings.get("lifecycle-hooks").status, "native-projection-required");
  assert.equal(mappings.get("user-invocation").status, "unmapped");
  assert(plan.plans[0].blockers.some((item) => item.id === "unaccepted-portability-risks"));
});

test("Codex invocation policy is recognized as behavior when stored in openai metadata", async () => {
  const home = await tempHome();
  await writeSkill(path.join(home, ".agents", "skills"), "manual-only", portable("manual-only"), {
    "agents/openai.yaml": "policy:\n  allow_implicit_invocation: false\n\ndependencies:\n  tools:\n    - type: mcp\n      value: docs\n"
  });

  const result = await inspectBehavior("codex:user", ["manual-only"], { home });
  const declarations = new Map(result.skills[0].behavior.declarations.map((item) => [item.dimension, item]));
  assert.equal(declarations.get("implicit-invocation").value, false);
  assert.equal(declarations.get("tool-dependencies").value, "declared");

  const plan = await planTransfer("codex:user", "claude:user", { all: true, names: [] }, { home });
  const mappings = new Map(plan.plans[0].behaviorMappings.map((item) => [item.dimension, item]));
  assert.equal(mappings.get("implicit-invocation").status, "direct-native-projection");
  assert.equal(mappings.get("implicit-invocation").target, "SKILL.md:disable-model-invocation");
  assert.equal(mappings.get("tool-dependencies").status, "unmapped");
});

test("neutral filesystem endpoints preserve native behavior declarations without pretending to execute them", async () => {
  const home = await tempHome();
  const root = path.join(home, "catalog", "skills");
  const endpointRoots = new Map([["fs:catalog", root]]);
  const skill = `---\nname: deep-review\ndescription: Review deeply.\nmodel: source-model\neffort: high\n---\n\nReview.\n`;
  await writeSkill(root, "deep-review", skill);

  const behavior = await inspectBehavior("fs:catalog", ["deep-review"], { home, endpointRoots });
  assert.equal(behavior.skills[0].behavior.declarations.find((item) => item.dimension === "model-selection").value, "source-model");

  const codexPlan = await planTransfer(
    "fs:catalog",
    "codex:user",
    { all: true, names: [] },
    { home, endpointRoots }
  );
  const model = codexPlan.plans[0].behaviorMappings.find((item) => item.dimension === "model-selection");
  assert.equal(model.status, "native-projection-required");
});

test("contradictory native execution declarations block transfer until resolved", async () => {
  const home = await tempHome();
  const root = path.join(home, "catalog", "skills");
  const endpointRoots = new Map([["fs:catalog", root]]);
  const skill = `---\nname: manual-policy\ndescription: Demonstrate policy conflict.\ndisable-model-invocation: true\n---\n\nDo the work.\n`;
  await writeSkill(root, "manual-policy", skill, {
    "agents/openai.yaml": "policy:\n  allow_implicit_invocation: true\n"
  });

  const behavior = await inspectBehavior("fs:catalog", ["manual-policy"], { home, endpointRoots });
  assert.equal(behavior.skills[0].behavior.conflicts.length, 1);
  assert.equal(behavior.skills[0].behavior.conflicts[0].dimension, "implicit-invocation");

  const plan = await planTransfer(
    "fs:catalog",
    "claude:user",
    { all: true, names: [] },
    { home, endpointRoots }
  );
  assert(plan.plans[0].blockers.some((item) => item.id === "conflicting-execution-behavior:implicit-invocation"));
});

test("importing native behavior into a neutral filesystem endpoint preserves declarations without lossy authorization", async () => {
  const home = await tempHome();
  const root = path.join(home, "catalog", "skills");
  const endpointRoots = new Map([["fs:catalog", root]]);
  await fs.mkdir(root, { recursive: true });
  const skill = `---\nname: deep-review\ndescription: Review deeply.\nmodel: source-model\neffort: high\n---\n\nReview.\n`;
  await writeSkill(path.join(home, ".claude", "skills"), "deep-review", skill);

  const plan = await planTransfer(
    "claude:user",
    "fs:catalog",
    { all: true, names: [] },
    { home, endpointRoots }
  );
  assert.equal(plan.plans[0].blockers.length, 0);
  assert(plan.plans[0].behaviorMappings.every((item) => item.status === "preserved-declaration"));
});

test("invalid declared skill names cannot traverse the destination", async () => {
  const home = await tempHome();
  const sourceRoot = path.join(home, ".claude", "skills");
  await writeSkill(sourceRoot, "safe-directory", `---\nname: ../../escape\ndescription: Invalid identity.\n---\n\nDo nothing.\n`);

  const inspection = await inspectEndpoint("claude:user", { home });
  assert.equal(inspection.skills[0].name, "safe-directory");
  assert(inspection.skills[0].validationErrors.some((item) => item.id === "agent-skills-invalid-name"));

  const plan = await planTransfer("claude:user", "codex:user", { all: true, names: [] }, { home });
  assert.equal(plan.plans[0].action, "blocked");
  assert(plan.plans[0].blockers.some((item) => item.id === "agent-skills-invalid-name"));
  await assert.rejects(() => applyTransfer(plan), /agent-skills-invalid-name/);
  await assert.rejects(fs.stat(path.join(home, "escape")));
});

test("skill symlinks cannot escape either the endpoint or skill root", async () => {
  const home = await tempHome();
  const endpointRoot = path.join(home, ".claude", "skills");
  const externalRoot = path.join(home, "external", "linked");
  await writeSkill(path.dirname(externalRoot), "linked", portable("linked"));
  await fs.mkdir(endpointRoot, { recursive: true });
  await fs.symlink(externalRoot, path.join(endpointRoot, "linked"));

  const rootLinked = await inspectEndpoint("claude:user", { home });
  assert(rootLinked.skills[0].validationErrors.some((item) => item.id === "skill-root-symlink-escapes-endpoint"));

  await fs.rm(path.join(endpointRoot, "linked"));
  const skillRoot = await writeSkill(endpointRoot, "contained", portable("contained"));
  const outsideFile = path.join(home, "outside.txt");
  await fs.writeFile(outsideFile, "outside\n", "utf8");
  await fs.symlink(outsideFile, path.join(skillRoot, "outside-link"));

  const internal = await inspectEndpoint("claude:user", { home });
  assert(internal.skills[0].validationErrors.some((item) => item.id === "skill-symlink-escapes-root"));
  const plan = await planTransfer("claude:user", "codex:user", { all: true, names: [] }, { home });
  assert(plan.plans[0].blockers.some((item) => item.id === "skill-symlink-escapes-root"));
});

test("Agent Skills schema validation enforces official field shapes", async () => {
  const home = await tempHome();
  await writeSkill(path.join(home, ".agents", "skills"), "schema-check", `---\nname: schema-check\ndescription: Check schema.\nallowed-tools: [Read, Grep]\nmetadata:\n  owner: 42\n---\n\nInspect.\n`);
  const inspection = await inspectEndpoint("codex:user", { home });
  const ids = inspection.skills[0].validationErrors.map((item) => item.id);
  assert(ids.includes("agent-skills-invalid-allowed-tools"));
  assert(ids.includes("agent-skills-invalid-metadata"));
});
