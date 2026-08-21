import fs from "node:fs/promises";
import path from "node:path";
import { assertSkillSafeForWrite, discoverSkills } from "./artifacts.js";
import { observeComposedCapability } from "./composition.js";
import { resolveEndpoint } from "./endpoints.js";
import { findTestedPairing } from "./support.js";

const PORTABLE_FRONTMATTER_KEYS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata"
]);
const CODEX_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
const CUSTOM_AGENT_DIMENSIONS = new Set([
  "model-selection",
  "reasoning-effort",
  "context-isolation",
  "execution-agent"
]);
const UNSUPPORTED_DIMENSIONS = new Map([
  ["lifecycle-hooks", "Codex hooks are not skill-scoped; this materializer does not widen them into project configuration."],
  ["user-invocation", "Claude user-invocable visibility has no safe Codex skill-local projection."],
  ["activation-paths", "Claude path activation has no safe Codex skill-local projection."],
  ["skill-shell", "Claude skill shell selection has no safe Codex skill-local projection."],
  ["dynamic-context", "Claude dynamic shell context has no safe Codex skill-local projection."],
  ["tool-dependencies", "Existing Codex tool dependency metadata is not merged by the V0 materializer."],
  ["sandbox-mode", "A source-native agent sandbox is an external composition member; V0 does not translate it independently."]
]);

