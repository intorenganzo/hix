import { frontmatterSource, parseYaml } from "./formats.js";

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function inspectSkillFrontmatter(markdown, label = "SKILL.md") {
  const source = frontmatterSource(markdown);
  if (source === undefined) return emptyFrontmatter();

  const parsed = parseYaml(source, `${label} frontmatter`);
  if (parsed.errors.length) {
    return {
      ...emptyFrontmatter(),
      hasFrontmatter: true,
      parseErrors: parsed.errors
    };
  }

  const values = isPlainObject(parsed.value) ? parsed.value : {};
  const keys = Object.keys(values);
  return {
    keys,
    values,
    nestedKeys: keys.filter((key) => isPlainObject(values[key])),
    name: nonEmptyString(values.name),
    description: nonEmptyString(values.description),
    hasFrontmatter: true,
    parseErrors: isPlainObject(parsed.value) ? [] : [`${label} frontmatter must be a YAML mapping.`]
  };
}

export function validateAgentSkillFrontmatter(frontmatter, directoryName) {
  const errors = [];
  for (const message of frontmatter.parseErrors ?? []) {
    errors.push(issue("agent-skills-invalid-yaml", message));
  }
  if (!frontmatter.hasFrontmatter) {
    errors.push(issue("agent-skills-frontmatter-required", "SKILL.md must start with YAML frontmatter."));
  }

  const values = frontmatter.values ?? {};
  validateRequiredString(errors, values, "name", 64);
  validateRequiredString(errors, values, "description", 1024);

  if (typeof values.name === "string") {
    if (!SKILL_NAME.test(values.name) || values.name.length > 64) {
      errors.push(issue(
        "agent-skills-invalid-name",
        "Skill name must be 1-64 lowercase letters, numbers, or hyphens, with no leading, trailing, or consecutive hyphens.",
        [`name:${JSON.stringify(values.name)}`]
      ));
    }
    if (values.name !== directoryName) {
      errors.push(issue(
        "agent-skills-name-directory-mismatch",
        `Skill name ${JSON.stringify(values.name)} must match its parent directory ${JSON.stringify(directoryName)}.`,
        [`name:${values.name}`, `directory:${directoryName}`]
      ));
    }
  }

  validateOptionalString(errors, values, "license");
  validateOptionalString(errors, values, "compatibility", 500, 1);
  if (values.metadata !== undefined) {
    if (!isPlainObject(values.metadata) || Object.values(values.metadata).some((value) => typeof value !== "string")) {
      errors.push(issue("agent-skills-invalid-metadata", "metadata must be a YAML mapping whose keys and values are strings."));
    }
  }
  if (values["allowed-tools"] !== undefined && typeof values["allowed-tools"] !== "string") {
    errors.push(issue(
      "agent-skills-invalid-allowed-tools",
      "allowed-tools must be a space-separated string under the Agent Skills specification."
    ));
  }
  return errors;
}

export function assertValidSkillName(name) {
  if (typeof name !== "string" || name.length > 64 || !SKILL_NAME.test(name)) {
    throw new Error(`Unsafe or invalid Agent Skills name: ${JSON.stringify(name)}.`);
  }
}

function validateRequiredString(errors, values, key, max) {
  if (typeof values[key] !== "string" || !values[key].trim()) {
    errors.push(issue(`agent-skills-${key}-required`, `${key} is required and must be a non-empty string.`));
    return;
  }
  if (values[key].length > max) {
    errors.push(issue(`agent-skills-${key}-too-long`, `${key} must be at most ${max} characters.`));
  }
}

function validateOptionalString(errors, values, key, max, min = 0) {
  if (values[key] === undefined) return;
  if (typeof values[key] !== "string" || values[key].length < min || (max && values[key].length > max)) {
    const range = max ? `a ${min}-${max} character` : "a";
    errors.push(issue(`agent-skills-invalid-${key}`, `${key} must be ${range} string.`));
  }
}

function emptyFrontmatter() {
  return {
    keys: [],
    values: {},
    nestedKeys: [],
    name: undefined,
    description: undefined,
    hasFrontmatter: false,
    parseErrors: []
  };
}

function issue(id, message, evidence = []) {
  return { id, message, evidence };
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
