import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { analyzeTransfer } from "./compatibility.js";
import { analyzeBehaviorTransfer, inspectExecutionBehavior } from "./behavior.js";
import { diffSkillArtifacts, diffSkillSets, discoverSkills, existingSkillAt, readSkill, writeSkill } from "./artifacts.js";
import { observeComposedCapability } from "./composition.js";
import { resolveEndpoint } from "./endpoints.js";

export async function inspectEndpoint(spec, options = {}) {
  const endpoint = await resolveEndpoint(spec, options);
  const skills = await discoverSkills(endpoint);
  return { endpoint, skills };
}

export async function inspectBehavior(spec, names = [], options = {}) {
  const inspection = await inspectEndpoint(spec, options);
  const selected = names.length ? chooseNamedSkills(inspection.skills, names) : inspection.skills;
  return {
    endpoint: inspection.endpoint,
    skills: selected.map((artifact) => ({
      artifact,
      behavior: inspectExecutionBehavior(artifact, inspection.endpoint)
    }))
  };
}

export async function inspectCompositions(spec, names = [], options = {}) {
  const inspection = await inspectEndpoint(spec, options);
  const selected = names.length ? chooseNamedSkills(inspection.skills, names) : inspection.skills;
  const compositions = [];
  for (const artifact of selected) {
    compositions.push(await observeComposedCapability(artifact, inspection.endpoint));
  }
  return { endpoint: inspection.endpoint, compositions };
}

export async function diffEndpoints(leftSpec, rightSpec, options = {}) {
  const left = await inspectEndpoint(leftSpec, options);
  const right = await inspectEndpoint(rightSpec, options);
  return { left, right, differences: diffSkillSets(left.skills, right.skills) };
}

export async function planTransfer(sourceSpec, targetSpec, selection, options = {}) {
  if (sourceSpec === targetSpec) throw new Error("Source and target endpoints must differ.");
  const source = await inspectEndpoint(sourceSpec, options);
  const targetEndpoint = await resolveEndpoint(targetSpec, options);
  const selected = chooseSkills(source.skills, selection);
  const plans = [];
  const allowedRisks = new Set(options.allowedRisks ?? []);
  const observedRiskIds = new Set();

  for (const artifact of selected) {
    const composition = await observeComposedCapability(artifact, source.endpoint);
    const existing = artifact.validationErrors.length
      ? undefined
      : await existingSkillAt(targetEndpoint.root, artifact.name, targetEndpoint);
    const notices = analyzeTransfer(artifact, targetEndpoint);
    const sourceBehavior = {
      declarations: composition.declarations,
      conflicts: composition.conflicts
    };
    const behaviorMappings = analyzeBehaviorTransfer(artifact, source.endpoint, targetEndpoint);
    const blockers = artifact.validationErrors.map((issue) => blocker(
      issue.id,
      issue.message,
      issue.evidence
    ));
    blockers.push(...sourceBehavior.conflicts.map(
      (conflict) => blocker(
        `conflicting-execution-behavior:${conflict.dimension}`,
        `Conflicting execution behavior for ${conflict.dimension}: ${conflict.declarations
          .map((item) => `${item.source}=${formatValue(item.value)}`)
          .join(", ")}. Resolve the declarations before transfer.`,
        conflict.declarations.map((item) => item.source)
      )
    ));
    let action = artifact.validationErrors.length ? "blocked" : "create";

    if (composition.unresolved.length) {
      blockers.push(blocker(
        "unresolved-native-relationships",
        `Composed capability ${artifact.name} has unresolved native relationships: ${composition.unresolved
          .map((item) => `${item.kind}:${item.ref ?? "unknown"}`)
          .join(", ")}.`,
        composition.unresolved.map((item) => item.ref).filter(Boolean)
      ));
    }
    if (composition.members.length > 1) {
      blockers.push(blocker(
        "composed-capability-requires-materialization",
        `Composed capability ${artifact.name} includes native members outside the skill artifact. ` +
          "transfer is intentionally lossless byte transport for one skill package; use materialize/project so HIX can realize the whole composition instead of silently dropping members.",
        composition.members.filter((item) => item.ref !== composition.root.ref).map((item) => item.ref)
      ));
    }
    if (composition.runtimeRequirements.length) {
      blockers.push(blocker(
        "runtime-requirements-require-materialization",
        `Composed capability ${artifact.name} carries runtime requirements that raw transfer cannot install or enforce. Use materialize/project.`,
        composition.runtimeRequirements.map((item) => `${item.dimension}:${item.value}`)
      ));
    }

    if (existing && !existing.artifact) {
      action = "conflict";
      blockers.push(blocker("unreadable-target-skill", `${existing.path} exists but is not a readable skill.`, [existing.path]));
    } else if (existing?.artifact?.hash === artifact.hash) {
      action = "noop";
    } else if (existing?.artifact) {
      action = "replace";
      if (!options.replace) {
        blockers.push(blocker(
          "destination-replacement-not-authorized",
          "Destination differs. Review the diff and pass --replace to authorize replacement."
        ));
      }
    }

    for (const mapping of behaviorMappings) {
      if (["portable", "preserved-native", "preserved-declaration"].includes(mapping.status)) continue;
      notices.push({
        id: `behavior-${mapping.dimension}-${mapping.status}`,
        severity: "risk",
        message: formatBehaviorRisk(mapping)
      });
    }

    const risks = notices.filter((notice) => notice.severity === "risk");
    for (const risk of risks) observedRiskIds.add(risk.id);
    const unacceptedRisks = risks.filter((risk) => !allowedRisks.has(risk.id));
    if (unacceptedRisks.length) {
      blockers.push(blocker(
        "unaccepted-portability-risks",
        "Portability risks are present. Review each risk and pass --allow-risk <id> once for every accepted risk.",
        unacceptedRisks.map((risk) => risk.id)
      ));
    }

    plans.push({
      artifact,
      composition,
      existing,
      targetEndpoint,
      action,
      notices,
      behaviorMappings,
      behaviorConflicts: sourceBehavior.conflicts,
      acceptedRisks: risks.filter((risk) => allowedRisks.has(risk.id)).map((risk) => risk.id),
      diffs: existing?.artifact ? diffSkillArtifacts(existing.artifact, artifact) : [],
      blockers
    });
  }

  const unknownRisks = [...allowedRisks].filter((id) => !observedRiskIds.has(id));
  if (unknownRisks.length) throw new Error(`Unknown or inapplicable --allow-risk id(s): ${unknownRisks.join(", ")}.`);
  return { source, targetEndpoint, plans };
}

