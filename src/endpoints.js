import os from "node:os";
import path from "node:path";

export async function resolveEndpoint(spec, options = {}) {
  const override = options.endpointRoots?.get(spec);
  const [participant, rawScope] = splitSpec(spec);
  const scope = rawScope || defaultScope(participant);

  if (override) {
    const root = path.resolve(expandHome(override, options.home));
    const environmentRoot = inferEnvironmentRoot(participant, root);
    return {
      spec,
      participant,
      scope,
      root,
      environmentRoot,
      nativeRoots: nativeRootsFor(participant, environmentRoot),
      behavior: behaviorFor(participant),
      overridden: true
    };
  }

  const home = path.resolve(options.home ?? os.homedir());
  const project = path.resolve(options.project ?? process.cwd());

  if (participant === "claude" && scope === "user") {
    return endpoint(spec, participant, scope, home, path.join(home, ".claude", "skills"), "claude");
  }
  if (participant === "claude" && scope === "project") {
    return endpoint(spec, participant, scope, project, path.join(project, ".claude", "skills"), "claude");
  }
  if (participant === "codex" && scope === "user") {
    return endpoint(spec, participant, scope, home, path.join(home, ".agents", "skills"), "open-agent-skills");
  }
  if (participant === "codex" && scope === "project") {
    return endpoint(spec, participant, scope, project, path.join(project, ".agents", "skills"), "open-agent-skills");
  }
  if (participant === "codex" && scope === "legacy") {
    return endpoint(spec, participant, scope, home, path.join(home, ".codex", "skills"), "open-agent-skills");
  }

  throw new Error(
    `Unknown endpoint ${spec}. Built-ins are claude:user, claude:project, codex:user, codex:project, and codex:legacy. ` +
      `Bind any other endpoint explicitly with --endpoint-root ${spec}=/path/to/skills; use fs:<label> for neutral filesystem endpoints.`
  );
}

export function parseEndpointRootOverrides(values = []) {
  const result = new Map();
  for (const value of values) {
    const index = value.indexOf("=");
    if (index <= 0 || index === value.length - 1) throw new Error(`Invalid --endpoint-root value: ${value}`);
    result.set(value.slice(0, index), value.slice(index + 1));
  }
  return result;
}

function splitSpec(spec) {
  const index = spec.indexOf(":");
  return index < 0 ? [spec, ""] : [spec.slice(0, index), spec.slice(index + 1)];
}

function defaultScope(participant) {
  if (participant === "claude" || participant === "codex") return "user";
  return "default";
}

function endpoint(spec, participant, scope, environmentRoot, root, behavior) {
  return {
    spec,
    participant,
    scope,
    root,
    environmentRoot,
    nativeRoots: nativeRootsFor(participant, environmentRoot),
    behavior,
    overridden: false
  };
}

function behaviorFor(participant) {
  if (participant === "claude") return "claude";
  if (participant === "codex") return "open-agent-skills";
  if (participant === "fs") return "neutral";
  return "unknown";
}

function nativeRootsFor(participant, environmentRoot) {
  if (!environmentRoot) return {};
  if (participant === "claude") {
    return { agents: path.join(environmentRoot, ".claude", "agents") };
  }
  if (participant === "codex") {
    return { agents: path.join(environmentRoot, ".codex", "agents") };
  }
  return {};
}

function inferEnvironmentRoot(participant, root) {
  const resolved = path.resolve(root);
  if (participant === "claude" && resolved.endsWith(path.join(".claude", "skills"))) {
    return path.resolve(resolved, "..", "..");
  }
  if (participant === "codex" && (
    resolved.endsWith(path.join(".agents", "skills")) ||
    resolved.endsWith(path.join(".codex", "skills"))
  )) {
    return path.resolve(resolved, "..", "..");
  }
  return undefined;
}

function expandHome(input, homeOverride) {
  const home = path.resolve(homeOverride ?? os.homedir());
  if (input === "~") return home;
  if (input.startsWith("~/")) return path.join(home, input.slice(2));
  return input;
}
