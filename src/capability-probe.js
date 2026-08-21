import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SCHEMA = "hix.capability-probe/v1";

// A probe observes what an installed harness exposes. It never invokes a model,
// never executes work, and never writes. Structural observation only: a version
// string, published command/flag surfaces, and on-disk footprints that show
// whether a documented capability has ever actually been used here.
//
// Evidence strength follows the three-level vocabulary already used for harness
// observations: documented (vendor says so), observed (this install exposes it),
// corroborated (exercised in a runtime probe). Nothing here reaches
// corroborated, because corroboration requires execution this module refuses.
const PROBE_TARGETS = {
  claude: {
    product: "Claude Code",
    command: "claude",
    versionArgs: ["--version"],
    versionPattern: /([0-9]+\.[0-9]+\.[0-9]+)/,
    surfaces: [
      { id: "cli", args: ["--help"] },
      { id: "agents", args: ["agents", "--help"] }
    ],
    markers: [
      { id: "structured-output", surface: "cli", match: "--json-schema", meaning: "constrains model output to a supplied schema" },
      { id: "tool-allowlist", surface: "cli", match: "--allowedTools", meaning: "restricts callable tools for a session" },
      { id: "permission-mode", surface: "cli", match: "--permission-mode", meaning: "selects a permission posture for a session" },
      { id: "directory-scope", surface: "cli", match: "--add-dir", meaning: "bounds filesystem access to named directories" },
      { id: "inline-agent-definition", surface: "cli", match: "--agents", meaning: "defines custom agents without installed files" },
      { id: "background-agent", surface: "cli", match: "--background", meaning: "detaches a session as a background agent" },
      { id: "session-persistence-toggle", surface: "cli", match: "--no-session-persistence", meaning: "disables session persistence explicitly" },
      { id: "cloud-session", surface: "cli", match: "--cloud", meaning: "runs a session server-side" },
      { id: "agent-registry-json", surface: "agents", match: "--json", meaning: "machine-readable listing of live sessions" }
    ],
    footprints: [
      {
        id: "agent-teams-state",
        segments: [".claude", "tasks"],
        meaning: "shared task state written by Agent Teams; absence means the capability has never run here"
      },
      {
        id: "user-settings",
        segments: [".claude", "settings.json"],
        meaning: "user settings that may enable or disable customizations"
      }
    ]
  },
  codex: {
    product: "Codex CLI",
    command: "codex",
    versionArgs: ["--version"],
    versionPattern: /([0-9]+\.[0-9]+\.[0-9]+)/,
    surfaces: [
      { id: "cli", args: ["--help"] },
      { id: "exec", args: ["exec", "--help"] },
      { id: "exec-server", args: ["exec-server", "--help"] }
    ],
    markers: [
      { id: "structured-output", surface: "exec", match: "--output-schema", meaning: "constrains model output to a supplied schema" },
      { id: "sandbox-flag", surface: "exec", match: "--sandbox", meaning: "bounds filesystem and network authority for one run" },
      { id: "sandbox-command", surface: "cli", match: "sandbox", meaning: "runs an arbitrary command inside the harness sandbox" },
      { id: "noninteractive-exec", surface: "cli", match: "exec", meaning: "runs non-interactively" },
      { id: "session-resume", surface: "cli", match: "resume", meaning: "resumes a previous session" },
      { id: "session-fork", surface: "cli", match: "fork", meaning: "forks a previous session" },
      { id: "session-archive", surface: "cli", match: "archive", meaning: "archives a saved session" },
      { id: "cloud-tasks", surface: "cli", match: "cloud", meaning: "submits and collects server-side tasks" },
      { id: "admission-control", surface: "exec-server", match: "--concurrent-requests", meaning: "caps concurrent requests per connection" },
      { id: "mcp", surface: "cli", match: "mcp", meaning: "manages external MCP servers" }
    ],
    footprints: [
      {
        id: "user-config",
        segments: [".codex", "config.toml"],
        meaning: "user configuration that may enable or disable features"
      },
      {
        id: "sessions",
        segments: [".codex", "sessions"],
        meaning: "saved session state; absence means no session has been persisted here"
      }
    ]
  }
};

export function knownProbeParticipants() {
  return Object.keys(PROBE_TARGETS);
}

