import fs from "node:fs/promises";

const SUPPORT_URL = new URL("../harnesses/support.json", import.meta.url);

export async function readHarnessSupport() {
  return JSON.parse(await fs.readFile(SUPPORT_URL, "utf8"));
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
  return {
    matrix,
    participant,
    version,
    known: support.knownVersion === version || Boolean(tested),
    tested: Boolean(tested),
    testedAt: tested?.testedAt,
    observedAt: tested?.observedAt,
    evidence: tested?.evidence ?? [],
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
