import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { analyzeBehaviorTransfer } from "./behavior.js";
import { inspectCompositions, inspectEndpoint } from "./core.js";
import { markdownBody, parseToml, stringList } from "./formats.js";
import { inspectSkillFrontmatter } from "./frontmatter.js";

const KNOWN_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);

export async function planReview(spec, selection = {}, options = {}) {
  const inspection = await inspectEndpoint(spec, options);
  const discoveredSkills = inspection.skills.map((skill) => skill.name);
  const reviewedSkills = selectNames(discoveredSkills, selection);
  const observed = await inspectCompositions(spec, reviewedSkills, options);
  const bySkill = new Map(inspection.skills.map((skill) => [skill.name, skill]));
  const skillReviews = observed.compositions.map((composition) => reviewSkill(composition, bySkill, observed.endpoint));

  const nativeAgents = await discoverNativeAgents(observed.endpoint);
  const referencedAgents = new Set(observed.compositions.flatMap((composition) =>
    composition.relations.filter((relation) => relation.kind === "executes-via").map((relation) => relation.to)
  ));
  const reviewedAgents = selection.all || !(selection.names ?? []).length
    ? nativeAgents
    : nativeAgents.filter((agent) => referencedAgents.has(agent.ref));
  const agentReviews = reviewedAgents.map((agent) => reviewAgent(agent, bySkill, referencedAgents));
  const subjects = [...skillReviews, ...agentReviews];
  const root = path.resolve(options.out ?? defaultReviewRoot(observed.endpoint, options));

  const report = {
    schema: "hix.review/v2",
    endpoint: {
      spec: observed.endpoint.spec,
      participant: observed.endpoint.participant,
      scope: observed.endpoint.scope,
      behavior: observed.endpoint.behavior
    },
    selection: {
      requestedSkills: selection.names ?? [],
      all: selection.all ?? false,
      discovered: { skills: discoveredSkills, agents: nativeAgents.map((agent) => agent.id) },
      reviewed: { skills: reviewedSkills, agents: reviewedAgents.map((agent) => agent.id) }
    },
    summary: summarize(subjects),
    skills: skillReviews,
    agents: agentReviews,
    capabilities: subjects,
    handoff: buildHandoff(subjects, observed.endpoint)
  };

  return { endpoint: observed.endpoint, root, report, files: plannedFiles(root, skillReviews, agentReviews) };
}