export async function probeHarness(participant, options = {}) {
  const target = PROBE_TARGETS[participant];
  if (!target) {
    throw new Error(
      `Unknown probe participant ${participant}. Known participants: ${knownProbeParticipants().join(", ")}.`
    );
  }

  const capture = options.captureSurface ?? defaultCaptureSurface;
  const home = path.resolve(options.home ?? os.homedir());
  const observedAt = options.observedAt ?? new Date().toISOString();

  const version = readVersion(target, capture);
  const surfaces = new Map();
  for (const surface of target.surfaces) {
    surfaces.set(surface.id, capture(target.command, surface.args));
  }

  return {
    schema: SCHEMA,
    participant,
    product: target.product,
    observedAt,
    installed: version.installed,
    version: version.value,
    versionError: version.error,
    surfaces: target.surfaces.map((surface) => ({
      id: surface.id,
      captured: typeof surfaces.get(surface.id) === "string"
    })),
    markers: target.markers.map((marker) => resolveMarker(marker, surfaces)),
    footprints: await Promise.all(target.footprints.map((footprint) => resolveFootprint(footprint, home))),
    claims: { runtimeExecutionTested: false, modelInvoked: false }
  };
}

export async function probeHarnesses(participants, options = {}) {
  const selected = participants?.length ? participants : knownProbeParticipants();
  const probes = [];
  for (const participant of selected) {
    probes.push(await probeHarness(participant, options));
  }
  return { schema: SCHEMA, observedAt: options.observedAt ?? new Date().toISOString(), probes };
}

// Drift is reported, never repaired. The support matrix is an adopted record;
// a probe only proposes that it has fallen behind the installed harness.
export function compareProbeToSupport(probe, matrix) {
  const findings = [];
  const support = matrix?.participants?.[probe.participant];

  if (!support) {
    findings.push({
      id: "probe-participant-unrecorded",
      participant: probe.participant,
      severity: "attention",
      message: `${probe.participant} is installed but absent from the support matrix.`
    });
    return findings;
  }

  if (!probe.installed) {
    findings.push({
      id: "probe-harness-unavailable",
      participant: probe.participant,
      severity: "note",
      message: `${probe.participant} is recorded in the support matrix but is not installed here.`
    });
    return findings;
  }

  if (support.knownVersion !== probe.version) {
    findings.push({
      id: "probe-known-version-drift",
      participant: probe.participant,
      severity: "attention",
      message: `Installed ${probe.participant} is ${probe.version}; the support matrix records ${support.knownVersion} as known.`
    });
  }

  const tested = (support.testedVersions ?? []).some((item) => item.version === probe.version);
  if (!tested) {
    findings.push({
      id: "probe-installed-version-untested",
      participant: probe.participant,
      severity: "attention",
      message: `Installed ${probe.participant} ${probe.version} has no recorded conformance evidence.`
    });
  }

  for (const marker of probe.markers) {
    if (marker.evidence === "unavailable") {
      findings.push({
        id: "probe-surface-uncaptured",
        participant: probe.participant,
        severity: "note",
        message: `Could not capture the ${marker.surface} surface, so ${marker.id} is unverified rather than absent.`
      });
    }
  }

  return findings;
}

export function summarizeProbe(probe) {
  const observed = probe.markers.filter((marker) => marker.evidence === "observed");
  const absent = probe.markers.filter((marker) => marker.evidence === "absent");
  const unverified = probe.markers.filter((marker) => marker.evidence === "unavailable");
  return {
    participant: probe.participant,
    version: probe.version,
    installed: probe.installed,
    observed: observed.map((marker) => marker.id),
    absent: absent.map((marker) => marker.id),
    unverified: unverified.map((marker) => marker.id),
    footprintsPresent: probe.footprints.filter((item) => item.present).map((item) => item.id),
    footprintsAbsent: probe.footprints.filter((item) => !item.present).map((item) => item.id)
  };
}

function resolveMarker(marker, surfaces) {
  const text = surfaces.get(marker.surface);
  if (typeof text !== "string") {
    return { ...marker, evidence: "unavailable" };
  }
  return { ...marker, evidence: text.includes(marker.match) ? "observed" : "absent" };
}

async function resolveFootprint(footprint, home) {
  const target = path.join(home, ...footprint.segments);
  try {
    await fs.stat(target);
    return { ...footprint, path: target, present: true, evidence: "observed" };
  } catch {
    return { ...footprint, path: target, present: false, evidence: "absent" };
  }
}

function readVersion(target, capture) {
  const output = capture(target.command, target.versionArgs);
  if (typeof output !== "string") {
    return { installed: false, value: undefined, error: "command-unavailable" };
  }
  const match = target.versionPattern.exec(output);
  if (!match) {
    return { installed: true, value: undefined, error: "unparsed-version" };
  }
  return { installed: true, value: match[1], error: undefined };
}

function defaultCaptureSurface(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    // A harness that is absent, or a subcommand this version does not publish,
    // is an observation rather than a failure. Some CLIs also write help to
    // stderr and exit non-zero, so recover whatever was captured.
    const recovered = typeof error?.stdout === "string" && error.stdout ? error.stdout : error?.stderr;
    return typeof recovered === "string" && recovered ? recovered : undefined;
  }
}
