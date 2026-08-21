import fs from "node:fs/promises";
import path from "node:path";
import { assertSkillSafeForWrite, discoverSkills } from "./artifacts.js";
import { observeComposedCapability } from "./composition.js";
import { resolveEndpoint } from "./endpoints.js";
import { markdownBody, parseToml } from "./formats.js";

const PORTABLE_FRONTMATTER_KEYS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata"
]);
const CLAUDE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const CLAUDE_READ_ONLY_TOOLS = ["Read", "Glob", "Grep"];
const SOURCE_DIMENSIONS_WITHOUT_SAFE_CLAUDE_REALIZATION = new Map([
  ["tool-dependencies", "Codex tool dependency metadata has no equivalent Claude skill-local dependency manifest."],
  ["lifecycle-hooks", "Source lifecycle hooks are not translated by the Claude materializer."],
  ["activation-paths", "Source path-activation behavior has no safe cross-harness materialization here."],
  ["skill-shell", "Source skill-local shell selection has no safe Claude target mapping here."],
  ["dynamic-context", "Source dynamic shell context has no safe Claude target mapping here."],
  ["user-invocation", "Source user-invocation visibility is not translated by the Claude materializer."]
]);

export async function planClaudeMaterialization(sourceSpec, selection, options = {}) {
  if (!options.out) throw new Error("materialize/project requires --out <path>.");
  if (selection.names.length !== 1) throw new Error("materialize/project requires exactly one --skill <name> in V0.");
  if (options.claudeAgent) validateClaudeAgentName(options.claudeAgent);

  const sourceEndpoint = await resolveEndpoint(sourceSpec, options);
  const skills = await discoverSkills(sourceEndpoint);
  const artifact = skills.find((skill) => skill.name === selection.names[0]);
  if (!artifact) throw new Error(`Source endpoint does not contain skill ${selection.names[0]}.`);

  const composition = await observeComposedCapability(artifact, sourceEndpoint);
  const declarations = new Map(composition.declarations.map((item) => [item.dimension, item]));
  const unresolved = [];
  const resolutions = [];
  const runtimeRequirements = [];
  const out = path.resolve(options.out);

  for (const issue of artifact.validationErrors) {
    unresolved.push({ dimension: issue.id, reason: issue.message, evidence: issue.evidence });
  }

  for (const conflict of composition.conflicts) {
    unresolved.push({
      dimension: conflict.dimension,
      reason: "Source composition contains contradictory native declarations. Resolve them before materialization."
    });
  }
  for (const item of composition.unresolved) {
    unresolved.push({
      dimension: "composition-observation",
      reason: `${item.kind}${item.ref ? ` ${item.ref}` : ""}: ${item.reason}`
    });
  }

  const sourceAgent = relatedNativeAgent(composition, "codex-agent");
  const consumedRefs = new Set(sourceAgent ? [sourceAgent.member.ref] : []);
  const unconsumedMembers = composition.members.filter(
    (item) => item.ref !== composition.root.ref && !consumedRefs.has(item.ref)
  );
  if (unconsumedMembers.length) {
    unresolved.push({
      dimension: "external-composition-members",
      reason:
        `The observed capability contains target-unmapped native members: ${unconsumedMembers.map((item) => item.ref).join(", ")}. ` +
        "Claude materialization refuses to discard them."
    });
  }

  const hasExecutionRelation = composition.relations.some(
    (item) => item.kind === "executes-via" && item.from === composition.root.ref
  );
  const needsClaudeAgent = Boolean(sourceAgent || hasExecutionRelation || composition.runtimeRequirements.length);
  if (needsClaudeAgent && !options.claudeAgent) {
    unresolved.push({
      dimension: "custom-agent",
      reason: "This composition requires isolated/delegated execution. Choose the target Claude agent identity with --claude-agent <name>."
    });
  }

  let sourceAgentConfig;
  const roundTrip = readRoundTripPayload(composition);
  if (sourceAgent) {
    sourceAgentConfig = parseCodexAgent(sourceAgent.content);
    if (sourceAgentConfig.errors.length) {
      unresolved.push({
        dimension: "agent-config",
        reason: `Could not parse ${sourceAgent.member.path}: ${sourceAgentConfig.errors.join("; ")}`
      });
    } else if (!sourceAgentConfig.instructions && !roundTrip) {
      unresolved.push({
        dimension: "agent-instructions",
        reason: `Could not read developer_instructions from ${sourceAgent.member.path}; refusing to materialize an incomplete Claude agent.`
      });
    } else {
      resolutions.push({
        dimension: "composition-member",
        source: sourceAgent.member.path,
        target: `.claude/agents/${options.claudeAgent ?? "<agent>"}.md`,
        authority: "observed-native-member",
        note: "The observed Codex custom-agent instructions become the Claude custom-agent prompt; the TOML file itself is not copied as if it were Claude-native."
      });
    }
  }

  for (const declaration of composition.declarations) {
    const unsupported = SOURCE_DIMENSIONS_WITHOUT_SAFE_CLAUDE_REALIZATION.get(declaration.dimension);
    if (unsupported) unresolved.push({ dimension: declaration.dimension, source: declaration.source, reason: unsupported });
  }

  const model = declarations.get("model-selection");
  if (model && !options.claudeModel) {
    unresolved.push({
      dimension: "model-selection",
      reason: `Source requests ${formatNative(model)}. No model equivalence is assumed; choose --claude-model <model>.`
    });
  } else if (model && options.claudeModel) {
    resolutions.push({
      dimension: "model-selection",
      source: formatNative(model),
      target: needsClaudeAgent
        ? `.claude/agents/${options.claudeAgent ?? "<agent>"}.md:model=${options.claudeModel}`
        : `SKILL.md:model=${options.claudeModel}`,
      authority: "explicit-operator-choice"
    });
  }

  const effort = declarations.get("reasoning-effort");
  let targetEffort;
  if (effort) {
    targetEffort = options.claudeEffort ?? String(effort.value);
    if (!CLAUDE_EFFORTS.has(targetEffort)) {
      unresolved.push({
        dimension: "reasoning-effort",
        reason:
          `Claude does not support reasoning effort ${JSON.stringify(effort.value)} as a direct value. ` +
          "Choose --claude-effort low|medium|high|xhigh|max."
      });
      targetEffort = undefined;
    } else {
      resolutions.push({
        dimension: "reasoning-effort",
        source: formatNative(effort),
        target: needsClaudeAgent
          ? `.claude/agents/${options.claudeAgent ?? "<agent>"}.md:effort=${targetEffort}`
          : `SKILL.md:effort=${targetEffort}`,
        authority: options.claudeEffort ? "explicit-operator-choice" : "documented-correspondence",
        note: "Matching effort labels are treated as a target setting correspondence, not as proof of equal reasoning behavior."
      });
    }
  }

  const implicit = declarations.get("implicit-invocation");
  if (implicit) {
    resolutions.push({
      dimension: "implicit-invocation",
      source: formatNative(implicit),
      target: `SKILL.md:disable-model-invocation=${implicit.value ? "false" : "true"}`,
      authority: "documented-correspondence"
    });
  }

  let claudePermissionMode;
  const sandbox = declarations.get("sandbox-mode");
  if (sandbox) {
    if (sandbox.value === "read-only") {
      claudePermissionMode = "plan";
      resolutions.push({
        dimension: "sandbox-mode",
        source: formatNative(sandbox),
        target: `.claude/agents/${options.claudeAgent ?? "<agent>"}.md:permissionMode=plan`,
        authority: "safe-narrowing",
        note: "Claude plan mode is used as the read-only exploration default; HIX does not claim Codex sandbox and Claude permission semantics are identical."
      });
    } else {
      unresolved.push({
        dimension: "sandbox-mode",
        reason: `No safe Claude materialization is defined for source sandbox mode ${JSON.stringify(sandbox.value)}.`
      });
    }
  }

  for (const requirement of composition.runtimeRequirements) {
    if (requirement.dimension === "authority-enforcement" && requirement.value === "read-only-no-escalation") {
      claudePermissionMode = "plan";
      const targetRequirement = claudeReadOnlyNoEscalationRequirement();
      runtimeRequirements.push(targetRequirement);
      resolutions.push({
        dimension: "authority-enforcement",
        source: `${requirement.runtime ?? "source"}:${requirement.value}`,
        target: "Claude agent permissionMode=plan plus parent runtime constraint",
        authority: "documented-target-realization",
        note: "Claude parent permission modes can override a subagent permissionMode, so the parent restriction remains part of the composed capability."
      });
    } else {
      unresolved.push({
        dimension: "source-runtime-requirements",
        reason: `No Claude target realization is defined for runtime requirement ${requirement.dimension}:${requirement.value}.`
      });
    }
  }

  const files = plannedFiles(artifact, options, out, needsClaudeAgent);
  return {
    target: "claude",
    source: {
      endpoint: sourceEndpoint,
      skill: artifact.name,
      hash: artifact.hash,
      compositionHash: composition.compositionHash,
      path: artifact.rootPath
    },
    out,
    composition,
    artifact,
    sourceAgent,
    sourceAgentConfig,
    roundTrip,
    needsClaudeAgent,
    claudePermissionMode,
    targetEffort,
    choices: {
      claudeAgent: options.claudeAgent,
      claudeModel: options.claudeModel,
      claudeEffort: options.claudeEffort
    },
    declarations,
    resolutions,
    runtimeRequirements,
    unresolved,
    files
  };
}

