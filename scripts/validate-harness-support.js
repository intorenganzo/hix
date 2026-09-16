import fs from "node:fs/promises";

const root = new URL("../", import.meta.url);
const support = JSON.parse(await fs.readFile(new URL("harnesses/support.json", root), "utf8"));
const pkg = JSON.parse(await fs.readFile(new URL("package.json", root), "utf8"));
const errors = [];

if (support.schema !== "hix.harness-support/v1") errors.push("support schema must be hix.harness-support/v1");
if (support.hixVersion !== pkg.version) errors.push(`hixVersion ${support.hixVersion} does not match package version ${pkg.version}`);

const participants = support.participants ?? {};
if (!Object.keys(participants).length) errors.push("at least one participant is required");

for (const [name, participant] of Object.entries(participants)) {
  if (!participant.product) errors.push(`${name}: product is required`);
  if (!participant.knownVersion) errors.push(`${name}: knownVersion is required`);
  if (!isHttpUrl(participant.knownVersionSource)) errors.push(`${name}: knownVersionSource must be an http(s) URL`);
  if (!Array.isArray(participant.testedVersions)) errors.push(`${name}: testedVersions must be an array`);

  const seen = new Set();
  for (const test of participant.testedVersions ?? []) {
    if (!test.version) errors.push(`${name}: tested version entry requires version`);
    if (seen.has(test.version)) errors.push(`${name}: duplicate tested version ${test.version}`);
    seen.add(test.version);
    if (!test.testedAt || !/^\d{4}-\d{2}-\d{2}$/.test(test.testedAt)) errors.push(`${name}@${test.version}: testedAt must be YYYY-MM-DD`);
    if (!isTimestamp(test.observedAt)) errors.push(`${name}@${test.version}: observedAt must be an exact ISO-8601 timestamp`);
    if (!Array.isArray(test.evidence) || !test.evidence.length) errors.push(`${name}@${test.version}: evidence must contain at least one test artifact or command record`);
    await validateEvidence(test.evidence, `${name}@${test.version}`);
    if (test.releaseTag && !test.releaseTag.includes(test.version)) errors.push(`${name}@${test.version}: releaseTag must include the tested participant version`);
  }

  if (participant.reviewedRanges !== undefined && !Array.isArray(participant.reviewedRanges)) {
    errors.push(`${name}: reviewedRanges must be an array when present`);
  }
  for (const range of Array.isArray(participant.reviewedRanges) ? participant.reviewedRanges : []) {
    const label = `${name}@${range.from ?? "?"}-${range.to ?? "?"}`;
    if (!range.from || !range.to) errors.push(`${label}: reviewed range requires from and to`);
    if (range.from && range.to && compareVersions(range.from, range.to) > 0) errors.push(`${label}: from must not exceed to`);
    if (range.from && !seen.has(range.from)) errors.push(`${label}: range lower endpoint must be a tested version — a reviewed range is anchored in conformance evidence`);
    if (!range.reviewedAt || !/^\d{4}-\d{2}-\d{2}$/.test(range.reviewedAt)) errors.push(`${label}: reviewedAt must be YYYY-MM-DD`);
    if (!Array.isArray(range.evidence) || !range.evidence.length) errors.push(`${label}: evidence must contain at least one recorded delta review`);
    await validateEvidence(range.evidence, label);
  }
}

if (!Array.isArray(support.testedPairings)) errors.push("testedPairings must be an array");
const pairingIds = new Set();
for (const pairing of support.testedPairings ?? []) {
  if (!pairing.id) errors.push("pairing: stable id is required");
  if (pairingIds.has(pairing.id)) errors.push(`pairing: duplicate id ${pairing.id}`);
  pairingIds.add(pairing.id);
  if (!pairing.testedAt || !/^\d{4}-\d{2}-\d{2}$/.test(pairing.testedAt)) errors.push("pairing: testedAt must be YYYY-MM-DD");
  if (!isTimestamp(pairing.observedAt)) errors.push(`${pairing.id ?? "pairing"}: observedAt must be an exact ISO-8601 timestamp`);
  if (!pairing.source?.participant || !pairing.source?.version) errors.push("pairing: source participant and version are required");
  if (!pairing.target?.participant || !pairing.target?.version) errors.push("pairing: target participant and version are required");
  if (pairing.source?.participant && !participants[pairing.source.participant]) errors.push(`pairing: unknown source participant ${pairing.source.participant}`);
  if (pairing.target?.participant && !participants[pairing.target.participant]) errors.push(`pairing: unknown target participant ${pairing.target.participant}`);
  if (!Array.isArray(pairing.evidence) || !pairing.evidence.length) errors.push("pairing: evidence must contain at least one conformance artifact or command record");
  await validateEvidence(pairing.evidence, pairing.id ?? "pairing");
  if (pairing.source?.participant && pairing.source?.version && !isTestedVersion(pairing.source)) {
    errors.push(`${pairing.id ?? "pairing"}: source exact version is not recorded in participant testedVersions`);
  }
  if (pairing.target?.participant && pairing.target?.version && !isTestedVersion(pairing.target)) {
    errors.push(`${pairing.id ?? "pairing"}: target exact version is not recorded in participant testedVersions`);
  }
  if (pairing.releaseTag) {
    if (!pairing.releaseTag.includes(pairing.source?.version ?? "")) errors.push("pairing: releaseTag must include source version");
    if (!pairing.releaseTag.includes(pairing.target?.version ?? "")) errors.push("pairing: releaseTag must include target version");
  }
}

if (errors.length) {
  console.error("Harness support metadata is invalid:\n- " + errors.join("\n- "));
  process.exitCode = 1;
} else {
  console.log(`Harness support metadata valid for HIX ${support.hixVersion}.`);
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isTimestamp(value) {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value));
}

function isTestedVersion(ref) {
  return (participants[ref.participant]?.testedVersions ?? []).some((item) => item.version === ref.version);
}

function compareVersions(a, b) {
  const left = String(a).split(".").map(Number);
  const right = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

async function validateEvidence(values, subject) {
  for (const value of values ?? []) {
    if (isHttpUrl(value)) continue;
    const relative = String(value).split("#", 1)[0];
    try {
      await fs.stat(new URL(relative, root));
    } catch {
      errors.push(`${subject}: evidence path does not exist: ${value}`);
    }
  }
}
