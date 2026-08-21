import { parse as parseTomlDocument } from "smol-toml";
import { parseDocument as parseYamlDocument } from "yaml";

export function parseYaml(text, label = "YAML") {
  const document = parseYamlDocument(text, {
    prettyErrors: true,
    uniqueKeys: true
  });
  const errors = document.errors.map((error) => `${label}: ${error.message}`);
  if (errors.length) return { value: undefined, errors };
  return { value: document.toJS({ mapAsMap: false }), errors: [] };
}

export function parseToml(text, label = "TOML") {
  try {
    return { value: parseTomlDocument(text), errors: [] };
  } catch (error) {
    return { value: undefined, errors: [`${label}: ${error.message}`] };
  }
}

export function markdownBody(markdown) {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const end = frontmatterEnd(lines);
  if (end < 0) return normalized;
  return lines.slice(end + 1).join("\n");
}

export function frontmatterSource(markdown) {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const end = frontmatterEnd(lines);
  if (end < 0) return undefined;
  return lines.slice(1, end).join("\n");
}

export function frontmatterEnd(lines) {
  if (lines[0]?.trim() !== "---") return -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === "---") return index;
  }
  return -1;
}

export function stringList(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string");
  if (typeof value === "string" && value.trim()) return value.split(/[ ,]+/).filter(Boolean);
  return [];
}