export async function applyClaudeMaterialization(plan, options = {}) {
  if (plan.unresolved.length) {
    throw new Error(`Materialization is unresolved:\n- ${plan.unresolved.map((item) => `${item.dimension}: ${item.reason}`).join("\n- ")}`);
  }
  assertSkillSafeForWrite(plan.artifact);

  await prepareOutput(plan.out, options.replace);

  const skillRoot = safeJoin(path.join(plan.out, ".claude", "skills"), plan.artifact.name);
  await fs.mkdir(skillRoot, { recursive: true });
  await copySkillEntries(plan.artifact, skillRoot);
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), buildClaudeSkillMarkdown(plan), "utf8");

  if (plan.needsClaudeAgent) {
    const agentsRoot = path.join(plan.out, ".claude", "agents");
    await fs.mkdir(agentsRoot, { recursive: true });
    await fs.writeFile(
      path.join(agentsRoot, `${plan.choices.claudeAgent}.md`),
      buildClaudeAgentMarkdown(plan),
      "utf8"
    );
  }

  const manifest = {
    schema: "hix.projection/v1",
    source: {
      endpoint: plan.source.endpoint.spec,
      participant: plan.source.endpoint.participant,
      skill: plan.source.skill,
      hash: plan.source.hash,
      compositionHash: plan.source.compositionHash
    },
    target: { participant: "claude" },
    choices: plan.choices,
    resolutions: plan.resolutions,
    runtimeRequirements: plan.runtimeRequirements,
    roundTrip: targetRoundTripPayload(plan),
    files: plan.files.map((file) => portableRelativePath(plan.out, file)),
    claims: { crossHarnessEquivalence: false }
  };
  await fs.writeFile(path.join(plan.out, "hix-projection.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function buildClaudeSkillMarkdown(plan) {
  const headerLines = portableFrontmatterLines(plan.artifact);
  const implicit = plan.declarations.get("implicit-invocation");
  if (implicit) headerLines.push(`disable-model-invocation: ${implicit.value ? "false" : "true"}`);

  if (plan.needsClaudeAgent) {
    headerLines.push("context: fork");
    headerLines.push(`agent: ${plan.choices.claudeAgent}`);
  } else {
    if (plan.choices.claudeModel) headerLines.push(`model: ${plan.choices.claudeModel}`);
    if (plan.targetEffort) headerLines.push(`effort: ${plan.targetEffort}`);
  }

  const body = plan.roundTrip?.sourceCapabilityInstructions ?? markdownBody(sourceMarkdown(plan.artifact));
  return `---\n${headerLines.join("\n")}\n---\n${body.startsWith("\n") ? "" : "\n"}${body}`;
}

function buildClaudeAgentMarkdown(plan) {
  const description = plan.sourceAgentConfig?.description ?? plan.artifact.frontmatter.description ?? `Agent for ${plan.artifact.name}`;
  const lines = [
    "---",
    `name: ${plan.choices.claudeAgent}`,
    `description: ${yamlScalar(description)}`
  ];
  if (plan.choices.claudeModel) lines.push(`model: ${plan.choices.claudeModel}`);
  if (plan.targetEffort) lines.push(`effort: ${plan.targetEffort}`);
  if (plan.claudePermissionMode) lines.push(`permissionMode: ${plan.claudePermissionMode}`);
  if (plan.claudePermissionMode === "plan") lines.push(`tools: ${CLAUDE_READ_ONLY_TOOLS.join(", ")}`);
  lines.push("---", "");

  const instructions = plan.roundTrip
    ? plan.roundTrip.sourceNativeAgentInstructions ??
      "Execute the provided capability task in this agent context. Respect the declared model, effort, and authority constraints."
    : plan.sourceAgentConfig?.instructions ?? markdownBody(sourceMarkdown(plan.artifact)).trim();
  lines.push(instructions.trim(), "");
  return lines.join("\n");
}

function relatedNativeAgent(composition, kind) {
  const relation = composition.relations.find(
    (item) => item.kind === "executes-via" && item.from === composition.root.ref && item.to.startsWith(`${kind}:`)
  );
  if (!relation) return undefined;
  return composition.nativeArtifacts.find((item) => item.member.ref === relation.to);
}

function parseCodexAgent(content) {
  const text = content.toString("utf8");
  const parsed = parseToml(text, "Codex custom agent");
  if (parsed.errors.length) return { errors: parsed.errors };
  return {
    errors: [],
    name: parsed.value.name,
    description: parsed.value.description,
    model: parsed.value.model,
    effort: parsed.value.model_reasoning_effort,
    sandboxMode: parsed.value.sandbox_mode,
    instructions: parsed.value.developer_instructions
  };
}

function readRoundTripPayload(composition) {
  const payload = composition.projection?.manifest?.roundTrip;
  if (!payload || payload.schema !== "hix.round-trip/v1") return undefined;
  if (typeof payload.sourceCapabilityInstructions !== "string") return undefined;
  if (payload.sourceNativeAgentInstructions !== undefined && typeof payload.sourceNativeAgentInstructions !== "string") return undefined;
  return payload;
}

function targetRoundTripPayload(plan) {
  const sourceCapabilityInstructions = plan.roundTrip?.sourceCapabilityInstructions ??
    markdownBody(sourceMarkdown(plan.artifact)).trim();
  const sourceNativeAgentInstructions = plan.roundTrip
    ? plan.roundTrip.sourceNativeAgentInstructions
    : plan.sourceAgentConfig?.instructions;
  return {
    schema: "hix.round-trip/v1",
    sourceCapabilityInstructions,
    ...(sourceNativeAgentInstructions ? { sourceNativeAgentInstructions } : {})
  };
}

function claudeReadOnlyNoEscalationRequirement() {
  return {
    dimension: "authority-enforcement",
    value: "read-only-no-escalation",
    status: "target-runtime-requirement",
    runtime: "claude",
    configuration: {
      agent: { permissionMode: "plan" },
      parent: { disallowedPermissionModes: ["bypassPermissions", "acceptEdits"] }
    },
    evidence: {
      kind: "documented-runtime-constraint",
      assertion: "parent-permission-mode-can-override-subagent-permission-mode"
    },
    reason:
      "Claude plan mode provides read-only exploration, but permissive parent modes can take precedence over a subagent permissionMode. " +
      "The parent must therefore avoid modes that would widen the delegated agent's authority."
  };
}

function plannedFiles(artifact, options, out, needsClaudeAgent) {
  const files = artifact.entries
    .filter((entry) =>
      entry.kind !== "directory" &&
      entry.path !== "SKILL.md" &&
      entry.path !== "agents/openai.yaml" &&
      entry.path !== "agents/openai.yml"
    )
    .map((entry) => path.join(out, ".claude", "skills", artifact.name, entry.path));
  files.push(path.join(out, ".claude", "skills", artifact.name, "SKILL.md"));
  if (needsClaudeAgent && options.claudeAgent) {
    files.push(path.join(out, ".claude", "agents", `${options.claudeAgent}.md`));
  }
  files.push(path.join(out, "hix-projection.json"));
  return files.sort();
}

async function copySkillEntries(artifact, skillRoot) {
  for (const entry of artifact.entries) {
    if (entry.path === "SKILL.md" || entry.path === "agents/openai.yaml" || entry.path === "agents/openai.yml") continue;
    const destination = safeJoin(skillRoot, entry.path);
    if (entry.kind === "directory") {
      await fs.mkdir(destination, { recursive: true });
    } else if (entry.kind === "file") {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, entry.content);
      await fs.chmod(destination, entry.mode);
    } else if (entry.kind === "symlink") {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.symlink(entry.target, destination);
    }
  }
}

