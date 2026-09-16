import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyReview, planReview } from "../src/review.js";
import { applyMaterialization, planMaterialization } from "../src/materialize.js";

// A hand-rolled validator for a deliberately small slice of JSON Schema
// draft 2020-12. The slice is a contract in both directions: schemas may only
// use these keywords, and any keyword outside the slice aborts the run instead
// of being ignored, so an unsupported constraint can never look like a pass.
const SUPPORTED_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "oneOf",
  "anyOf",
  "pattern",
  "minimum",
  "minItems"
]);
const ANNOTATION_KEYWORDS = new Set(["$schema", "$id", "title", "description"]);
const TYPE_NAMES = new Set(["null", "boolean", "integer", "number", "string", "array", "object"]);

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const schemaDir = path.join(repoRoot, "schemas");

// Optional fields are the part of a wire format a sample set stops covering
// first, and a schema is only as strong as the shapes it was actually held
// against. Each generated sample records which of these it demonstrated, and
// the run fails if the set ever stops being demonstrated.
const REQUIRED_COVERAGE = [
  "projection/target=codex",
  "projection/target=claude",
  "projection/source.capability",
  "projection/runtime-requirements",
  "projection/no-runtime-requirements",
  "projection/operator-choices",
  "projection/no-operator-choices",
  "round-trip/native-agent-instructions",
  "round-trip/capability-instructions-only",
  "review/claude-agent-subject",
  "review/codex-agent-subject",
  "review/agent-permission-mode",
  "review/agent-sandbox-mode",
  "review/missing-preloaded-skill",
  "review/blocked-subject",
  "review/composition-members"
];
const covered = new Set();

selfCheck();

const schemas = await loadSchemas();
const failures = [];
const work = await fs.mkdtemp(path.join(os.tmpdir(), "hix-schema-check-"));
let checked = 0;

try {
  await checkGeneratedReviews();
  await checkGeneratedProjections();
  await checkCheckedInDocuments();
} finally {
  await fs.rm(work, { recursive: true, force: true });
}

for (const required of REQUIRED_COVERAGE) {
  if (!covered.has(required)) {
    failures.push(`sample coverage: no generated document demonstrated ${required}, so that shape went unchecked`);
  }
}

