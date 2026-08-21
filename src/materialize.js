import { planProjection as planCodexMaterialization, applyProjection as applyCodexMaterialization } from "./project.js";
import { planClaudeMaterialization, applyClaudeMaterialization } from "./materialize-claude.js";

const CLAUDE_READ_ONLY_TOOLS = ["Read", "Glob", "Grep"];

export async function planMaterialization(sourceSpec, target, selection, options = {}) {
  let plan;
  if (target === "codex") plan = await planCodexMaterialization(sourceSpec, target, selection, options);
  else if (target === "claude") plan = await planClaudeMaterialization(sourceSpec, selection, options);
  else throw new Error(`Unsupported materialization target ${target}. Supported targets: codex, claude.`);

  plan.source.capability ??= plan.source.skill;
  if (plan.target === "claude" && plan.claudePermissionMode === "plan") hardenClaudeReadOnlyPlan(plan);
  return plan;
}

export async function applyMaterialization(plan, options = {}) {
  if (plan.target === "codex") return applyCodexMaterialization(plan, options);
  if (plan.target === "claude") return applyClaudeMaterialization(plan, options);
  throw new Error(`Unsupported materialization target ${plan.target}.`);
}

function hardenClaudeReadOnlyPlan(plan) {
  for (const requirement of plan.runtimeRequirements ?? []) {
    if (requirement.dimension !== "authority-enforcement" || requirement.value !== "read-only-no-escalation") continue;
    requirement.configuration ??= {};
    requirement.configuration.agent = {
      ...(requirement.configuration.agent ?? {}),
      tools: [...CLAUDE_READ_ONLY_TOOLS]
    };
    requirement.configuration.parent = {
      ...(requirement.configuration.parent ?? {}),
      disallowedPermissionModes: ["bypassPermissions", "acceptEdits", "auto"]
    };
    requirement.evidence = {
      ...(requirement.evidence ?? {}),
      assertion: "read-only-tool-allowlist-plus-plan-mode-prevents-write-capability"
    };
    requirement.reason =
      "Claude plan mode is paired with a read-only tool allowlist so the delegated agent has no Write, Edit, Bash, or MCP tool surface to widen. " +
      "Permissive parent modes are still recorded as disallowed because Claude documents parent permission precedence for several modes.";
  }
}