export async function applyTransfer(plan, options = {}) {
  const blocked = plan.plans.flatMap((item) => item.blockers.map((itemBlocker) => `${item.artifact.name} [${itemBlocker.id}]: ${itemBlocker.message}`));
  if (blocked.length) throw new Error(`Transfer is blocked:\n- ${blocked.join("\n- ")}`);

  const results = [];
  for (const item of plan.plans) {
    if (item.action === "noop") {
      results.push({ name: item.artifact.name, action: "noop", path: item.existing.path });
      continue;
    }

    const targetHashBefore = item.existing?.artifact?.hash;
    const destination = await writeSkill(item.artifact, item.targetEndpoint.root, { replace: item.action === "replace" });
    const written = await readSkill(destination, item.targetEndpoint);
    if (written.hash !== item.artifact.hash) {
      throw new Error(`Post-write verification failed for ${item.artifact.name}: source and destination hashes differ.`);
    }

    await appendHistory(
      {
        timestamp: new Date().toISOString(),
        skill: item.artifact.name,
        compositionHash: item.composition.compositionHash,
        source: plan.source.endpoint.spec,
        sourcePath: item.artifact.rootPath,
        sourceHash: item.artifact.hash,
        target: item.targetEndpoint.spec,
        targetPath: destination,
        targetHashBefore,
        targetHashAfter: written.hash,
        action: item.action,
        notices: item.notices.map((notice) => notice.message),
        noticeRecords: item.notices,
        acceptedRisks: item.acceptedRisks,
        behavior: item.behaviorMappings.map(({ dimension, source, value, nativeValue, nativeKey, nativeFamily, status, target, note }) => ({
          dimension,
          source,
          value,
          nativeValue,
          nativeKey,
          nativeFamily,
          status,
          target,
          note
        }))
      },
      options.home
    );
    results.push({
      name: item.artifact.name,
      action: item.action,
      path: destination,
      hash: written.hash,
      compositionHash: item.composition.compositionHash
    });
  }
  return results;
}

function blocker(id, message, evidence = []) {
  return { id, message, evidence: evidence ?? [] };
}

function chooseSkills(skills, selection) {
  if (selection.all && selection.names.length) throw new Error("Use either --all or --skill, not both.");
  if (!selection.all && !selection.names.length) {
    throw new Error("Choose what moves explicitly with --skill <name> (repeatable) or --all.");
  }
  if (selection.all) return skills;
  return chooseNamedSkills(skills, selection.names);
}

function chooseNamedSkills(skills, names) {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  return names.map((name) => {
    const skill = byName.get(name);
    if (!skill) throw new Error(`Source endpoint does not contain skill ${name}.`);
    return skill;
  });
}

function formatBehaviorRisk(mapping) {
  const destination = mapping.target ? ` -> ${mapping.target}` : "";
  const native = mapping.nativeValue !== undefined && JSON.stringify(mapping.nativeValue) !== JSON.stringify(mapping.value)
    ? `${mapping.source}=${formatValue(mapping.nativeValue)} => ${mapping.dimension}=${formatValue(mapping.value)}`
    : `${mapping.source}=${formatValue(mapping.value)}`;
  return `Execution behavior ${mapping.dimension} (${native}) is ${mapping.status}${destination}. ${mapping.note}`;
}

function formatValue(value) {
  return Array.isArray(value) ? value.join(",") : String(value);
}

async function appendHistory(record, homeOverride) {
  const home = path.resolve(homeOverride ?? os.homedir());
  const stateDir = path.join(home, ".harness-interchange");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.appendFile(path.join(stateDir, "history.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
}