export async function planProjection(sourceSpec, target, selection, options = {}) {
  if (target !== "codex") throw new Error("V0 materialization supports only the codex target.");
  if (!options.out) throw new Error("materialize/project requires --out <path>.");
  if (selection.names.length !== 1) throw new Error("materialize/project requires exactly one --skill <name> in V0.");

  if (options.codexAgent) validateCodexAgentName(options.codexAgent);

  const sourceEndpoint = await resolveEndpoint(sourceSpec, options);
  const skills = await discoverSkills(sourceEndpoint);
  const artifact = skills.find((skill) => skill.name === selection.names[0]);
  if (!artifact) throw new Error(`Source endpoint does not contain skill ${selection.names[0]}.`);

  const composition = await observeComposedCapability(artifact, sourceEndpoint);
  const unresolved = [];
  const resolutions = [];
  const declarations = new Map(composition.declarations.map((item) => [item.dimension, item]));
  const needsCustomAgent = composition.declarations.some((item) => CUSTOM_AGENT_DIMENSIONS.has(item.dimension));
  const out = path.resolve(options.out);
  const consumableNativeArtifacts = composition.nativeArtifacts.filter(
    (item) => sourceEndpoint.participant === "claude" && item.member.kind === "claude-agent"
  );
  const consumedRefs = new Set(consumableNativeArtifacts.map((item) => item.member.ref));
  const unconsumedMembers = composition.members.filter(
    (item) => item.ref !== composition.root.ref && !consumedRefs.has(item.ref)
  );

  for (const issue of artifact.validationErrors) {
    unresolved.push({
      dimension: issue.id,
      reason: issue.message,
      evidence: issue.evidence
    });
  }

  if (composition.conflicts.length) {
    for (const conflict of composition.conflicts) {
      unresolved.push({
        dimension: conflict.dimension,
        reason: "Source composition contains contradictory native declarations. Resolve them before materialization."
      });
    }
  }

  for (const item of composition.unresolved) {
    unresolved.push({
      dimension: "composition-observation",
      reason: `${item.kind}${item.ref ? ` ${item.ref}` : ""}: ${item.reason}`
    });
  }

  if (unconsumedMembers.length) {
    unresolved.push({
      dimension: "external-composition-members",
      reason:
        `The observed capability contains target-unmapped native members: ${unconsumedMembers.map((item) => item.ref).join(", ")}. ` +
        "V0 refuses to collapse them into a new target until the target adapter explicitly consumes each member."
    });
  }

  for (const nativeArtifact of consumableNativeArtifacts) {
    resolutions.push({
      dimension: "composition-member",
      source: nativeArtifact.member.path,
      target: `.codex/agents/${options.codexAgent ?? "<agent>"}.toml:developer_instructions`,
      authority: "observed-native-member",
      note: "The source custom-agent instructions are included in the target custom-agent instructions; the source file itself is not copied as if it were target-native."
    });
  }

  if (composition.runtimeRequirements.length) {
    unresolved.push({
      dimension: "source-runtime-requirements",
      reason:
        "The source composition already carries runtime requirements. V0 will not silently reinterpret or discard a previously required runtime envelope."
    });
  }

  for (const declaration of composition.declarations) {
    const unsupported = UNSUPPORTED_DIMENSIONS.get(declaration.dimension);
    if (unsupported) unresolved.push({ dimension: declaration.dimension, reason: unsupported, source: declaration.source });
  }

  if (artifact.entries.some((entry) => entry.path === "agents/openai.yaml" || entry.path === "agents/openai.yml")) {
    unresolved.push({
      dimension: "openai-metadata-merge",
      reason: "Source already contains agents/openai.yaml; V0 will not merge or overwrite existing target-native metadata."
    });
  }

  if (needsCustomAgent && !options.codexAgent) {
    unresolved.push({
      dimension: "custom-agent",
      reason: "This composition needs a Codex custom agent. Choose the target identity explicitly with --codex-agent <name>."
    });
  }

  const model = declarations.get("model-selection");
  if (model && !options.codexModel) {
    unresolved.push({
      dimension: "model-selection",
      reason: `Source requests ${formatNative(model)}. No model equivalence is assumed; choose --codex-model <model>.`
    });
  } else if (model && options.codexModel) {
    resolutions.push({
      dimension: "model-selection",
      source: formatNative(model),
      target: `.codex/agents/${options.codexAgent ?? "<agent>"}.toml:model=${options.codexModel}`,
      authority: "explicit-operator-choice"
    });
  }

  const effort = declarations.get("reasoning-effort");
  if (effort) {
    if (!CODEX_REASONING_EFFORTS.has(String(effort.value))) {
      unresolved.push({
        dimension: "reasoning-effort",
        reason: `Codex materialization does not recognize reasoning effort ${JSON.stringify(effort.value)}.`
      });
    } else {
      resolutions.push({
        dimension: "reasoning-effort",
        source: formatNative(effort),
        target: `.codex/agents/${options.codexAgent ?? "<agent>"}.toml:model_reasoning_effort=${effort.value}`,
        authority: "documented-correspondence"
      });
    }
  }

  const context = declarations.get("context-isolation");
  if (context) {
    if (context.value !== "fork") {
      unresolved.push({ dimension: "context-isolation", reason: `Only Claude context: fork is understood; received ${context.value}.` });
    } else if (options.codexAgent) {
      resolutions.push({
        dimension: "context-isolation",
        source: formatNative(context),
        target: `delegate to Codex custom agent ${options.codexAgent}`,
        authority: "documented-correspondence"
      });
    }
  }

  const agent = declarations.get("execution-agent");
  let codexSandboxMode;
  const runtimeRequirements = [];
  if (agent && options.codexAgent) {
    resolutions.push({
      dimension: "execution-agent",
      source: formatNative(agent),
      target: `Codex custom agent ${options.codexAgent}`,
      authority: "explicit-operator-choice",
      note: "This records a chosen target identity; it does not claim the source and target agent implementations are equivalent."
    });
    if (agent.value === "Explore") {
      codexSandboxMode = "read-only";
      resolutions.push({
        dimension: "sandbox-default",
        source: formatNative(agent),
        target: `.codex/agents/${options.codexAgent}.toml:sandbox_mode=read-only`,
        authority: "documented-target-default",
        note: "Claude Explore is read-only. Codex requires the delegated agent default and the parent runtime authority envelope to cooperate."
      });
      runtimeRequirements.push(readOnlyNoEscalationRequirement(await findTestedPairing("claude", "codex")));
    }
  }

  const implicit = declarations.get("implicit-invocation");
  if (implicit) {
    resolutions.push({
      dimension: "implicit-invocation",
      source: formatNative(implicit),
      target: `agents/openai.yaml:policy.allow_implicit_invocation=${implicit.value}`,
      authority: "documented-correspondence"
    });
  }

  const tools = declarations.get("preapproved-tools");
  if (tools) {
    resolutions.push({
      dimension: "preapproved-tools",
      source: formatNative(tools),
      target: needsCustomAgent ? "not materialized on delegating wrapper" : "SKILL.md:allowed-tools",
      authority: needsCustomAgent ? "safe-narrowing" : "agent-skills-portable",
      note: needsCustomAgent
        ? "Claude allowed-tools pre-approves tools; it does not restrict all other tools. V0 avoids moving that approval onto the parent wrapper because the substantive work runs in the delegated agent."
        : "The declaration is retained in the non-delegating skill; implementation support can vary."
    });
  }

  const files = plannedFiles(artifact, declarations, options, out, needsCustomAgent);
  return {
    source: {
      endpoint: sourceEndpoint,
      capability: artifact.name,
      skill: artifact.name,
      hash: artifact.hash,
      compositionHash: composition.compositionHash,
      path: artifact.rootPath
    },
    target: "codex",
    out,
    needsCustomAgent,
    choices: { codexAgent: options.codexAgent, codexModel: options.codexModel },
    codexSandboxMode,
    runtimeRequirements,
    behavior: composition.declarations,
    resolutions,
    unresolved,
    files,
    composition,
    artifact,
    declarations
  };
}