export async function applyReview(plan, options = {}) {
  await prepareOutput(plan.root, options.replace);
  await fs.mkdir(path.join(plan.root, "skills"), { recursive: true });
  await fs.mkdir(path.join(plan.root, "agents"), { recursive: true });
  await fs.writeFile(path.join(plan.root, "review.json"), `${JSON.stringify(plan.report, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(plan.root, "review.md"), renderAggregate(plan.report), "utf8");
  await fs.writeFile(path.join(plan.root, "handoff.md"), renderHandoff(plan.report), "utf8");
  for (const review of plan.report.skills) await writeSubject(plan.root, "skills", review);
  for (const review of plan.report.agents) await writeSubject(plan.root, "agents", review);
  return { root: plan.root, schema: plan.report.schema, summary: plan.report.summary, files: plan.files.map((file) => rel(plan.root, file)) };
}

function reviewSkill(composition, bySkill, endpoint) {
  const findings = [];
  const declarations = group(composition.declarations);
  for (const issue of composition.artifact.validationErrors ?? []) {
    findings.push(finding(
      "error",
      "structure",
      issue.id,
      issue.message,
      issue.evidence,
      "Bring SKILL.md into conformance with the Agent Skills specification, then rerun HIX review."
    ));
  }
  for (const conflict of composition.conflicts) findings.push(finding("error", "structure", `conflicting-${conflict.dimension}`, `Conflicting declarations exist for ${conflict.dimension}.`, conflict.declarations.map((item) => `${item.source}=${fmt(item.value)}`), "Resolve the conflicting declarations and rerun HIX review."));
  for (const unresolved of composition.unresolved) findings.push(finding("error", "composition", `unresolved-${unresolved.kind}`, unresolved.reason, unresolved.ref ? [unresolved.ref] : [], "Repair or remove the unresolved relationship and rerun HIX review."));

  const context = first(declarations, "context-isolation");
  const agent = first(declarations, "execution-agent");
  const model = first(declarations, "model-selection");
  const effort = first(declarations, "reasoning-effort");
  if (context === "fork" && !agent) findings.push(finding("warning", "composition", "fork-without-explicit-agent", "The skill requests isolated execution without naming an execution agent.", evidence(declarations.get("context-isolation")), "Confirm the default agent is intentional or declare the intended agent."));
  if (agent) {
    const relation = composition.relations.find((item) => item.kind === "executes-via" && item.from === composition.root.ref);
    if (!relation || !composition.members.some((member) => member.ref === relation.to)) findings.push(finding("warning", "composition", "agent-reference-not-observed", `Execution agent ${agent} is declared but no native agent artifact was observed.`, relation ? [relation.evidence] : evidence(declarations.get("execution-agent")), "Verify the named agent exists or is intentionally built-in."));
  }
  if (effort && !KNOWN_EFFORTS.has(String(effort))) findings.push(finding("warning", "execution", "unknown-effort-level", `Reasoning effort ${JSON.stringify(effort)} is not in HIX's known cross-harness effort set.`, evidence(declarations.get("reasoning-effort")), "Verify the value against the current harness."));
  if (model) findings.push(finding("info", "portability", "model-is-harness-native", `Model selection ${JSON.stringify(model)} is harness-native.`, evidence(declarations.get("model-selection")), "Choose the destination model explicitly across vendors."));

  const preloadedSkills = preloadsFromComposition(composition, bySkill);
  for (const preload of preloadedSkills) addPreloadFinding(findings, preload);
  for (const requirement of composition.runtimeRequirements) findings.push(finding("warning", "authority", "runtime-authority-requirement", `Capability requires runtime constraint ${requirement.dimension}=${fmt(requirement.value)}.`, requirement.evidence ? [JSON.stringify(requirement.evidence)] : [], "Ensure the runtime envelope is enforced in addition to static declarations."));

  const target = endpoint.participant === "claude" ? "codex" : endpoint.participant === "codex" ? "claude" : undefined;
  if (target) {
    const synthetic = { spec: `${target}:review-target`, participant: target, behavior: target === "claude" ? "claude" : "open-agent-skills" };
    for (const mapping of analyzeBehaviorTransfer(composition.artifact, endpoint, synthetic)) {
      if (["portable", "preserved-native", "preserved-declaration", "direct-native-projection"].includes(mapping.status)) continue;
      findings.push(finding(mapping.status === "unmapped" ? "warning" : "info", "portability", `portability-${mapping.dimension}-${mapping.status}`, `${mapping.dimension} is ${mapping.status} when targeting ${target}.`, [mapping.source], mapping.note || "Review the target-native realization before materializing."));
    }
  }
  if (!findings.some((item) => item.severity === "error")) findings.push(finding("pass", "structure", "composition-observable", "No structural blockers were found in the observed skill composition.", [`compositionHash:${composition.compositionHash}`], "Review warnings before use or movement."));

  return finish({ schema: "hix.skill-review/v1", kind: "skill", id: composition.id, participant: endpoint.participant, hash: composition.compositionHash, compositionHash: composition.compositionHash, members: composition.members, relations: composition.relations, declarations: composition.declarations, runtimeRequirements: composition.runtimeRequirements, preloadedSkills, findings });
}

async function discoverNativeAgents(endpoint) {
  const root = endpoint.nativeRoots?.agents;
  if (!root) return [];
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  const ext = endpoint.participant === "claude" ? ".md" : endpoint.participant === "codex" ? ".toml" : undefined;
  if (!ext) return [];
  const agents = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(ext)) continue;
    const id = entry.name.slice(0, -ext.length);
    const absolutePath = path.join(root, entry.name);
    const content = await fs.readFile(absolutePath);
    agents.push(parseAgent(endpoint, id, content, absolutePath));
  }
  return agents.sort((a, b) => a.id.localeCompare(b.id));
}

