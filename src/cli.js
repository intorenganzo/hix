#!/usr/bin/env node
import path from "node:path";
import { inspectEndpoint, inspectBehavior, inspectCompositions, diffEndpoints, planTransfer, applyTransfer } from "./core.js";
import { serializeObservedComposition } from "./composition.js";
import { parseEndpointRootOverrides } from "./endpoints.js";
import { summarizePortability } from "./compatibility.js";
import { planMaterialization, applyMaterialization } from "./materialize.js";
import { planReview, applyReview } from "./review.js";
import { inspectHarnessSupport, readHarnessSupport } from "./support.js";
import { compareProbeToSupport, knownProbeParticipants, probeHarnesses, summarizeProbe } from "./capability-probe.js";

async function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.help || !parsed.command) return printHelp();

  const options = {
    home: parsed.home,
    project: parsed.project,
    endpointRoots: parseEndpointRootOverrides(parsed.endpointRoot),
    replace: parsed.replace,
    allowedRisks: parsed.allowRisk,
    out: parsed.out,
    codexAgent: parsed.codexAgent,
    codexModel: parsed.codexModel,
    claudeAgent: parsed.claudeAgent,
    claudeModel: parsed.claudeModel,
    claudeEffort: parsed.claudeEffort
  };
  if (parsed.apply && parsed.check) throw new Error("--check is a dry-run/inspection mode and cannot be combined with --apply.");

  if (parsed.command === "support") {
    if (parsed.positionals.length > 2) throw new Error("support expects at most <participant> [version].");
    const result = await inspectHarnessSupport(parsed.positionals[0], parsed.positionals[1]);
    parsed.json ? printJson(result) : printSupport(result);
    strictExit(parsed, supportFailedCheck(result));
    return;
  }

  if (parsed.command === "probe") {
    for (const participant of parsed.positionals) {
      if (!knownProbeParticipants().includes(participant)) {
        throw new Error(`Unknown probe participant ${participant}. Known participants: ${knownProbeParticipants().join(", ")}.`);
      }
    }
    const result = await probeHarnesses(parsed.positionals, { home: parsed.home });
    const matrix = await readHarnessSupport();
    const findings = result.probes.flatMap((probe) => compareProbeToSupport(probe, matrix));
    parsed.json ? printJson({ ...result, findings }) : printProbe(result, findings);
    strictExit(parsed, findings.some((finding) => finding.severity === "attention"));
    return;
  }

  if (parsed.command === "inspect") {
    requirePositionals(parsed, 1);
    const result = await inspectEndpoint(parsed.positionals[0], options);
    parsed.json ? printJson(serializeInspection(result)) : printInspection(result);
    strictExit(parsed, result.skills.some((skill) => skill.validationErrors.length));
    return;
  }

  if (parsed.command === "behavior") {
    requirePositionals(parsed, 1);
    const result = await inspectBehavior(parsed.positionals[0], parsed.skill, options);
    parsed.json ? printJson(serializeBehavior(result)) : printBehavior(result);
    strictExit(parsed, result.skills.some((item) => item.artifact.validationErrors.length || item.behavior.conflicts.length));
    return;
  }

  if (parsed.command === "compose") {
    requirePositionals(parsed, 1);
    const result = await inspectCompositions(parsed.positionals[0], parsed.skill, options);
    parsed.json ? printJson(serializeCompositions(result)) : printCompositions(result);
    strictExit(parsed, result.compositions.some((item) => item.artifact.validationErrors.length || item.unresolved.length || item.conflicts.length));
    return;
  }

  if (parsed.command === "review" || parsed.command === "evaluate") {
    requirePositionals(parsed, 1);
    const plan = await planReview(
      parsed.positionals[0],
      { all: parsed.all, names: parsed.skill },
      options
    );
    if (parsed.json && !parsed.apply) printJson(plan.report);
    else printReview(plan);
    if (!parsed.apply) {
      if (!parsed.json) console.log("\nNo review files written. Re-run with --apply to write the .hix review package.");
      strictExit(parsed, plan.report.summary.blocked > 0 || plan.report.summary["needs-review"] > 0);
      return;
    }
    const result = await applyReview(plan, { replace: parsed.replace });
    if (parsed.json) return printJson(result);
    console.log(`\nReview package written to ${result.root}`);
    return;
  }

  if (parsed.command === "diff") {
    requirePositionals(parsed, 2);
    const result = await diffEndpoints(parsed.positionals[0], parsed.positionals[1], options);
    parsed.json ? printJson(serializeDiff(result)) : printDiff(result);
    strictExit(parsed, result.differences.some((item) => item.status !== "equal"));
    return;
  }

  if (parsed.command === "project" || parsed.command === "materialize") {
    requirePositionals(parsed, 2);
    const plan = await planMaterialization(
      parsed.positionals[0],
      parsed.positionals[1],
      { names: parsed.skill },
      options
    );
    if (parsed.json && !parsed.apply) printJson(serializeProjection(plan));
    else printProjection(plan);
    if (!parsed.apply) {
      if (!parsed.json) console.log("\nNo files written. Re-run with --apply only after all required choices are resolved.");
      strictExit(parsed, plan.unresolved.length > 0);
      return;
    }
    const result = await applyMaterialization(plan, options);
    if (parsed.json) return printJson(result);
    console.log(`\nMaterialized to ${plan.out}`);
    return;
  }

  if (parsed.command === "transfer") {
    requirePositionals(parsed, 2);
    const plan = await planTransfer(
      parsed.positionals[0],
      parsed.positionals[1],
      { all: parsed.all, names: parsed.skill },
      options
    );
    if (parsed.json && !parsed.apply) printJson(serializePlan(plan));
    else printPlan(plan);
    if (!parsed.apply) {
      if (!parsed.json) console.log("\nNo changes applied. Re-run with --apply after reviewing the direction and risks.");
      strictExit(parsed, plan.plans.some((item) => item.blockers.length));
      return;
    }
    const results = await applyTransfer(plan, options);
    if (parsed.json) return printJson(results);
    console.log("\nApplied:");
    for (const result of results) console.log(`  ${result.name}: ${result.action} -> ${result.path}`);
    return;
  }

  throw new Error(`Unknown command: ${parsed.command}`);
}