function portableFrontmatterLines(artifact) {
  const markdown = sourceMarkdown(artifact).replace(/\r\n/g, "\n");
  const lines = markdown.split("\n");
  const end = findFrontmatterEnd(lines);
  const blocks = end > 0 ? topLevelBlocks(lines.slice(1, end)) : [];
  const kept = blocks.filter((block) => PORTABLE_FRONTMATTER_KEYS.has(block.key)).flatMap((block) => block.lines);
  const allowed = artifact.frontmatter.values?.["allowed-tools"];
  if (allowed !== undefined && allowed !== null && allowed !== "") {
    kept.push(`allowed-tools: ${Array.isArray(allowed) ? allowed.join(" ") : String(allowed)}`);
  }
  return kept;
}

function sourceMarkdown(artifact) {
  const entry = artifact.entries.find((item) => item.kind === "file" && item.path === "SKILL.md");
  if (!entry) throw new Error(`${artifact.name} has no SKILL.md entry.`);
  return entry.content.toString("utf8");
}

function findFrontmatterEnd(lines) {
  if (lines[0]?.trim() !== "---") return -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === "---") return index;
  }
  return -1;
}

function topLevelBlocks(lines) {
  const blocks = [];
  let current;
  for (const line of lines) {
    const match = /^([A-Za-z0-9_-]+):(?:\s|$)/.exec(line);
    if (match && !/^\s/.test(line)) {
      current = { key: match[1], lines: [line] };
      blocks.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return blocks;
}

async function prepareOutput(out, replace) {
  const exists = await pathExists(out);
  if (exists && !replace) {
    throw new Error(`${out} already exists. Review it and pass --replace to authorize replacing the disposable materialization.`);
  }
  if (exists) {
    const marker = path.join(out, "hix-projection.json");
    if (!(await pathExists(marker))) {
      throw new Error(`${out} is not a hix materialization. Refusing to replace an unmarked directory.`);
    }
    await fs.rm(out, { recursive: true, force: true });
  }
}

function validateClaudeAgentName(name) {
  if (!/^[a-z0-9-]+$/.test(name) || name.length > 64) {
    throw new Error("--claude-agent must be 1-64 lowercase letters, numbers, or hyphens.");
  }
}

function yamlScalar(value) {
  return JSON.stringify(String(value));
}

function formatNative(declaration) {
  const nativeValue = declaration.nativeValue ?? declaration.value;
  return `${declaration.source}=${Array.isArray(nativeValue) ? nativeValue.join(",") : String(nativeValue)}`;
}

function portableRelativePath(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

async function pathExists(candidate) {
  try {
    await fs.lstat(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function safeJoin(root, relative) {
  const target = path.resolve(root, relative);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (target !== path.resolve(root) && !target.startsWith(prefix)) throw new Error(`Unsafe materialization path: ${relative}`);
  return target;
}
