import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { planReview, applyReview } from "../src/review.js";

async function tempHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), "hix-review-test-"));
}

async function writeSkill(root, name, body) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), body, "utf8");
}

test("Claude review discovers skills and native agents under participant-namespaced .hix output", async () => {
  const home = await tempHome();
  const skills = path.join(home, ".claude", "skills");
  await writeSkill(skills, "review", `---\nname: review\ndescription: Review deeply.\nmodel: opus\neffort: high\ncontext: fork\nagent: reviewer\n---\n\nReview.\n`);
  await writeSkill(skills, "coding-standards", `---\nname: coding-standards\ndescription: Coding standards.\n---\n\nUse the standards.\n`);
  await fs.mkdir(path.join(home, ".claude", "agents"), { recursive: true });
  await fs.writeFile(
    path.join(home, ".claude", "agents", "reviewer.md"),
    `---\nname: reviewer\ndescription: Reviewer.\nmodel: opus\neffort: high\nskills:\n  - coding-standards\n---\n\nReview carefully.\n`,
    "utf8"
  );

  const plan = await planReview("claude:user", {}, { home });
  assert.deepEqual(plan.report.selection.reviewed.skills.sort(), ["coding-standards", "review"]);
  assert.deepEqual(plan.report.selection.reviewed.agents, ["reviewer"]);
  assert.equal(plan.report.summary.skills, 2);
  assert.equal(plan.report.summary.agents, 1);
  const skillReview = plan.report.skills.find((item) => item.id === "review");
  assert(skillReview.preloadedSkills.some((item) => item.name === "coding-standards" && item.status === "discovered"));
  const agentReview = plan.report.agents.find((item) => item.id === "reviewer");
  assert(agentReview.preloadedSkills.some((item) => item.name === "coding-standards"));
  assert.equal(plan.root, path.join(home, ".hix", "claude", "reviews", "user"));

  await applyReview(plan);
  assert.equal(JSON.parse(await fs.readFile(path.join(plan.root, "review.json"), "utf8")).schema, "hix.review/v2");
  assert.match(await fs.readFile(path.join(plan.root, "handoff.md"), "utf8"), /skills and agents/i);
  await fs.stat(path.join(plan.root, "skills", "review.json"));
  await fs.stat(path.join(plan.root, "agents", "reviewer.md"));
});

test("selected Claude skill reviews only agents related to that composition", async () => {
  const home = await tempHome();
  const skills = path.join(home, ".claude", "skills");
  await writeSkill(skills, "review", `---\nname: review\ndescription: Review deeply.\ncontext: fork\nagent: reviewer\n---\n\nReview.\n`);
  await fs.mkdir(path.join(home, ".claude", "agents"), { recursive: true });
  await fs.writeFile(path.join(home, ".claude", "agents", "reviewer.md"), `---\nname: reviewer\ndescription: Reviewer.\nskills: [missing-standards]\n---\n\nReview.\n`, "utf8");
  await fs.writeFile(path.join(home, ".claude", "agents", "unrelated.md"), `---\nname: unrelated\ndescription: Other agent.\n---\n\nOther.\n`, "utf8");

  const plan = await planReview("claude:user", { names: ["review"] }, { home });
  assert.deepEqual(plan.report.selection.reviewed.agents, ["reviewer"]);
  assert.equal(plan.report.agents.length, 1);
  assert.equal(plan.report.agents[0].id, "reviewer");
  assert.equal(plan.report.agents[0].status, "blocked");
  assert(plan.report.agents[0].findings.some((item) => item.id === "missing-preloaded-skill"));
});

test("Codex review discovers both skills and .codex native agents, including standalone agents", async () => {
  const home = await tempHome();
  await writeSkill(path.join(home, ".agents", "skills"), "review", `---\nname: review\ndescription: Review implementation.\n---\n\nReview.\n`);
  await fs.mkdir(path.join(home, ".codex", "agents"), { recursive: true });
  await fs.writeFile(
    path.join(home, ".codex", "agents", "reviewer.toml"),
    `name = "reviewer"\ndescription = "Review agent"\nmodel = "target-model"\nmodel_reasoning_effort = "high"\nsandbox_mode = "read-only"\ndeveloper_instructions = "Review carefully."\n`,
    "utf8"
  );
  await fs.writeFile(
    path.join(home, ".codex", "agents", "builder.toml"),
    `name = "builder"\ndescription = "Build agent"\nmodel_reasoning_effort = "medium"\nsandbox_mode = "workspace-write"\ndeveloper_instructions = "Implement changes."\n`,
    "utf8"
  );

  const plan = await planReview("codex:user", {}, { home });
  assert.deepEqual(plan.report.selection.reviewed.skills, ["review"]);
  assert.deepEqual(plan.report.selection.reviewed.agents, ["builder", "reviewer"]);
  assert.equal(plan.report.summary.skills, 1);
  assert.equal(plan.report.summary.agents, 2);
  assert.equal(plan.root, path.join(home, ".hix", "codex", "reviews", "user"));
  const reviewer = plan.report.agents.find((item) => item.id === "reviewer");
  assert.equal(reviewer.effort, "high");
  assert(reviewer.findings.some((item) => item.id === "standalone-agent"));
  const builder = plan.report.agents.find((item) => item.id === "builder");
  assert(builder.findings.some((item) => item.id === "sandbox-mode"));

  await applyReview(plan);
  await fs.stat(path.join(plan.root, "skills", "review.md"));
  await fs.stat(path.join(plan.root, "agents", "reviewer.json"));
  await fs.stat(path.join(plan.root, "agents", "builder.md"));
});

test("review planning is read-only until apply and replace protects participant review output", async () => {
  const home = await tempHome();
  await writeSkill(path.join(home, ".agents", "skills"), "simple", `---\nname: simple\ndescription: Simple.\n---\n\nDo it.\n`);

  const plan = await planReview("codex:user", { names: ["simple"] }, { home });
  await assert.rejects(fs.stat(plan.root));
  await applyReview(plan);
  await assert.rejects(() => applyReview(plan), /--replace/);
  await applyReview(plan, { replace: true });
});

test("review replacement refuses unmarked directories and symlinks", async () => {
  const home = await tempHome();
  await writeSkill(path.join(home, ".agents", "skills"), "simple", `---\nname: simple\ndescription: Simple.\n---\n\nDo it.\n`);

  const unmarked = path.join(home, "unmarked-review");
  await fs.mkdir(unmarked, { recursive: true });
  await fs.writeFile(path.join(unmarked, "keep.txt"), "keep\n", "utf8");
  const unmarkedPlan = await planReview("codex:user", { names: ["simple"] }, { home, out: unmarked });
  await assert.rejects(() => applyReview(unmarkedPlan, { replace: true }), /not a marked HIX review directory/);
  assert.equal(await fs.readFile(path.join(unmarked, "keep.txt"), "utf8"), "keep\n");

  const real = path.join(home, "real-review");
  const linked = path.join(home, "linked-review");
  await fs.mkdir(real, { recursive: true });
  await fs.symlink(real, linked);
  const linkedPlan = await planReview("codex:user", { names: ["simple"] }, { home, out: linked });
  await assert.rejects(() => applyReview(linkedPlan, { replace: true }), /not a regular HIX review directory/);
});