function parseArgs(argv) {
  const out = {
    command: undefined,
    positionals: [],
    skill: [],
    endpointRoot: [],
    all: false,
    apply: false,
    replace: false,
    allowRisk: [],
    check: false,
    json: false,
    help: false,
    home: undefined,
    project: undefined,
    out: undefined,
    codexAgent: undefined,
    codexModel: undefined,
    claudeAgent: undefined,
    claudeModel: undefined,
    claudeEffort: undefined
  };

  const args = [...argv];
  if (args[0] === "--help" || args[0] === "-h") {
    out.help = true;
    args.shift();
  } else {
    out.command = args.shift();
  }
  while (args.length) {
    const arg = args.shift();
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--all") out.all = true;
    else if (arg === "--apply") out.apply = true;
    else if (arg === "--replace") out.replace = true;
    else if (arg === "--allow-lossy") {
      throw new Error("--allow-lossy has been removed. Accept each reported risk explicitly with --allow-risk <id>.");
    }
    else if (arg === "--allow-risk") out.allowRisk.push(requireValue(args, arg));
    else if (arg === "--check") out.check = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--skill") out.skill.push(requireValue(args, arg));
    else if (arg === "--endpoint-root") out.endpointRoot.push(requireValue(args, arg));
    else if (arg === "--home") out.home = requireValue(args, arg);
    else if (arg === "--project") out.project = requireValue(args, arg);
    else if (arg === "--out") out.out = requireValue(args, arg);
    else if (arg === "--codex-agent") out.codexAgent = requireValue(args, arg);
    else if (arg === "--codex-model") out.codexModel = requireValue(args, arg);
    else if (arg === "--claude-agent") out.claudeAgent = requireValue(args, arg);
    else if (arg === "--claude-model") out.claudeModel = requireValue(args, arg);
    else if (arg === "--claude-effort") out.claudeEffort = requireValue(args, arg);
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else out.positionals.push(arg);
  }
  return out;
}

function requireValue(args, flag) {
  const value = args.shift();
  if (!value) throw new Error(`${flag} requires a value.`);
  return value;
}

