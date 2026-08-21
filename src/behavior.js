import { parseYaml } from "./formats.js";

const CLAUDE_EXECUTION_KEYS = new Set([
  "model",
  "effort",
  "context",
  "agent",
  "disable-model-invocation",
  "user-invocable",
  "allowed-tools",
  "hooks",
  "paths",
  "shell"
]);

/**
 * Extract execution behavior without inventing a universal schema. Each item
 * keeps the native declaration that produced it so future adapters can become
 * richer without changing the underlying artifact bytes.
 */
export function inspectExecutionBehavior(artifact, endpoint) {
  const declarations = [];
  const values = artifact.frontmatter.values ?? {};

  // Claude's SKILL.md extensions remain identifiable even when the artifact is
  // sitting in a neutral repository. The endpoint tells us where the bytes are;
  // the declaration tells us which native behavior vocabulary they came from.
  addScalar(declarations, "model", "model-selection", values.model, "SKILL.md:model", "claude-skill");
  addScalar(declarations, "effort", "reasoning-effort", values.effort, "SKILL.md:effort", "claude-skill");
  addScalar(declarations, "context", "context-isolation", values.context, "SKILL.md:context", "claude-skill");
  addScalar(declarations, "agent", "execution-agent", values.agent, "SKILL.md:agent", "claude-skill");

  if (values["disable-model-invocation"] !== undefined) {
    declarations.push({
      nativeFamily: "claude-skill",
      nativeKey: "disable-model-invocation",
      dimension: "implicit-invocation",
      value: values["disable-model-invocation"] !== true,
      nativeValue: values["disable-model-invocation"],
      source: "SKILL.md:disable-model-invocation"
    });
  }
  if (values["user-invocable"] !== undefined) {
    declarations.push({
      nativeFamily: "claude-skill",
      nativeKey: "user-invocable",
      dimension: "user-invocation",
      value: values["user-invocable"],
      nativeValue: values["user-invocable"],
      source: "SKILL.md:user-invocable"
    });
  }

  addScalar(
    declarations,
    "allowed-tools",
    "preapproved-tools",
    values["allowed-tools"],
    "SKILL.md:allowed-tools",
    "agent-skills"
  );
  addPresence(declarations, artifact, "hooks", "lifecycle-hooks", "SKILL.md:hooks", "claude-skill");
  addScalar(declarations, "paths", "activation-paths", values.paths, "SKILL.md:paths", "claude-skill");
  addScalar(declarations, "shell", "skill-shell", values.shell, "SKILL.md:shell", "claude-skill");

  if (hasDynamicContext(artifact)) {
    declarations.push({
      nativeFamily: "claude-skill",
      nativeKey: "dynamic-shell-context",
      dimension: "dynamic-context",
      value: true,
      nativeValue: true,
      source: "SKILL.md:!command"
    });
  }

  const openAi = parseOpenAiMetadata(artifact);
  if (openAi.allowImplicitInvocation !== undefined) {
    declarations.push({
      nativeFamily: "codex-skill",
      nativeKey: "policy.allow_implicit_invocation",
      dimension: "implicit-invocation",
      value: openAi.allowImplicitInvocation,
      nativeValue: openAi.allowImplicitInvocation,
      source: "agents/openai.yaml:policy.allow_implicit_invocation"
    });
  }
  if (openAi.hasToolDependencies) {
    declarations.push({
      nativeFamily: "codex-skill",
      nativeKey: "dependencies.tools",
      dimension: "tool-dependencies",
      value: "declared",
      nativeValue: "declared",
      source: "agents/openai.yaml:dependencies.tools"
    });
  }

  return {
    participant: endpoint.participant,
    behavior: endpoint.behavior,
    declarations,
    conflicts: detectBehaviorConflicts(declarations)
  };
}
export function analyzeBehaviorTransfer(artifact, sourceEndpoint, targetEndpoint) {
  const source = inspectExecutionBehavior(artifact, sourceEndpoint);
  return source.declarations.map((declaration) => ({
    ...declaration,
    ...correspondenceFor(declaration, sourceEndpoint, targetEndpoint)
  }));
}

export function detectBehaviorConflicts(declarations) {
  const byDimension = new Map();
  for (const declaration of declarations) {
    const values = byDimension.get(declaration.dimension) ?? [];
    values.push(declaration);
    byDimension.set(declaration.dimension, values);
  }

  const conflicts = [];
  for (const [dimension, values] of byDimension) {
    const distinct = new Set(values.map((value) => JSON.stringify(value.value)));
    if (distinct.size <= 1) continue;
    conflicts.push({
      dimension,
      declarations: values.map(({ nativeFamily, nativeKey, source, value, nativeValue }) => ({
        nativeFamily,
        nativeKey,
        source,
        value,
        nativeValue
      }))
    });
  }
  return conflicts;
}

export function behaviorKeys(artifact) {
  return artifact.frontmatter.keys.filter((key) => CLAUDE_EXECUTION_KEYS.has(key));
}

