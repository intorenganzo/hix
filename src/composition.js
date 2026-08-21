import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { detectBehaviorConflicts, inspectExecutionBehavior } from "./behavior.js";
import { parseToml } from "./formats.js";
import { inspectSkillFrontmatter } from "./frontmatter.js";

export async function observeComposedCapability(artifact, endpoint) {
  const behavior = inspectExecutionBehavior(artifact, endpoint);
  const declarations = [...behavior.declarations];
  const members = [
    {
      ref: `skill:${artifact.name}`,
      kind: "agent-skill",
      hash: artifact.hash,
      entries: artifact.entries.length
    }
  ];
  const relations = [];
  const evidence = [];
  const runtimeRequirements = [];
  const unresolved = [];
  const nativeArtifacts = [];

  const nativeAgent = behavior.declarations.find((item) => item.dimension === "execution-agent");
  if (nativeAgent) {
    const agentRef = `${endpoint.participant || "native"}-agent:${String(nativeAgent.value)}`;
    relations.push({
      kind: "executes-via",
      from: `skill:${artifact.name}`,
      to: agentRef,
      status: "native-reference",
      evidence: nativeAgent.source
    });
    const nativeName = String(nativeAgent.value);
    const external = isSafeNativeAgentName(nativeName)
      ? await readNativeAgentMember(endpoint, nativeName)
      : undefined;
    if (!isSafeNativeAgentName(nativeName)) {
      unresolved.push({
        kind: "invalid-native-member-reference",
        ref: nativeName,
        reason: "Native agent references must be a simple 1-64 character identifier and cannot contain path separators."
      });
    }
    if (external) {
      members.push(external.member);
      evidence.push(external.evidence);
      nativeArtifacts.push(external);
      relations[relations.length - 1] = {
        ...relations[relations.length - 1],
        status: "observed-native-member",
        evidence: external.member.path
      };
      if (endpoint.participant === "claude") {
        declarations.push(...parseClaudeAgentDeclarations(external.content, external.member.path));
      } else if (endpoint.participant === "codex") {
        declarations.push(...parseCodexAgentDeclarations(external.content, external.member.path));
      }
    }
  }

  const projection = await readProjectionEvidence(endpoint, artifact.name);
  if (projection) {
    evidence.push({
      kind: "hix-projection-manifest",
      schema: projection.manifest.schema,
      ref: "hix-projection.json",
      hash: projection.hash
    });
    for (const requirement of projection.manifest.runtimeRequirements ?? []) {
      runtimeRequirements.push(requirement);
    }

    const agentName = projection.manifest.choices?.codexAgent;
    if (endpoint.participant === "codex" && agentName) {
      if (!isSafeNativeAgentName(String(agentName))) {
        unresolved.push({
          kind: "invalid-projection-member-reference",
          ref: String(agentName),
          reason: "Projection manifest custom-agent references must be simple 1-64 character identifiers."
        });
      } else {
        const agentRelative = `.codex/agents/${agentName}.toml`;
        const agent = await readProjectionMember(projection.root, agentRelative, `codex-agent:${agentName}`, "codex-agent");
        if (agent) {
          addMember(members, agent.member);
          addNativeArtifact(nativeArtifacts, agent);
          evidence.push(agent.evidence);
          addRelation(relations, {
            kind: "executes-via",
            from: `skill:${artifact.name}`,
            to: `codex-agent:${agentName}`,
            status: "recorded-projection",
            evidence: "hix-projection.json:choices.codexAgent"
          });
          declarations.push(...parseCodexAgentDeclarations(agent.content, agentRelative));
        } else {
          unresolved.push({
            kind: "missing-native-member",
            ref: agentRelative,
            reason: "Projection manifest records a custom agent but the referenced native artifact is absent."
          });
        }
      }
    }
  }

  const conflicts = detectBehaviorConflicts(declarations);
  const composition = {
    kind: "observed-composed-capability",
    id: artifact.name,
    endpoint: {
      spec: endpoint.spec,
      participant: endpoint.participant,
      behavior: endpoint.behavior
    },
    root: {
      ref: `skill:${artifact.name}`,
      hash: artifact.hash
    },
    members: sortByRef(members),
    declarations: sortDeclarations(declarations),
    relations: sortRelations(relations),
    runtimeRequirements,
    evidence: sortEvidence(evidence),
    conflicts,
    unresolved
  };

  return {
    ...composition,
    compositionHash: hashComposition(composition),
    artifact,
    nativeArtifacts,
    projection: projection ? { root: projection.root, manifest: projection.manifest } : undefined
  };
}

export function serializeObservedComposition(composition) {
  return {
    schema: "hix.observed-composition/v1",
    kind: composition.kind,
    id: composition.id,
    endpoint: composition.endpoint,
    root: composition.root,
    compositionHash: composition.compositionHash,
    members: composition.members,
    declarations: composition.declarations,
    relations: composition.relations,
    runtimeRequirements: composition.runtimeRequirements,
    evidence: composition.evidence,
    conflicts: composition.conflicts,
    unresolved: composition.unresolved
  };
}

async function readNativeAgentMember(endpoint, agentName) {
  const agentRoot = endpoint.nativeRoots?.agents;
  if (!agentRoot) return undefined;
  const extension = endpoint.participant === "claude" ? ".md" : endpoint.participant === "codex" ? ".toml" : undefined;
  if (!extension) return undefined;
  const relative = endpoint.participant === "claude"
    ? `.claude/agents/${agentName}${extension}`
    : `.codex/agents/${agentName}${extension}`;
  const absolute = path.join(agentRoot, `${agentName}${extension}`);
  return readExternalFile(absolute, relative, `${endpoint.participant}-agent:${agentName}`, `${endpoint.participant}-agent`);
}