function requirePositionals(parsed, count) {
  if (parsed.positionals.length !== count) {
    throw new Error(`${parsed.command} expects ${count} endpoint argument${count === 1 ? "" : "s"}.`);
  }
}

function printSupport(result) {
  if (!result.participant) {
    console.log(`HIX ${result.matrix.hixVersion}`);
    for (const [name, support] of Object.entries(result.matrix.participants ?? {})) {
      const tested = (support.testedVersions ?? []).map((item) => item.version).join(", ") || "none";
      const reviewed = (support.reviewedRanges ?? []).map((range) => `${range.from}-${range.to}`).join(", ");
      console.log(`  ${name.padEnd(8)} known ${support.knownVersion} · tested ${tested}${reviewed ? ` · reviewed ${reviewed}` : ""}`);
    }
    if ((result.matrix.testedPairings ?? []).length) console.log(`  tested pairings: ${result.matrix.testedPairings.length}`);
    return;
  }

  if (!result.version) {
    console.log(`${result.support.product} (${result.participant})`);
    console.log(`  known version:  ${result.support.knownVersion}`);
    const tested = result.support.testedVersions ?? [];
    console.log(`  tested versions: ${tested.length ? tested.map((item) => item.version).join(", ") : "none"}`);
    const ranges = result.support.reviewedRanges ?? [];
    if (ranges.length) console.log(`  reviewed ranges: ${ranges.map((range) => `${range.from}-${range.to}`).join(", ")}`);
    return;
  }

  console.log(`${result.participant} ${result.version}`);
  console.log(`  known:  ${result.known ? "yes" : "no"}`);
  console.log(`  tested: ${result.tested ? "yes" : "no"}`);
  if (result.reviewed) console.log(`  reviewed: yes (${result.reviewedRange.from}-${result.reviewedRange.to}, ${result.reviewedRange.reviewedAt})`);
  if (result.observedAt) console.log(`  observed: ${result.observedAt}`);
  if (!result.tested && result.reviewed) console.log("  note: inside a reviewed range — HIX-relevant surfaces were reviewed as unchanged, but this exact version has no conformance test.");
  else if (!result.tested && result.known) console.log("  note: HIX knows this exact version but has no recorded conformance test for it.");
  if (!result.known) console.log(`  latest version recorded by this HIX release: ${result.knownVersion}`);
  for (const item of result.evidence ?? []) console.log(`  evidence: ${item}`);
}

function printInspection(result) {
  console.log(`${result.endpoint.spec} -> ${result.endpoint.root}`);
  if (!result.skills.length) return console.log("  no skills found");
  for (const skill of result.skills) {
    console.log(`  ${skill.name.padEnd(28)} ${skill.hash.slice(0, 10)}  ${skill.entries.length} entries  ${summarizePortability(skill)}`);
    for (const issue of skill.validationErrors) console.log(`    INVALID [${issue.id}]: ${issue.message}`);
  }
}

function printBehavior(result) {
  console.log(`${result.endpoint.spec} (${result.endpoint.root})`);
  if (!result.skills.length) return console.log("  no skills found");
  for (const item of result.skills) {
    console.log(`\n${item.artifact.name}`);
    if (!item.behavior.declarations.length) {
      console.log("  no execution behavior declared");
      continue;
    }
    for (const declaration of item.behavior.declarations) {
      console.log(
        `  ${declaration.dimension.padEnd(20)} ${formatCliValue(declaration.value).padEnd(16)} ${declaration.source}`
      );
    }
    for (const conflict of item.behavior.conflicts) {
      console.log(`  CONFLICT: ${conflict.dimension}`);
      for (const declaration of conflict.declarations) {
        console.log(`    ${declaration.source} = ${formatCliValue(declaration.value)}`);
      }
    }
  }
}