function parseAgent(endpoint, id, content, absolutePath) {
  const relativePath = endpoint.participant === "claude" ? `.claude/agents/${id}.md` : `.codex/agents/${id}.toml`;
  const base = { id, ref: `${endpoint.participant}-agent:${id}`, participant: endpoint.participant, path: relativePath, absolutePath, hash: sha(content), content };
  if (endpoint.participant === "claude") {
    const fm = inspectSkillFrontmatter(content.toString("utf8"), relativePath);
    return {
      ...base,
      name: fm.name ?? id,
      description: fm.description,
      model: fm.values?.model,
      effort: fm.values?.effort,
      permissionMode: fm.values?.permissionMode,
      tools: stringList(fm.values?.tools),
      skills: stringList(fm.values?.skills),
      instructions: markdownBody(content.toString("utf8")),
      parseErrors: fm.parseErrors
    };
  }
  const text = content.toString("utf8");
  const parsed = parseToml(text, relativePath);
  const value = parsed.value ?? {};
  return {
    ...base,
    name: value.name ?? id,
    description: value.description,
    model: value.model,
    effort: value.model_reasoning_effort,
    sandboxMode: value.sandbox_mode,
    instructions: value.developer_instructions,
    parseErrors: parsed.errors
  };
}

function reviewAgent(agent, bySkill, referencedAgents) {
  const findings = [];
  for (const message of agent.parseErrors ?? []) {
    findings.push(finding("error", "structure", "invalid-native-agent-config", message, [agent.path], "Correct the native agent configuration and rerun HIX review."));
  }
  if (!agent.description) findings.push(finding("warning", "structure", "missing-description", "Native agent has no description.", [agent.path], "Add a concise description of when the agent should be selected and what it owns."));
  if (agent.effort && !KNOWN_EFFORTS.has(String(agent.effort))) findings.push(finding("warning", "execution", "unknown-effort-level", `Reasoning effort ${JSON.stringify(agent.effort)} is not in HIX's known cross-harness set.`, [`${agent.path}:effort`], "Verify the effort value against the current harness."));
  if (agent.model) findings.push(finding("info", "portability", "model-is-harness-native", `Model selection ${JSON.stringify(agent.model)} is harness-native.`, [`${agent.path}:model`], "Require an explicit destination model across vendors."));
  if (!referencedAgents.has(agent.ref)) findings.push(finding("info", "composition", "standalone-agent", "Agent is not referenced by any reviewed skill composition and is treated as a first-class standalone native participant.", [agent.path], "Keep it standalone if intentional; otherwise add machine-readable relationship evidence."));

  const preloadedSkills = (agent.skills ?? []).map((name) => ({ name, status: bySkill.has(name) ? "discovered" : "missing", source: `${agent.path}:skills` }));
  for (const preload of preloadedSkills) addPreloadFinding(findings, preload);
  if (agent.permissionMode === "bypassPermissions") findings.push(finding("warning", "authority", "broad-permission-mode", "Claude agent requests bypassPermissions.", [`${agent.path}:permissionMode`], "Confirm elevated authority is intentional and necessary."));
  if (agent.sandboxMode && agent.sandboxMode !== "read-only") findings.push(finding("info", "authority", "sandbox-mode", `Codex agent declares sandbox_mode=${agent.sandboxMode}.`, [`${agent.path}:sandbox_mode`], "Review whether this authority matches the agent's responsibilities."));
  if (!findings.some((item) => item.severity === "error")) findings.push(finding("pass", "structure", "native-agent-observable", "Native agent was discovered and parsed as a first-class review subject.", [`hash:${agent.hash}`], "Review warnings before use or movement."));
  return finish({ schema: "hix.agent-review/v1", kind: "agent", id: agent.id, participant: agent.participant, hash: agent.hash, path: agent.path, model: agent.model, effort: agent.effort, permissionMode: agent.permissionMode, sandboxMode: agent.sandboxMode, tools: agent.tools ?? [], preloadedSkills, findings });
}

function preloadsFromComposition(composition, bySkill) {
  const result = [];
  for (const native of composition.nativeArtifacts ?? []) {
    if (native.member.kind !== "claude-agent") continue;
    const frontmatter = inspectSkillFrontmatter(native.content.toString("utf8"), native.member.path);
    for (const name of stringList(frontmatter.values?.skills)) {
      result.push({
        name,
        status: bySkill.has(name) ? "discovered" : "missing",
        source: `${native.member.path}:skills`
      });
    }
  }
  return result;
}

