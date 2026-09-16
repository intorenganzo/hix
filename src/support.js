import fs from "node:fs/promises";

const SUPPORT_URL = new URL("../harnesses/support.json", import.meta.url);

export async function readHarnessSupport() {
  return JSON.parse(await fs.readFile(SUPPORT_URL, "utf8"));
}

// Numeric dotted-version comparison; hix records exact upstream versions only.
export function compareVersions(a, b) {
  const left = String(a).split(".").map(Number);
  const right = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (Number.isNaN(l) || Number.isNaN(r)) return NaN;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

// A reviewed range is a claim, not test evidence: both endpoints are explicit,
// the lower endpoint has conformance evidence, and the interior is covered by a
// recorded upstream delta review showing no HIX-relevant surface changed.
export function findReviewedRange(support, version) {
  return (support?.reviewedRanges ?? []).find((range) =>
    compareVersions(range.from, version) <= 0 && compareVersions(version, range.to) <= 0
  );
}

export async function inspectHarnessSupport(participant, version) {
  const matrix = await readHarnessSupport();
  if (!participant) return { matrix };

  const support = matrix.participants?.[participant];
  if (!support) {
    throw new Error(`Unknown participant ${participant}. Known participants: ${Object.keys(matrix.participants ?? {}).join(", ")}.`);
  }

  if (!version) return { matrix, participant, support };

  const tested = (support.testedVersions ?? []).find((item) => item.version === version);
  const reviewedRange = findReviewedRange(support, version);
  return {
    matrix,
    participant,
    version,
    known: support.knownVersion === version || Boolean(tested) || Boolean(reviewedRange),
    tested: Boolean(tested),
    reviewed: Boolean(reviewedRange),
    reviewedRange: reviewedRange ?? null,
    testedAt: tested?.testedAt,
    observedAt: tested?.observedAt,
    evidence: tested?.evidence ?? (reviewedRange?.evidence ?? []),
    knownVersion: support.knownVersion,
    knownVersionSource: support.knownVersionSource
  };
}

export async function findTestedPairing(sourceParticipant, targetParticipant) {
  const matrix = await readHarnessSupport();
  return (matrix.testedPairings ?? []).find((pairing) =>
    pairing.source?.participant === sourceParticipant && pairing.target?.participant === targetParticipant
  );
}