export async function applyProjection(plan, options = {}) {
  if (plan.unresolved.length) {
    throw new Error(`Materialization is unresolved:\n- ${plan.unresolved.map((item) => `${item.dimension}: ${item.reason}`).join("\n- ")}`);
  }
  assertSkillSafeForWrite(plan.artifact);

  const exists = await pathExists(plan.out);
  if (exists && !options.replace) {
    throw new Error(`${plan.out} already exists. Review it and pass --replace to authorize replacing the disposable materialization.`);
  }
  if (exists) {
    const marker = path.join(plan.out, "hix-projection.json");
    if (!(await pathExists(marker))) {
      throw new Error(`${plan.out} is not a hix materialization. Refusing to replace an unmarked directory.`);
    }
    await fs.rm(plan.out, { recursive: true, force: true });
  }

  const skillRoot = safeJoin(path.join(plan.out, ".agents", "skills"), plan.artifact.name);
  await fs.mkdir(skillRoot, { recursive: true });
  await copyNonSkillEntries(plan.artifact, skillRoot);

  const markdown = sourceMarkdown(plan.artifact);
  const sourceBody = markdownBody(markdown);
  const roundTrip = roundTripPayload(plan, sourceBody);
  const wrapper = plan.needsCustomAgent
    ? buildDelegatingSkillMarkdown(plan.artifact, plan.choices.codexAgent)
    : buildPortableSkillMarkdown(plan.artifact, sourceBody);
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), wrapper, "utf8");

  const implicit = plan.declarations.get("implicit-invocation");
  if (implicit) {
    const agentsDir = path.join(skillRoot, "agents");
    await fs.mkdir(agentsDir, { recursive: true });
    await fs.writeFile(
      path.join(agentsDir, "openai.yaml"),
      `policy:\n  allow_implicit_invocation: ${implicit.value ? "true" : "false"}\n`,
      "utf8"
    );
  }

  if (plan.needsCustomAgent) {
    const agentDir = path.join(plan.out, ".codex", "agents");
    await fs.mkdir(agentDir, { recursive: true });
    const agentFile = path.join(agentDir, `${plan.choices.codexAgent}.toml`);
    await fs.writeFile(agentFile, buildCustomAgentToml(plan, roundTrip), "utf8");
  }

  const manifest = {
    schema: "hix.projection/v1",
    source: portableSource(plan),
    target: { participant: plan.target },
    choices: plan.choices,
    resolutions: plan.resolutions,
    runtimeRequirements: plan.runtimeRequirements,
    roundTrip,
    files: portableFiles(plan),
    claims: { crossHarnessEquivalence: false }
  };
  await fs.writeFile(path.join(plan.out, "hix-projection.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function plannedFiles(artifact, declarations, options, out, needsCustomAgent) {
  const files = artifact.entries
    .filter((entry) => entry.kind !== "directory" && entry.path !== "SKILL.md" && !entry.path.startsWith("agents/openai.y"))
    .map((entry) => path.join(out, ".agents", "skills", artifact.name, entry.path));
  files.push(path.join(out, ".agents", "skills", artifact.name, "SKILL.md"));
  if (declarations.has("implicit-invocation")) {
    files.push(path.join(out, ".agents", "skills", artifact.name, "agents", "openai.yaml"));
  }
  if (needsCustomAgent && options.codexAgent) {
    files.push(path.join(out, ".codex", "agents", `${options.codexAgent}.toml`));
  }
  files.push(path.join(out, "hix-projection.json"));
  return files.sort();
}

async function copyNonSkillEntries(artifact, skillRoot) {
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

function buildDelegatingSkillMarkdown(artifact, agentName) {
  const header = portableFrontmatter(artifact, { includeAllowedTools: false });
  return `${header}\n\nDelegate the substantive work for this capability to the Codex custom agent \`${agentName}\`.\nWait for that agent to finish and return its result. Do not perform the substantive work in the parent thread. If the custom agent is unavailable, report that instead of silently changing execution behavior.\n`;
}

function buildPortableSkillMarkdown(artifact, body) {
  return `${portableFrontmatter(artifact)}\n${body.startsWith("\n") ? "" : "\n"}${body}`;
}

function portableFrontmatter(artifact, { includeAllowedTools = true } = {}) {
  const markdown = sourceMarkdown(artifact).replace(/\r\n/g, "\n");
  const lines = markdown.split("\n");
  const end = findFrontmatterEnd(lines);
  const blocks = end > 0 ? topLevelBlocks(lines.slice(1, end)) : [];
  const kept = blocks.filter((block) => PORTABLE_FRONTMATTER_KEYS.has(block.key)).flatMap((block) => block.lines);
  const allowed = artifact.frontmatter.values?.["allowed-tools"];
  if (includeAllowedTools && allowed !== undefined && allowed !== null && allowed !== "") {
    const value = Array.isArray(allowed) ? allowed.join(" ") : String(allowed);
    kept.push(`allowed-tools: ${value}`);
  }
  return `---\n${kept.join("\n")}\n---`;
}

function buildCustomAgentToml(plan, roundTrip) {
  const description = plan.artifact.frontmatter.description ?? `Materialized agent for ${plan.artifact.name}`;
  const effort = plan.declarations.get("reasoning-effort")?.value;
  const instructions = [
    `Execute the materialized ${plan.artifact.name} capability in this agent context.`,
    "Do not delegate this capability to another agent; execute it in this thread.",
    roundTrip.sourceNativeAgentInstructions || undefined,
    roundTrip.sourceCapabilityInstructions
  ].filter((item) => item !== undefined).join("\n");
  const lines = [
    `name = ${tomlString(plan.choices.codexAgent)}`,
    `description = ${tomlString(description)}`
  ];
  if (plan.choices.codexModel) lines.push(`model = ${tomlString(plan.choices.codexModel)}`);
  if (effort) lines.push(`model_reasoning_effort = ${tomlString(String(effort))}`);
  if (plan.codexSandboxMode) lines.push(`sandbox_mode = ${tomlString(plan.codexSandboxMode)}`);
  lines.push(`developer_instructions = ${tomlString(instructions)}`);
  return `${lines.join("\n")}\n`;
}

function roundTripPayload(plan, sourceBody) {
  const sourceNativeAgent = plan.composition.nativeArtifacts.find((item) => item.member.kind === "claude-agent");
  const sourceNativeAgentInstructions = sourceNativeAgent
    ? markdownBody(sourceNativeAgent.content.toString("utf8")).trim()
    : undefined;
  return {
    schema: "hix.round-trip/v1",
    sourceCapabilityInstructions: sourceBody.trim(),
    ...(sourceNativeAgentInstructions ? { sourceNativeAgentInstructions } : {})
  };
}

function readOnlyNoEscalationRequirement(pairing) {
  return {
    dimension: "authority-enforcement",
    value: "read-only-no-escalation",
    status: pairing ? "conformance-tested-structure" : "unverified",
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
      pairingId: pairing?.id,
      observedAt: pairing?.observedAt,
      participantVersions: pairing ? {
        source: pairing.source,
        target: pairing.target
      } : undefined,
      scope: pairing?.scope,
      refs: pairing?.evidence ?? [],
      runtimeExecutionTested: false
    },
    reason: "No-write delegation requires both a read-only child default and a parent runtime that cannot escalate write authority."
  };
}

function portableSource(plan) {
  return {
    endpoint: plan.source.endpoint.spec,
    participant: plan.source.endpoint.participant,
    capability: plan.source.capability,
    skill: plan.source.skill,
    hash: plan.source.hash,
    compositionHash: plan.source.compositionHash
  };
}

function portableFiles(plan) {
  return plan.files.map((file) => path.relative(plan.out, file).split(path.sep).join("/"));
}

function sourceMarkdown(artifact) {
  const entry = artifact.entries.find((item) => item.kind === "file" && item.path === "SKILL.md");
  if (!entry) throw new Error(`${artifact.name} has no SKILL.md entry.`);
  return entry.content.toString("utf8");
}

function markdownBody(markdown) {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const end = findFrontmatterEnd(lines);
  if (end < 0) return normalized;
  return lines.slice(end + 1).join("\n");
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

function validateCodexAgentName(name) {
  if (!/^[A-Za-z0-9_-]+$/.test(name) || name.length > 64) {
    throw new Error("--codex-agent must be 1-64 characters using only letters, numbers, hyphen, or underscore.");
  }
}

function formatNative(declaration) {
  const nativeValue = declaration.nativeValue ?? declaration.value;
  return `${declaration.source}=${Array.isArray(nativeValue) ? nativeValue.join(",") : String(nativeValue)}`;
}

function tomlString(value) {
  return JSON.stringify(String(value));
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