function correspondenceFor(declaration, source, target) {
  if (target.behavior === "neutral") {
    return {
      status: "preserved-declaration",
      target: "artifact bytes",
      note: "A neutral repository can preserve this native declaration without claiming to execute it."
    };
  }

  if (declaration.nativeFamily === "agent-skills") {
    return {
      status: "portable",
      target: "SKILL.md:allowed-tools",
      note: "Agent Skills defines allowed-tools as an experimental pre-approved-tools field; support can still vary by implementation."
    };
  }

  if (declaration.nativeFamily === "claude-skill" && target.behavior === "claude") {
    return {
      status: "preserved-native",
      target: declaration.source,
      note: "The target natively understands this Claude skill declaration."
    };
  }
  if (declaration.nativeFamily === "codex-skill" && target.behavior === "open-agent-skills") {
    return {
      status: "preserved-native",
      target: declaration.source,
      note: "The target natively understands this Codex skill declaration."
    };
  }

  if (declaration.nativeFamily === "claude-skill" && target.behavior === "open-agent-skills") {
    return claudeToCodex(declaration);
  }
  if (declaration.nativeFamily === "codex-skill" && target.behavior === "claude") {
    return codexToClaude(declaration);
  }

  return {
    status: "unknown-target",
    target: undefined,
    note: "No target adapter describes how this execution behavior is realized."
  };
}
function claudeToCodex(declaration) {
  switch (declaration.dimension) {
    case "implicit-invocation":
      return {
        status: "direct-native-projection",
        target: "agents/openai.yaml:policy.allow_implicit_invocation",
        note: "Codex exposes an equivalent skill invocation policy in agents/openai.yaml, but hix does not rewrite target metadata yet."
      };
    case "model-selection":
      return {
        status: "native-projection-required",
        target: ".codex/agents/<agent>.toml:model",
        note: "Codex supports per-custom-agent model selection, not a documented skill-local model field. A binding from the skill to that agent is still required."
      };
    case "reasoning-effort":
      return {
        status: "native-projection-required",
        target: ".codex/agents/<agent>.toml:model_reasoning_effort",
        note: "Codex supports per-custom-agent reasoning effort, but it is not documented as skill-local metadata."
      };
    case "context-isolation":
      return {
        status: "native-projection-required",
        target: "Codex subagent workflow",
        note: "Codex can isolate delegated work in a subagent thread; the current skill format does not provide a direct context:fork equivalent."
      };
    case "execution-agent":
      return {
        status: "native-projection-required",
        target: "Codex built-in/custom agent",
        note: "Codex has built-in and custom agents, but hix cannot assume a Claude agent name is equivalent to a Codex agent."
      };
    case "lifecycle-hooks":
      return {
        status: "native-projection-required",
        target: ".codex/hooks.json or .codex/config.toml",
        note: "Codex has lifecycle hooks, but they are configured at active config layers rather than documented as skill-scoped frontmatter."
      };
    case "user-invocation":
      return {
        status: "unmapped",
        target: undefined,
        note: "No documented Codex skill field directly matches Claude user-invocable visibility semantics."
      };
    case "activation-paths":
      return {
        status: "unmapped",
        target: undefined,
        note: "No documented Codex skill-local field directly matches Claude paths activation filters."
      };
    case "skill-shell":
      return {
        status: "unmapped",
        target: undefined,
        note: "No documented Codex skill-local shell-selection field matches Claude shell."
      };
    case "dynamic-context":
      return {
        status: "unmapped",
        target: undefined,
        note: "Claude skill shell interpolation is a preprocessing feature; no direct Codex skill-local equivalent is documented."
      };
    default:
      return { status: "unmapped", target: undefined, note: "No safe mapping is known." };
  }
}

function codexToClaude(declaration) {
  switch (declaration.dimension) {
    case "implicit-invocation":
      return {
        status: "direct-native-projection",
        target: "SKILL.md:disable-model-invocation",
        note: "Claude can represent the inverse of Codex allow_implicit_invocation directly in skill frontmatter, but hix does not rewrite frontmatter yet."
      };
    case "tool-dependencies":
      return {
        status: "unmapped",
        target: undefined,
        note: "Claude can use MCP and tools, but no documented Claude skill-local dependency manifest directly matches agents/openai.yaml dependencies.tools."
      };
    default:
      return { status: "unmapped", target: undefined, note: "No safe mapping is known." };
  }
}

function addScalar(output, nativeKey, dimension, value, source, nativeFamily) {
  if (value === undefined || value === null || value === "") return;
  output.push({ nativeFamily, nativeKey, dimension, value, nativeValue: value, source });
}

function addPresence(output, artifact, nativeKey, dimension, source, nativeFamily) {
  if (!artifact.frontmatter.keys.includes(nativeKey)) return;
  output.push({ nativeFamily, nativeKey, dimension, value: "configured", nativeValue: "configured", source });
}

function hasDynamicContext(artifact) {
  const skill = artifact.entries.find((entry) => entry.kind === "file" && entry.path === "SKILL.md");
  if (!skill) return false;
  const text = skill.content.toString("utf8");
  return /!`[^`]+`/.test(text) || /```!\s*[\s\S]*?```/.test(text);
}

function parseOpenAiMetadata(artifact) {
  const file = artifact.entries.find(
    (entry) => entry.kind === "file" && (entry.path === "agents/openai.yaml" || entry.path === "agents/openai.yml")
  );
  if (!file) return {};
  const parsed = parseYaml(file.content.toString("utf8"), file.path);
  if (parsed.errors.length || !parsed.value || typeof parsed.value !== "object") return {};
  const implicit = parsed.value.policy?.allow_implicit_invocation;
  const tools = parsed.value.dependencies?.tools;
  return {
    allowImplicitInvocation: typeof implicit === "boolean" ? implicit : undefined,
    hasToolDependencies: Array.isArray(tools) && tools.length > 0
  };
}