function printCompositions(result) {
  console.log(`${result.endpoint.spec} (${result.endpoint.root})`);
  if (!result.compositions.length) return console.log("  no capabilities found");
  for (const composition of result.compositions) {
    console.log(`\n${composition.id}  ${composition.compositionHash.slice(0, 12)}`);
    console.log(`  root: ${composition.root.ref} ${composition.root.hash.slice(0, 10)}`);
    for (const member of composition.members) {
      if (member.ref === composition.root.ref) continue;
      console.log(`  member: ${member.ref} ${member.hash.slice(0, 10)}${member.path ? ` ${member.path}` : ""}`);
    }
    for (const relation of composition.relations) {
      console.log(`  relation: ${relation.from} -[${relation.kind}]-> ${relation.to} [${relation.status}]`);
    }
    for (const requirement of composition.runtimeRequirements) {
      console.log(`  runtime: ${requirement.dimension}=${formatCliValue(requirement.value)}`);
    }
    for (const item of composition.unresolved) {
      console.log(`  UNRESOLVED: ${item.kind}${item.ref ? ` ${item.ref}` : ""}: ${item.reason}`);
    }
    for (const conflict of composition.conflicts) {
      console.log(`  CONFLICT: ${conflict.dimension}`);
    }
  }
}

function printReview(plan) {
  const report = plan.report;
  console.log(`Review:   ${report.endpoint.spec}`);
  console.log(`Output:   ${plan.root}`);
  console.log(`Reviewed: ${report.summary.capabilities}`);
  console.log(`Status:   ${report.summary.ready} ready · ${report.summary["needs-review"]} needs-review · ${report.summary.blocked} blocked`);
  for (const review of report.capabilities) {
    const hash = review.compositionHash ?? review.hash;
    console.log(`\n${review.kind ?? "skill"}:${review.id} [${review.status}] ${hash?.slice(0, 12) ?? "no-hash"}`);
    for (const finding of review.findings) {
      const marker = finding.severity === "error" ? "ERROR" : finding.severity === "warning" ? "WARN" : finding.severity.toUpperCase();
      console.log(`  ${marker.padEnd(5)} ${finding.category.padEnd(12)} ${finding.message}`);
    }
  }
}

function printDiff(result) {
  console.log(`${result.left.endpoint.spec} (${result.left.endpoint.root})`);
  console.log(`${result.right.endpoint.spec} (${result.right.endpoint.root})`);
  for (const item of result.differences) {
    const suffix = item.changedFiles.length ? ` [${item.changedFiles.join(", ")}]` : "";
    console.log(`  ${item.status.padEnd(11)} ${item.name}${suffix}`);
    for (const difference of item.diffs) console.log(`\n${difference.patch}`);
  }
}

function printProjection(plan) {
  console.log(`Materialization: ${plan.source.endpoint.spec} -> ${plan.target}`);
  console.log(`Capability:      ${plan.source.capability ?? plan.source.skill}`);
  console.log(`Composition:     ${plan.source.compositionHash.slice(0, 12)}`);
  console.log(`Output:          ${plan.out}`);
  if (plan.resolutions.length) {
    console.log("\nResolved:");
    for (const item of plan.resolutions) {
      console.log(`  ${item.dimension}: ${item.source} -> ${item.target} [${item.authority}]`);
      if (item.note) console.log(`    NOTE: ${item.note}`);
    }
  }
  if (plan.runtimeRequirements?.length) {
    console.log("\nRuntime requirements / evidence:");
    for (const item of plan.runtimeRequirements) {
      const status = item.status ? ` [${item.status}]` : "";
      console.log(`  ${item.dimension}: ${item.value}${status}`);
      if (item.reason) console.log(`    ${item.reason}`);
      if (item.launch?.command) console.log(`    launch: ${[item.launch.command, ...(item.launch.args ?? [])].join(" ")}`);
    }
  }
  if (plan.unresolved.length) {
    console.log("\nRequired decisions:");
    for (const item of plan.unresolved) console.log(`  ${item.dimension}: ${item.reason}`);
  } else {
    console.log("\nFiles:");
    for (const file of plan.files) console.log(`  ${file}`);
  }
}