if (failures.length) {
  console.error(`Wire format validation failed with ${failures.length} error(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Wire formats valid: ${checked} document(s) checked against ${schemas.size} schema(s), ` +
    `covering ${REQUIRED_COVERAGE.length} optional-shape variants.`
);

// --- sample generation against the real code paths ------------------------

async function checkGeneratedReviews() {
  const claudeHome = path.join(work, "claude-review-home");
  const claudeSkills = path.join(claudeHome, ".claude", "skills");
  await writeSkill(
    claudeSkills,
    "deep-review",
    "---\nname: deep-review\ndescription: Review deeply and report evidence.\nmodel: source-model\neffort: ultra\ncontext: fork\nagent: reviewer\nallowed-tools: Read Grep\n---\n\nReview carefully and cite evidence.\n"
  );
  await writeSkill(
    claudeSkills,
    "coding-standards",
    "---\nname: coding-standards\ndescription: Shared coding standards.\n---\n\nApply the standards.\n"
  );
  await fs.mkdir(path.join(claudeHome, ".claude", "agents"), { recursive: true });
  await fs.writeFile(
    path.join(claudeHome, ".claude", "agents", "reviewer.md"),
    "---\nname: reviewer\ndescription: Read-only reviewer.\nmodel: source-model\neffort: high\npermissionMode: bypassPermissions\ntools: Read, Grep\nskills:\n  - coding-standards\n  - absent-standards\n---\n\nReview carefully and cite evidence.\n",
    "utf8"
  );
  await checkReviewOutput("claude:user", { home: claudeHome });

  const codexHome = path.join(work, "codex-review-home");
  await writeSkill(
    path.join(codexHome, ".agents", "skills"),
    "review",
    "---\nname: review\ndescription: Review an implementation.\n---\n\nReview the implementation.\n"
  );
  await fs.mkdir(path.join(codexHome, ".codex", "agents"), { recursive: true });
  await fs.writeFile(
    path.join(codexHome, ".codex", "agents", "reviewer.toml"),
    'name = "reviewer"\ndescription = "Review agent"\nmodel = "target-model"\nmodel_reasoning_effort = "high"\nsandbox_mode = "read-only"\ndeveloper_instructions = "Review carefully."\n',
    "utf8"
  );
  await fs.writeFile(
    path.join(codexHome, ".codex", "agents", "builder.toml"),
    'name = "builder"\nmodel_reasoning_effort = "ludicrous"\nsandbox_mode = "workspace-write"\ndeveloper_instructions = "Implement changes."\n',
    "utf8"
  );
  await checkReviewOutput("codex:user", { home: codexHome });
}

async function checkReviewOutput(spec, options) {
  const plan = await planReview(spec, {}, options);
  await applyReview(plan);
  const report = await checkJsonFile(path.join(plan.root, "review.json"), "hix.review/v2");

  // The aggregate report embeds whole subjects, so hold each embedded copy to
  // the same subject schema as the standalone file it was written to.
  for (const subject of report.skills) check(subject, "hix.skill-review/v1", `${spec} review.json#/skills/${subject.id}`);
  for (const subject of report.agents) check(subject, "hix.agent-review/v1", `${spec} review.json#/agents/${subject.id}`);
  for (const subject of report.capabilities) {
    check(subject, subject.schema, `${spec} review.json#/capabilities/${subject.id}`);
  }

  for (const [dir, schema] of [["skills", "hix.skill-review/v1"], ["agents", "hix.agent-review/v1"]]) {
    for (const entry of await fs.readdir(path.join(plan.root, dir))) {
      if (!entry.endsWith(".json")) continue;
      await checkJsonFile(path.join(plan.root, dir, entry), schema);
    }
  }

  for (const subject of report.capabilities) {
    if (subject.status === "blocked") covered.add("review/blocked-subject");
    if (subject.permissionMode) covered.add("review/agent-permission-mode");
    if (subject.sandboxMode) covered.add("review/agent-sandbox-mode");
    if (subject.kind === "agent") covered.add(`review/${subject.participant}-agent-subject`);
    if ((subject.members ?? []).length > 1) covered.add("review/composition-members");
    if ((subject.preloadedSkills ?? []).some((item) => item.status === "missing")) {
      covered.add("review/missing-preloaded-skill");
    }
  }
}

async function checkGeneratedProjections() {
  // A composed Claude capability: model choice, reasoning effort, delegation to
  // a read-only agent, and an invocation policy. Exercises resolutions,
  // runtime requirements, and both round-trip instruction fields.
  const composed = path.join(work, "composed");
  // The source is laid out as a real Claude environment so the referenced agent
  // is discovered as a composition member rather than dangling.
  const composedSource = path.join(composed, ".claude", "skills");
  const codexBundle = path.join(composed, "codex-bundle");
  const claudeBundle = path.join(composed, "claude-bundle");
  await writeSkill(
    composedSource,
    "deep-review",
    "---\nname: deep-review\ndescription: Review deeply with evidence.\nmodel: source-model\neffort: high\ncontext: fork\nagent: Explore\ndisable-model-invocation: true\nallowed-tools: Read Grep\n---\n\nReview carefully. Do not modify anything.\n",
    { "references/checklist.md": "Check behavior.\n" }
  );
  await fs.mkdir(path.join(composed, ".claude", "agents"), { recursive: true });
  await fs.writeFile(
    path.join(composed, ".claude", "agents", "Explore.md"),
    "---\nname: Explore\ndescription: Read-only reviewer.\neffort: high\n---\n\nInspect the repository and cite evidence. Do not edit.\n",
    "utf8"
  );

  const codexPlan = await planMaterialization(
    "claude:composed",
    "codex",
    { names: ["deep-review"] },
    {
      home: composed,
      out: codexBundle,
      codexAgent: "deep-review",
      codexModel: "target-model",
      endpointRoots: new Map([["claude:composed", composedSource]])
    }
  );
  assertResolved(codexPlan, "claude:composed -> codex");
  await applyMaterialization(codexPlan);
  await checkProjectionManifest(codexBundle, "claude:composed -> codex");

  const codexBundleRoots = new Map([["codex:bundle", path.join(codexBundle, ".agents", "skills")]]);
  const claudePlan = await planMaterialization(
    "codex:bundle",
    "claude",
    { names: ["deep-review"] },
    {
      home: composed,
      out: claudeBundle,
      claudeAgent: "deep-review",
      claudeModel: "target-claude-model",
      endpointRoots: codexBundleRoots
    }
  );
  assertResolved(claudePlan, "codex:bundle -> claude");
  await applyMaterialization(claudePlan);
  await checkProjectionManifest(claudeBundle, "codex:bundle -> claude");

  // A portable capability with no agent member: no operator choices, no runtime
  // requirements, and no native agent instructions in the round trip.
  const portable = path.join(work, "portable");
  const portableSource = path.join(portable, "source");
  await writeSkill(
    portableSource,
    "simple",
    "---\nname: simple\ndescription: Do one simple thing.\n---\n\nDo the simple thing.\n"
  );
  const portableCodexPlan = await planMaterialization(
    "fs:portable",
    "codex",
    { names: ["simple"] },
    { home: portable, out: path.join(portable, "codex-bundle"), endpointRoots: new Map([["fs:portable", portableSource]]) }
  );
  assertResolved(portableCodexPlan, "fs:portable -> codex");
  await applyMaterialization(portableCodexPlan);
  await checkProjectionManifest(path.join(portable, "codex-bundle"), "fs:portable -> codex");

  const codexSkills = path.join(work, "codex-native");
  await writeSkill(
    codexSkills,
    "manual-review",
    "---\nname: manual-review\ndescription: Run a manual review.\n---\n\nReview when explicitly invoked.\n",
    { "agents/openai.yaml": "policy:\n  allow_implicit_invocation: false\n" }
  );
  const portableClaudePlan = await planMaterialization(
    "codex:native",
    "claude",
    { names: ["manual-review"] },
    { home: work, out: path.join(work, "claude-native"), endpointRoots: new Map([["codex:native", codexSkills]]) }
  );
  assertResolved(portableClaudePlan, "codex:native -> claude");
  await applyMaterialization(portableClaudePlan);
  await checkProjectionManifest(path.join(work, "claude-native"), "codex:native -> claude");
}

async function checkProjectionManifest(out, label) {
  const manifest = await checkJsonFile(path.join(out, "hix-projection.json"), "hix.projection/v1");
  check(manifest.roundTrip, "hix.round-trip/v1", `${label} hix-projection.json#/roundTrip`);

  covered.add(`projection/target=${manifest.target.participant}`);
  if (manifest.source.capability !== undefined) covered.add("projection/source.capability");
  covered.add(manifest.runtimeRequirements.length ? "projection/runtime-requirements" : "projection/no-runtime-requirements");
  covered.add(Object.keys(manifest.choices).length ? "projection/operator-choices" : "projection/no-operator-choices");
  covered.add(manifest.roundTrip.sourceNativeAgentInstructions === undefined
    ? "round-trip/capability-instructions-only"
    : "round-trip/native-agent-instructions");
  return manifest;
}

async function checkCheckedInDocuments() {
  await checkJsonFile(path.join(repoRoot, "harnesses", "support.json"), "hix.harness-support/v1");
  const conformanceDir = path.join(repoRoot, "docs", "conformance");
  const entries = (await fs.readdir(conformanceDir)).filter((entry) => entry.endsWith(".json")).sort();
  if (!entries.length) throw new Error(`No conformance reports found in ${conformanceDir}.`);
  for (const entry of entries) {
    await checkJsonFile(path.join(conformanceDir, entry), "hix.live-conformance/v1");
  }
}

function assertResolved(plan, label) {
  if (!plan.unresolved.length) return;
  throw new Error(
    `Sample generation for ${label} did not resolve, so no manifest could be produced:\n- ` +
      plan.unresolved.map((item) => `${item.dimension}: ${item.reason}`).join("\n- ")
  );
}

async function writeSkill(root, name, markdown, extras = {}) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), markdown, "utf8");
  for (const [file, content] of Object.entries(extras)) {
    const target = path.join(dir, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
}

// --- checking -------------------------------------------------------------

async function checkJsonFile(file, schemaTag) {
  const raw = await fs.readFile(file, "utf8");
  const value = JSON.parse(raw);
  check(value, schemaTag, path.relative(repoRoot, file));
  return value;
}

function check(value, schemaTag, label) {
  const schema = schemas.get(schemaTag);
  if (!schema) throw new Error(`${label}: no schema is published for ${schemaTag}.`);
  checked += 1;
  const errors = [];
  validate(schema.document, value, "", errors);
  for (const error of errors) failures.push(`${label} [${schemaTag}] ${error}`);
}

async function loadSchemas() {
  const loaded = new Map();
  const files = (await fs.readdir(schemaDir)).filter((entry) => entry.endsWith(".schema.json")).sort();
  if (!files.length) throw new Error(`No schemas found in ${schemaDir}.`);
  for (const file of files) {
    const document = JSON.parse(await fs.readFile(path.join(schemaDir, file), "utf8"));
    assertSupported(document, "", file);
    const tag = document.properties?.schema?.const;
    if (typeof tag !== "string") {
      throw new Error(`${file}: schema document must pin its wire tag with properties.schema.const.`);
    }
    if (loaded.has(tag)) throw new Error(`${file}: duplicate schema tag ${tag}.`);
    loaded.set(tag, { file, document });
  }
  return loaded;
}

// --- the supported subset -------------------------------------------------

function assertSupported(schema, pointer, file) {
  const at = `${file}#${pointer || "/"}`;
  if (!isPlainObject(schema)) throw new Error(`${at}: a schema must be an object.`);
  for (const keyword of Object.keys(schema)) {
    if (ANNOTATION_KEYWORDS.has(keyword) || SUPPORTED_KEYWORDS.has(keyword)) continue;
    throw new Error(
      `${at}: unsupported schema keyword ${JSON.stringify(keyword)}. ` +
        `This validator implements only: ${[...SUPPORTED_KEYWORDS].join(", ")}.`
    );
  }
  if ("type" in schema && !TYPE_NAMES.has(schema.type)) {
    throw new Error(`${at}: "type" must be one of ${[...TYPE_NAMES].join(", ")}; got ${JSON.stringify(schema.type)}.`);
  }
  if ("required" in schema && !(Array.isArray(schema.required) && schema.required.every((item) => typeof item === "string"))) {
    throw new Error(`${at}: "required" must be an array of property names.`);
  }
  if ("enum" in schema && !(Array.isArray(schema.enum) && schema.enum.length)) {
    throw new Error(`${at}: "enum" must be a non-empty array.`);
  }
  if ("pattern" in schema) new RegExp(schema.pattern);
  for (const keyword of ["minimum", "minItems"]) {
    if (keyword in schema && typeof schema[keyword] !== "number") throw new Error(`${at}: "${keyword}" must be a number.`);
  }
  if ("properties" in schema) {
    if (!isPlainObject(schema.properties)) throw new Error(`${at}: "properties" must be an object.`);
    for (const [key, sub] of Object.entries(schema.properties)) assertSupported(sub, `${pointer}/properties/${key}`, file);
  }
  if ("items" in schema) assertSupported(schema.items, `${pointer}/items`, file);
  if ("additionalProperties" in schema && typeof schema.additionalProperties !== "boolean") {
    assertSupported(schema.additionalProperties, `${pointer}/additionalProperties`, file);
  }
  for (const keyword of ["oneOf", "anyOf"]) {
    if (!(keyword in schema)) continue;
    if (!(Array.isArray(schema[keyword]) && schema[keyword].length)) throw new Error(`${at}: "${keyword}" must be a non-empty array.`);
    schema[keyword].forEach((sub, index) => assertSupported(sub, `${pointer}/${keyword}/${index}`, file));
  }
}

function validate(schema, value, pointer, errors) {
  const at = pointer || "/";
  if ("type" in schema && !matchesType(schema.type, value)) {
    // Reporting downstream keyword failures on a wrongly typed value would bury
    // the one error that explains them, so stop here.
    errors.push(`${at}: expected ${schema.type}, got ${typeNameOf(value)}`);
    return;
  }
  if ("const" in schema && !sameJson(value, schema.const)) {
    errors.push(`${at}: expected the constant ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }
  if ("enum" in schema && !schema.enum.some((candidate) => sameJson(value, candidate))) {
    errors.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if ("pattern" in schema && typeof value === "string" && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${at}: ${JSON.stringify(value)} does not match ${JSON.stringify(schema.pattern)}`);
  }
  if ("minimum" in schema && typeof value === "number" && value < schema.minimum) {
    errors.push(`${at}: ${value} is below the minimum ${schema.minimum}`);
  }
  if (Array.isArray(value)) {
    if ("minItems" in schema && value.length < schema.minItems) {
      errors.push(`${at}: expected at least ${schema.minItems} item(s), got ${value.length}`);
    }
    if ("items" in schema) value.forEach((item, index) => validate(schema.items, item, `${pointer}/${index}`, errors));
  }
  if (isPlainObject(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${at}: missing required property ${JSON.stringify(key)}`);
    }
    const properties = schema.properties ?? {};
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        validate(properties[key], item, `${pointer}/${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${pointer}/${key}: property is not permitted by the schema`);
      } else if (isPlainObject(schema.additionalProperties)) {
        validate(schema.additionalProperties, item, `${pointer}/${key}`, errors);
      }
    }
  }
  for (const keyword of ["oneOf", "anyOf"]) {
    if (!(keyword in schema)) continue;
    const passing = schema[keyword].filter((sub) => {
      const branchErrors = [];
      validate(sub, value, pointer, branchErrors);
      return branchErrors.length === 0;
    }).length;
    if (keyword === "anyOf" && passing === 0) errors.push(`${at}: matches none of the anyOf branches`);
    if (keyword === "oneOf" && passing !== 1) errors.push(`${at}: matches ${passing} oneOf branches, expected exactly 1`);
  }
}

function matchesType(type, value) {
  if (type === "integer") return Number.isInteger(value);
  return typeNameOf(value) === type || (type === "number" && typeNameOf(value) === "integer");
}

function typeNameOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Prove the validator rejects what it claims to reject before any real
// document is judged by it. A validator that silently passes everything would
// otherwise be indistinguishable from a clean run.
function selfCheck() {
  const cases = [
    [{ type: "string" }, "ok", true],
    [{ type: "string" }, 1, false],
    [{ type: "integer", minimum: 0 }, -1, false],
    [{ type: "integer" }, 1.5, false],
    [{ type: "number" }, 1, true],
    [{ type: "array", minItems: 1 }, [], false],
    [{ type: "array", items: { type: "string" } }, ["a", 2], false],
    [{ const: false }, false, true],
    [{ const: false }, true, false],
    [{ enum: ["a", "b"] }, "c", false],
    [{ type: "string", pattern: "^[a-f0-9]{4}$" }, "beef", true],
    [{ type: "string", pattern: "^[a-f0-9]{4}$" }, "beefy", false],
    [{ type: "object", required: ["a"] }, {}, false],
    [{ type: "object", properties: { a: { type: "string" } }, additionalProperties: false }, { b: 1 }, false],
    [{ type: "object", additionalProperties: { type: "string" } }, { b: 1 }, false],
    [{ anyOf: [{ type: "string" }, { type: "integer" }] }, true, false],
    [{ anyOf: [{ type: "string" }, { type: "integer" }] }, 3, true],
    [{ oneOf: [{ type: "integer" }, { type: "number" }] }, 3, false],
    [{ oneOf: [{ type: "string" }, { type: "integer" }] }, "a", true]
  ];
  for (const [schema, value, expected] of cases) {
    const errors = [];
    validate(schema, value, "", errors);
    if ((errors.length === 0) !== expected) {
      throw new Error(
        `Validator self-check failed for ${JSON.stringify(schema)} against ${JSON.stringify(value)}: ` +
          `expected ${expected ? "valid" : "invalid"}, got ${errors.length ? errors.join("; ") : "valid"}.`
      );
    }
  }

  let rejected = false;
  try {
    assertSupported({ type: "integer", multipleOf: 2 }, "", "self-check");
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("Validator self-check failed: an unimplemented schema keyword was accepted.");
}
