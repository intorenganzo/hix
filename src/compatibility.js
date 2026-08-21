const OPEN_SKILL_KEYS = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);
const OPENAI_EXTENSION_FILES = new Set(["agents/openai.yaml", "agents/openai.yml"]);
const RECOGNIZED_BEHAVIOR_KEYS = new Set([
  "model",
  "effort",
  "context",
  "agent",
  "disable-model-invocation",
  "user-invocable",
  "hooks",
  "paths",
  "shell"
]);

export function analyzeTransfer(artifact, targetEndpoint) {
  const notices = artifact.warnings.map((message, index) => ({ id: `artifact-warning-${index + 1}`, severity: "notice", message }));
  const risks = [];
  const keys = artifact.frontmatter.keys;
  const nonStandard = keys.filter((key) => !OPEN_SKILL_KEYS.has(key) && !RECOGNIZED_BEHAVIOR_KEYS.has(key));
  const paths = new Set(artifact.entries.map((entry) => entry.path));
  const hasOpenAiExtension = [...OPENAI_EXTENSION_FILES].some((file) => paths.has(file));
  const hasInternalSymlinks = artifact.entries.some((entry) => entry.kind === "symlink");

  if (artifact.directoryName !== artifact.name) {
    risks.push({
      id: "directory-name-changes",
      severity: "risk",
      message: `Destination directory will be ${artifact.name}; source directory is ${artifact.directoryName}. Invocation semantics may change.`
    });
  }

  if (targetEndpoint.behavior === "open-agent-skills") {
    if (!artifact.frontmatter.name) {
      risks.push({ id: "missing-name", severity: "risk", message: "Agent Skills requires a top-level name field." });
    }
    if (!artifact.frontmatter.description) {
      risks.push({ id: "missing-description", severity: "risk", message: "Agent Skills requires a top-level description field." });
    }
    if (nonStandard.length) {
      risks.push({
        id: "nonstandard-frontmatter",
        severity: "risk",
        message: `Non-standard frontmatter may not preserve behavior in Codex: ${nonStandard.join(", ")}. Bytes will be copied unchanged.`
      });
    }
  }

  if (targetEndpoint.behavior === "claude" && hasOpenAiExtension) {
    risks.push({
      id: "openai-metadata-ignored",
      severity: "risk",
      message: "agents/openai.yaml is OpenAI-specific metadata; Claude may ignore the behavior it describes. The file will still be copied."
    });
  }

  if (targetEndpoint.behavior === "unknown") {
    if (nonStandard.length || hasOpenAiExtension) {
      risks.push({
        id: "unknown-target-compatibility",
        severity: "risk",
        message: "Target harness compatibility is unknown and this skill contains participant-specific metadata."
      });
    }
  }

  if (hasInternalSymlinks) {
    risks.push({
      id: "internal-symlink",
      severity: "risk",
      message: "Skill contains internal symlinks. They will be recreated literally and may resolve differently at the destination."
    });
  }

  return [...notices, ...risks];
}

export function summarizePortability(artifact) {
  const behaviorKeys = artifact.frontmatter.keys.filter((key) => RECOGNIZED_BEHAVIOR_KEYS.has(key));
  const nonStandard = artifact.frontmatter.keys.filter((key) => !OPEN_SKILL_KEYS.has(key) && !RECOGNIZED_BEHAVIOR_KEYS.has(key));
  const paths = new Set(artifact.entries.map((entry) => entry.path));
  const openAi = [...OPENAI_EXTENSION_FILES].some((file) => paths.has(file));
  const flags = [];
  if (behaviorKeys.length) flags.push(`behavior:${behaviorKeys.join(",")}`);
  if (nonStandard.length) flags.push(`frontmatter:${nonStandard.join(",")}`);
  if (openAi) flags.push("openai-extension");
  if (artifact.rootIsSymlink) flags.push("root-symlink");
  if (artifact.entries.some((entry) => entry.kind === "symlink")) flags.push("internal-symlink");
  return flags.length ? flags.join("; ") : "open-skill-shape";
}