function printPlan(plan) {
  console.log(`Direction: ${plan.source.endpoint.spec} -> ${plan.targetEndpoint.spec}`);
  console.log(`Source:    ${plan.source.endpoint.root}`);
  console.log(`Target:    ${plan.targetEndpoint.root}`);
  for (const item of plan.plans) {
    console.log(`\n${item.artifact.name}: ${item.action}`);
    console.log(`  COMPOSITION: ${item.composition.compositionHash.slice(0, 12)}`);
    for (const mapping of item.behaviorMappings) {
      const target = mapping.target ? ` -> ${mapping.target}` : "";
      console.log(`  BEHAVIOR: ${mapping.dimension} ${formatCliValue(mapping.value)} [${mapping.status}]${target}`);
    }
    for (const notice of item.notices) {
      console.log(`  ${notice.severity === "risk" ? "RISK" : "NOTE"} [${notice.id}]: ${notice.message}`);
    }
    for (const blocker of item.blockers) console.log(`  BLOCKED [${blocker.id}]: ${blocker.message}`);
    for (const difference of item.diffs) console.log(`\n${difference.patch}`);
  }
}

function serializeInspection(result) {
  return {
    endpoint: result.endpoint,
    skills: result.skills.map(serializeSkill)
  };
}

function serializeBehavior(result) {
  return {
    endpoint: result.endpoint,
    skills: result.skills.map((item) => ({
      skill: item.artifact.name,
      hash: item.artifact.hash,
      declarations: item.behavior.declarations,
      conflicts: item.behavior.conflicts
    }))
  };
}

function serializeCompositions(result) {
  return {
    endpoint: {
      spec: result.endpoint.spec,
      participant: result.endpoint.participant,
      behavior: result.endpoint.behavior
    },
    capabilities: result.compositions.map(serializeObservedComposition)
  };
}

function serializeDiff(result) {
  return {
    left: result.left.endpoint,
    right: result.right.endpoint,
    differences: result.differences.map((item) => ({
      name: item.name,
      status: item.status,
      leftHash: item.left?.hash,
      rightHash: item.right?.hash,
      changedFiles: item.changedFiles,
      diffs: item.diffs
    }))
  };
}

function serializeProjection(plan) {
  return {
    schema: "hix.projection-plan/v1",
    source: {
      endpoint: plan.source.endpoint.spec,
      participant: plan.source.endpoint.participant,
      capability: plan.source.capability ?? plan.source.skill,
      skill: plan.source.skill,
      hash: plan.source.hash,
      compositionHash: plan.source.compositionHash
    },
    target: { participant: plan.target },
    choices: plan.choices,
    resolutions: plan.resolutions,
    runtimeRequirements: plan.runtimeRequirements,
    unresolved: plan.unresolved,
    files: plan.files.map((file) => portableRelativePath(plan.out, file))
  };
}

function serializePlan(plan) {
  return {
    direction: { source: plan.source.endpoint, target: plan.targetEndpoint },
    plans: plan.plans.map((item) => ({
      skill: item.artifact.name,
      compositionHash: item.composition.compositionHash,
      action: item.action,
      sourceHash: item.artifact.hash,
      targetHash: item.existing?.artifact?.hash,
      behavior: item.behaviorMappings,
      behaviorConflicts: item.behaviorConflicts,
      notices: item.notices,
      acceptedRisks: item.acceptedRisks,
      diffs: item.diffs,
      blockers: item.blockers
    }))
  };
}

function serializeSkill(skill) {
  return {
    name: skill.name,
    directoryName: skill.directoryName,
    path: skill.rootPath,
    hash: skill.hash,
    frontmatterKeys: skill.frontmatter.keys,
    warnings: skill.warnings,
    validationErrors: skill.validationErrors,
    entries: skill.entries.map((entry) => ({ path: entry.path, kind: entry.kind }))
  };
}