function addPreloadFinding(findings, preload) {
  if (preload.status === "missing") findings.push(finding("error", "composition", "missing-preloaded-skill", `Agent preloads skill ${preload.name}, but that skill was not discovered at the endpoint.`, [preload.source], "Install or restore the skill, or remove it from the agent preload list."));
  else findings.push(finding("info", "composition", "preloaded-skill", `Agent preloads discovered skill ${preload.name}.`, [preload.source, `skill:${preload.name}`], "Review this skill as part of the agent's execution context."));
}

function finish(record) {
  const counts = countsFor(record.findings);
  return { ...record, status: counts.error ? "blocked" : counts.warning ? "needs-review" : "ready", counts, enhancementTasks: record.findings.filter((item) => ["error", "warning"].includes(item.severity)).map((item) => ({ id: item.id, instruction: item.recommendation, evidence: item.evidence })) };
}

function buildHandoff(subjects, endpoint) {
  return {
    purpose: "Improve the reviewed skills and agents before use, transfer, or materialization without accidentally changing intended behavior.",
    sourceEndpoint: endpoint.spec,
    sourceParticipant: endpoint.participant,
    instructions: [
      "Treat findings and evidence as review input, not as permission to rewrite unrelated behavior.",
      "Resolve errors first, then warnings. Preserve explicit authority restrictions and invocation semantics.",
      "Do not infer cross-vendor model equivalence. Keep model changes explicit.",
      "Treat skills and agents as peer native artifacts and preserve observed relationships between them.",
      "When an agent preloads skills, review those skills as part of its execution context.",
      "After edits, rerun hix review and compare hashes and findings."
    ],
    subjects: subjects.map((item) => ({ kind: item.kind, id: item.id, status: item.status, hash: item.compositionHash ?? item.hash, tasks: item.enhancementTasks }))
  };
}

function summarize(subjects) {
  return subjects.reduce((acc, item) => {
    acc.subjects += 1;
    acc.capabilities += 1;
    acc[item.kind === "agent" ? "agents" : "skills"] += 1;
    acc[item.status] += 1;
    for (const [severity, count] of Object.entries(item.counts)) acc.findings[severity] = (acc.findings[severity] ?? 0) + count;
    return acc;
  }, { subjects: 0, capabilities: 0, skills: 0, agents: 0, ready: 0, "needs-review": 0, blocked: 0, findings: {} });
}

async function writeSubject(root, dir, review) {
  const stem = safe(review.id);
  await fs.writeFile(path.join(root, dir, `${stem}.json`), `${JSON.stringify(review, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(root, dir, `${stem}.md`), renderSubject(review), "utf8");
}

function renderAggregate(report) {
  const lines = ["# HIX Harness Review", "", `Endpoint: \`${report.endpoint.spec}\``, `Participant: \`${report.endpoint.participant}\``, `Reviewed: ${report.summary.skills} skills · ${report.summary.agents} agents`, `Status: ${report.summary.ready} ready · ${report.summary["needs-review"]} needs review · ${report.summary.blocked} blocked`, ""];
  for (const item of report.capabilities) {
    lines.push(`## ${item.kind}: ${item.id}`, "", `Status: **${item.status}**`, `Hash: \`${item.compositionHash ?? item.hash}\``, "");
    for (const finding of item.findings) lines.push(`- **${finding.severity.toUpperCase()} · ${finding.category}** — ${finding.message}`);
    lines.push("");
  }
  lines.push("See `handoff.md` for an LLM-ready brief, `skills/` for skill reviews, and `agents/` for native agent reviews.", "");
  return lines.join("\n");
}