async function readProjectionEvidence(endpoint, skillName) {
  const roots = projectionRootCandidates(endpoint);
  for (const root of roots) {
    const candidate = path.join(root, "hix-projection.json");
    const content = await readFileIfPresent(candidate);
    if (!content) continue;
    let manifest;
    try {
      manifest = JSON.parse(content.toString("utf8"));
    } catch {
      continue;
    }
    if (manifest?.schema !== "hix.projection/v1") continue;
    if (manifest?.target?.participant !== endpoint.participant) continue;
    const expectedSkill = endpoint.participant === "claude"
      ? `.claude/skills/${skillName}/SKILL.md`
      : `.agents/skills/${skillName}/SKILL.md`;
    if (!(manifest.files ?? []).includes(expectedSkill)) continue;
    return { root, manifest, hash: sha256(content) };
  }
  return undefined;
}

function projectionRootCandidates(endpoint) {
  const candidates = [];
  if (endpoint.environmentRoot) candidates.push(endpoint.environmentRoot);
  if (endpoint.root) {
    const normalized = path.resolve(endpoint.root);
    if (normalized.endsWith(path.join(".agents", "skills"))) candidates.push(path.resolve(normalized, "..", ".."));
    if (normalized.endsWith(path.join(".claude", "skills"))) candidates.push(path.resolve(normalized, "..", ".."));
  }
  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

async function readProjectionMember(root, relative, ref, kind) {
  return readExternalFile(path.join(root, relative), relative, ref, kind);
}

async function readExternalFile(absolute, relative, ref, kind) {
  const content = await readFileIfPresent(absolute);
  if (!content) return undefined;
  const hash = sha256(content);
  return {
    member: { ref, kind, path: portablePath(relative), hash },
    evidence: { kind: "native-artifact", ref, path: portablePath(relative), hash },
    absolutePath: absolute,
    content
  };
}

function parseClaudeAgentDeclarations(content, source) {
  const frontmatter = inspectSkillFrontmatter(content.toString("utf8"), source);
  const output = [];
  addNativeScalar(output, "claude-agent", "model", "model-selection", frontmatter.values?.model, source);
  addNativeScalar(output, "claude-agent", "effort", "reasoning-effort", frontmatter.values?.effort, source);
  return output;
}

function parseCodexAgentDeclarations(content, source) {
  const text = content.toString("utf8");
  const parsed = parseToml(text, source);
  if (parsed.errors.length) return [];
  const output = [];
  addNativeScalar(output, "codex-agent", "model", "model-selection", parsed.value.model, source);
  addNativeScalar(output, "codex-agent", "model_reasoning_effort", "reasoning-effort", parsed.value.model_reasoning_effort, source);
  addNativeScalar(output, "codex-agent", "sandbox_mode", "sandbox-mode", parsed.value.sandbox_mode, source);
  return output;
}

function addNativeScalar(output, nativeFamily, nativeKey, dimension, value, source) {
  if (value === undefined || value === null || value === "") return;
  output.push({
    nativeFamily,
    nativeKey,
    dimension,
    value,
    nativeValue: value,
    source: `${source}:${nativeKey}`
  });
}

function hashComposition(composition) {
  const stable = {
    kind: composition.kind,
    id: composition.id,
    endpoint: { participant: composition.endpoint.participant, behavior: composition.endpoint.behavior },
    root: composition.root,
    members: composition.members,
    declarations: composition.declarations,
    relations: composition.relations,
    runtimeRequirements: composition.runtimeRequirements,
    conflicts: composition.conflicts,
    unresolved: composition.unresolved
  };
  return sha256(Buffer.from(JSON.stringify(stable), "utf8"));
}

function sortDeclarations(values) {
  return [...values].sort((a, b) => declarationKey(a).localeCompare(declarationKey(b)));
}

function declarationKey(value) {
  return `${value.dimension}\0${value.source}\0${JSON.stringify(value.value)}`;
}

function sortRelations(values) {
  return [...values].sort((a, b) => `${a.kind}\0${a.from}\0${a.to}`.localeCompare(`${b.kind}\0${b.from}\0${b.to}`));
}

function sortEvidence(values) {
  return [...values].sort((a, b) => `${a.kind}\0${a.ref ?? ""}`.localeCompare(`${b.kind}\0${b.ref ?? ""}`));
}

function sortByRef(values) {
  return [...values].sort((a, b) => a.ref.localeCompare(b.ref));
}

function addMember(values, member) {
  if (!values.some((item) => item.ref === member.ref)) values.push(member);
}

function addNativeArtifact(values, artifact) {
  if (!values.some((item) => item.member.ref === artifact.member.ref)) values.push(artifact);
}

function addRelation(values, relation) {
  const existing = values.find((item) => item.kind === relation.kind && item.from === relation.from && item.to === relation.to);
  if (!existing) {
    values.push(relation);
    return;
  }
  if (relation.status === "recorded-projection") Object.assign(existing, relation);
}

async function readFileIfPresent(candidate) {
  try {
    return await fs.readFile(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function portablePath(value) {
  return value.split(path.sep).join("/");
}

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function isSafeNativeAgentName(value) {
  return /^[A-Za-z0-9_-]{1,64}$/.test(value);
}
