import assert from "node:assert/strict";
import test from "node:test";
import { validateAgentSkillFrontmatter, inspectSkillFrontmatter } from "../src/frontmatter.js";

function frontmatter(fields) {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`);
  const markdown = `---\n${lines.join("\n")}\n---\n\nDo the thing.\n`;
  return inspectSkillFrontmatter(markdown);
}

function issueIds(errors) {
  return errors.map((error) => error.id);
}

test("café-tools is rejected (deliberate ASCII-only name divergence from the reference validator)", () => {
  const fm = frontmatter({ name: "café-tools", description: "Use for café-tools." });
  const errors = validateAgentSkillFrontmatter(fm, "café-tools");
  assert.ok(issueIds(errors).includes("agent-skills-invalid-name"));
});

test("composed (NFC) Unicode name is rejected", () => {
  const name = "café-tools"; // é as a single composed code point
  const fm = frontmatter({ name, description: "Use for this." });
  const errors = validateAgentSkillFrontmatter(fm, name);
  assert.ok(issueIds(errors).includes("agent-skills-invalid-name"));
});

test("decomposed (NFD) Unicode name is rejected", () => {
  const name = "café-tools"; // e + combining acute accent
  const fm = frontmatter({ name, description: "Use for this." });
  const errors = validateAgentSkillFrontmatter(fm, name);
  assert.ok(issueIds(errors).includes("agent-skills-invalid-name"));
});

test("uppercase name is rejected", () => {
  const fm = frontmatter({ name: "Tools", description: "Use for tools." });
  const errors = validateAgentSkillFrontmatter(fm, "Tools");
  assert.ok(issueIds(errors).includes("agent-skills-invalid-name"));
});

test("leading hyphen name is rejected", () => {
  const fm = frontmatter({ name: "-tools", description: "Use for tools." });
  const errors = validateAgentSkillFrontmatter(fm, "-tools");
  assert.ok(issueIds(errors).includes("agent-skills-invalid-name"));
});

test("trailing hyphen name is rejected", () => {
  const fm = frontmatter({ name: "tools-", description: "Use for tools." });
  const errors = validateAgentSkillFrontmatter(fm, "tools-");
  assert.ok(issueIds(errors).includes("agent-skills-invalid-name"));
});

test("consecutive hyphens in name are rejected", () => {
  const fm = frontmatter({ name: "my--tools", description: "Use for tools." });
  const errors = validateAgentSkillFrontmatter(fm, "my--tools");
  assert.ok(issueIds(errors).includes("agent-skills-invalid-name"));
});

test("valid name is accepted with no name issues", () => {
  const fm = frontmatter({ name: "my-tools2", description: "Use for tools." });
  const errors = validateAgentSkillFrontmatter(fm, "my-tools2");
  assert.ok(!issueIds(errors).includes("agent-skills-invalid-name"));
  assert.ok(!issueIds(errors).includes("agent-skills-name-directory-mismatch"));
});

test("name/directory mismatch produces agent-skills-name-directory-mismatch", () => {
  const fm = frontmatter({ name: "my-tools", description: "Use for tools." });
  const errors = validateAgentSkillFrontmatter(fm, "other-directory");
  assert.ok(issueIds(errors).includes("agent-skills-name-directory-mismatch"));
});

test("metadata with a non-string value produces agent-skills-invalid-metadata", () => {
  const markdown = "---\nname: my-tools\ndescription: Use for tools.\nmetadata:\n  version: 1\n---\n\nDo the thing.\n";
  const fm = inspectSkillFrontmatter(markdown);
  const errors = validateAgentSkillFrontmatter(fm, "my-tools");
  assert.ok(issueIds(errors).includes("agent-skills-invalid-metadata"));
});

test("empty compatibility string produces agent-skills-invalid-compatibility", () => {
  const markdown = "---\nname: my-tools\ndescription: Use for tools.\ncompatibility: \"\"\n---\n\nDo the thing.\n";
  const fm = inspectSkillFrontmatter(markdown);
  const errors = validateAgentSkillFrontmatter(fm, "my-tools");
  assert.ok(issueIds(errors).includes("agent-skills-invalid-compatibility"));
});