function portableRelativePath(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function formatCliValue(value) {
  if (Array.isArray(value)) return value.join(",");
  return String(value);
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printHelp() {
  console.log(`hix - harness interchange\n\nUsage:\n  hix support [participant] [version] [--json]\n  hix probe [participant...] [--json] [--check]\n  hix inspect <endpoint> [options]\n  hix behavior <endpoint> [--skill <name>...] [options]\n  hix compose <endpoint> [--skill <name>...] [options]\n  hix review <endpoint> [--skill <name>... | --all] [options]\n  hix evaluate <endpoint> [--skill <name>... | --all] [options]  # review alias\n  hix diff <left> <right> [options]\n  hix transfer <source> <target> (--skill <name>... | --all) [options]\n  hix materialize <source> <codex|claude> --skill <name> --out <path> [options]\n  hix project <source> <codex|claude> --skill <name> --out <path> [options]  # compatibility alias\n\nSupport:\n  support shows the exact harness versions this HIX release knows and has conformance-tested\n  hix support claude 2.1.229 reports known and tested separately\n\nProbe:\n  probe observes what the installed harnesses actually expose, and reports drift\n  it reads versions, published command/flag surfaces, and on-disk footprints only\n  it never invokes a model, never executes work, and never writes\n  a documented capability with no footprint has never run here; probe says so\n  adopting probe output into harnesses/support.json remains an explicit human decision\n\nReview:\n  review is a portability/structure review of skills, native agents, and their relationships\n  review without --skill reviews every discovered skill and native agent\n  review is read-only unless --apply writes a package under .hix/<participant>/reviews/<scope>\n  --out overrides the review package root\n  --replace authorizes replacing a marked existing review package\n\nBuilt-in endpoints:\n  claude:user              ~/.claude/skills\n  claude:project           <project>/.claude/skills\n  codex:user               ~/.agents/skills\n  codex:project            <project>/.agents/skills\n  codex:legacy             ~/.codex/skills (compatibility inspection only)\n\nNeutral filesystem endpoints:\n  Bind fs:<label> explicitly, for example:\n  --endpoint-root fs:source=/path/to/skills\n\nTransfer authority:\n  transfer is a dry run unless --apply is present\n  --replace authorizes replacing a divergent destination skill\n  --allow-risk <id> accepts one specifically reported portability risk; repeat per risk\n  transfer refuses composed capabilities with external native members or runtime requirements\n\nOptions:\n  --skill <name>            repeatable skill selection/filter\n  --all                     select every source skill\n  --apply                   write/apply the planned operation\n  --replace                 permit replacement of marked output or divergent target content\n  --allow-risk <id>         accept one reported portability risk; repeatable\n  --check                   use strict CI exit codes without writing (1 when attention is required)\n  --project <path>          project root for project-scoped endpoints\n  --endpoint-root E=P       bind or override an endpoint as a skills directory\n  --home <path>             override the OS home directory (also useful for tests)\n  --out <path>              review/materialization output root\n  --codex-agent <name>      explicit Codex custom-agent identity\n  --codex-model <model>     explicit Codex model choice; never inferred from another harness\n  --claude-agent <name>     explicit Claude custom-agent identity\n  --claude-model <model>    explicit Claude model choice; never inferred from another harness\n  --claude-effort <effort>  explicit Claude effort when source value cannot map directly\n  --json                    machine-readable output\n`);
}

function printProbe(result, findings) {
  for (const probe of result.probes) {
    const summary = summarizeProbe(probe);
    if (!summary.installed) {
      console.log(`${probe.product} (${probe.participant}): not installed here`);
      continue;
    }
    console.log(`${probe.product} (${probe.participant}) ${summary.version}`);
    console.log(`  observed:   ${summary.observed.join(", ") || "none"}`);
    if (summary.absent.length) console.log(`  absent:     ${summary.absent.join(", ")}`);
    if (summary.unverified.length) console.log(`  unverified: ${summary.unverified.join(", ")}`);
    for (const footprint of probe.footprints) {
      console.log(`  footprint ${footprint.present ? "present" : "absent "} ${footprint.id} (${footprint.path})`);
    }
  }

  console.log(findings.length ? "\nDrift against the support matrix:" : "\nNo drift against the support matrix.");
  for (const finding of findings) console.log(`  [${finding.severity}] ${finding.id}: ${finding.message}`);
  console.log("\nObservation only. No model was invoked, no work was executed, and nothing was written.");
  console.log("Adopting any of this into harnesses/support.json remains an explicit human decision.");
}

function strictExit(parsed, failed) {
  if (parsed.check && failed) process.exitCode = 1;
}

function supportFailedCheck(result) {
  if (result.version) return !(result.tested || result.reviewed);
  if (result.participant) return !(result.support.testedVersions ?? []).length;
  return Object.values(result.matrix.participants ?? {}).some((item) => !(item.testedVersions ?? []).length) ||
    !(result.matrix.testedPairings ?? []).length;
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