function renderSubject(review) {
  const lines = [`# ${review.kind === "agent" ? "Agent" : "Skill"} Review: ${review.id}`, "", `Status: **${review.status}**`, `Hash: \`${review.compositionHash ?? review.hash}\``, "", "## Findings", ""];
  for (const finding of review.findings) {
    lines.push(`### ${finding.severity.toUpperCase()} · ${finding.category} · ${finding.id}`, "", finding.message, "");
    if (finding.evidence.length) lines.push(`Evidence: ${finding.evidence.map((value) => `\`${value}\``).join(", ")}`, "");
    lines.push(`Recommendation: ${finding.recommendation}`, "");
  }
  if (review.preloadedSkills?.length) {
    lines.push("## Preloaded skills", "");
    for (const preload of review.preloadedSkills) lines.push(`- ${preload.name}: ${preload.status} (${preload.source})`);
    lines.push("");
  }
  return lines.join("\n");
}

function renderHandoff(report) {
  const lines = ["# HIX Review Handoff", "", report.handoff.purpose, "", "## Instructions", ""];
  for (const instruction of report.handoff.instructions) lines.push(`- ${instruction}`);
  lines.push("", "## Review subjects", "");
  for (const subject of report.handoff.subjects) {
    lines.push(`### ${subject.kind}: ${subject.id}`, "", `Status: **${subject.status}**`, `Hash: \`${subject.hash}\``, "");
    if (!subject.tasks.length) lines.push("No blocking or warning-level changes requested.", "");
    for (const task of subject.tasks) { lines.push(`- **${task.id}:** ${task.instruction}`); if (task.evidence.length) lines.push(`  Evidence: ${task.evidence.join("; ")}`); }
    lines.push("");
  }
  return lines.join("\n");
}

function plannedFiles(root, skills, agents) {
  const files = [path.join(root, "review.json"), path.join(root, "review.md"), path.join(root, "handoff.md")];
  for (const item of skills) files.push(path.join(root, "skills", `${safe(item.id)}.json`), path.join(root, "skills", `${safe(item.id)}.md`));
  for (const item of agents) files.push(path.join(root, "agents", `${safe(item.id)}.json`), path.join(root, "agents", `${safe(item.id)}.md`));
  return files.sort();
}

function defaultReviewRoot(endpoint, options) {
  const environmentRoot = endpoint.environmentRoot ?? options.project ?? process.cwd();
  return path.join(environmentRoot, ".hix", safe(endpoint.participant || "unknown"), "reviews", safe(endpoint.scope || endpoint.spec));
}

function selectNames(discovered, selection) {
  const names = selection.names ?? [];
  if (selection.all && names.length) throw new Error("Use either --all or --skill for review, not both.");
  if (selection.all || !names.length) return [...discovered];
  const available = new Set(discovered);
  for (const name of names) if (!available.has(name)) throw new Error(`Endpoint does not contain skill ${name}.`);
  return names;
}

async function prepareOutput(root, replace) {
  let stat;
  try {
    stat = await fs.lstat(root);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!replace) throw new Error(`${root} already exists. Pass --replace to replace the previous HIX review output.`);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${root} is not a regular HIX review directory. Refusing replacement.`);
  }
  if (path.resolve(root) === path.parse(path.resolve(root)).root) {
    throw new Error("Refusing to replace a filesystem root.");
  }
  let marker;
  try {
    const markerPath = path.join(root, "review.json");
    if (!(await fs.lstat(markerPath)).isFile()) throw new Error("marker is not a regular file");
    marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
  } catch {
    throw new Error(`${root} is not a marked HIX review directory. Refusing replacement.`);
  }
  if (marker?.schema !== "hix.review/v2") {
    throw new Error(`${root} has an unrecognized review marker. Refusing replacement.`);
  }
  await fs.rm(root, { recursive: true, force: true });
}

function finding(severity, category, id, message, evidence = [], recommendation = "Review this finding.") { return { severity, category, id, message, evidence: evidence.filter(Boolean), recommendation }; }
function countsFor(findings) { return findings.reduce((acc, item) => { acc[item.severity] = (acc[item.severity] ?? 0) + 1; return acc; }, { error: 0, warning: 0, info: 0, pass: 0 }); }
function group(items) { const map = new Map(); for (const item of items) { const values = map.get(item.dimension) ?? []; values.push(item); map.set(item.dimension, values); } return map; }
function first(map, key) { return map.get(key)?.[0]?.value; }
function evidence(items = []) { return items.map((item) => `${item.source}=${fmt(item.nativeValue ?? item.value)}`); }
function fmt(value) { return Array.isArray(value) ? value.join(",") : String(value); }
function safe(value) { return String(value).replace(/[^A-Za-z0-9._-]+/g, "-"); }
function rel(root, file) { return path.relative(root, file).split(path.sep).join("/"); }
function sha(content) { return crypto.createHash("sha256").update(content).digest("hex"); }
