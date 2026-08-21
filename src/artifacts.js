import crypto from "node:crypto";
import { isUtf8 } from "node:buffer";
import fs from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import {
  assertValidSkillName,
  inspectSkillFrontmatter,
  validateAgentSkillFrontmatter
} from "./frontmatter.js";

export async function discoverSkills(endpoint) {
  let entries;
  try {
    entries = await fs.readdir(endpoint.root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const skills = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const candidate = path.join(endpoint.root, entry.name);
    if (!(await isDirectoryOrDirectorySymlink(candidate, entry))) continue;
    if (entry.isSymbolicLink() && await symlinkEscapes(candidate, endpoint.root)) {
      skills.push(await readSkill(candidate, endpoint));
      continue;
    }
    if (!(await fileExists(path.join(candidate, "SKILL.md")))) continue;
    skills.push(await readSkill(candidate, endpoint));
  }

  const byName = new Map();
  for (const skill of skills) {
    const previous = byName.get(skill.name);
    if (previous) {
      throw new Error(
        `Endpoint ${endpoint.spec} contains duplicate skill name ${skill.name}: ${previous.rootPath} and ${skill.rootPath}`
      );
    }
    byName.set(skill.name, skill);
  }
  return skills;
}

export async function readSkill(skillPath, endpoint) {
  const rootStat = await fs.lstat(skillPath);
  const rootIsSymlink = rootStat.isSymbolicLink();
  const realRoot = rootIsSymlink ? await fs.realpath(skillPath) : skillPath;
  const endpointRoot = rootIsSymlink ? await fs.realpath(endpoint.root) : undefined;
  if (rootIsSymlink && !isContained(endpointRoot, realRoot)) {
    const target = await fs.readlink(skillPath);
    const directoryName = path.basename(skillPath);
    const entries = [{ path: ".", kind: "symlink", target, mode: rootStat.mode }];
    return {
      name: directoryName,
      directoryName,
      endpoint: endpoint.spec,
      rootPath: skillPath,
      resolvedRootPath: realRoot,
      rootIsSymlink: true,
      hash: hashEntries(entries),
      frontmatter: inspectSkillFrontmatter(""),
      entries,
      warnings: [`Skill directory is a symlink to ${realRoot}; its contents were not read.`],
      validationErrors: [{
        id: "skill-root-symlink-escapes-endpoint",
        message: `Skill directory symlink resolves outside its endpoint root: ${realRoot}.`,
        evidence: [`endpoint:${endpointRoot}`, `target:${target}`, `resolved:${realRoot}`]
      }]
    };
  }
  const entries = [];
  const unsafeSymlinks = [];
  await walk(realRoot, realRoot, entries, unsafeSymlinks);

  const skillFile = entries.find((entry) => entry.path === "SKILL.md" && entry.kind === "file");
  if (!skillFile) throw new Error(`${skillPath} does not contain a readable SKILL.md`);

  const markdown = skillFile.content.toString("utf8");
  const frontmatter = inspectSkillFrontmatter(markdown);
  const directoryName = path.basename(skillPath);
  const name = frontmatter.name === directoryName ? frontmatter.name : directoryName;
  const hash = hashEntries(entries);
  const warnings = [];
  const validationErrors = validateAgentSkillFrontmatter(frontmatter, directoryName);

  for (const unsafe of unsafeSymlinks) {
    validationErrors.push({
      id: "skill-symlink-escapes-root",
      message: `Symlink ${unsafe.path} is absolute or resolves outside the skill root and cannot be recreated safely.`,
      evidence: [`target:${unsafe.target}`, `resolved:${unsafe.resolvedTarget}`]
    });
  }

  if (rootIsSymlink) warnings.push(`Skill directory is a symlink to ${realRoot}; transfer will materialize the directory.`);

  return {
    name,
    directoryName,
    endpoint: endpoint.spec,
    rootPath: skillPath,
    resolvedRootPath: realRoot,
    rootIsSymlink,
    hash,
    frontmatter,
    entries,
    warnings,
    validationErrors
  };
}

export function diffSkillSets(leftSkills, rightSkills) {
  const left = new Map(leftSkills.map((skill) => [skill.name, skill]));
  const right = new Map(rightSkills.map((skill) => [skill.name, skill]));
  const names = [...new Set([...left.keys(), ...right.keys()])].sort();

  return names.map((name) => {
    const a = left.get(name);
    const b = right.get(name);
    if (!a) return difference(name, "only-right", undefined, b);
    if (!b) return difference(name, "only-left", a, undefined);
    if (a.hash === b.hash) return difference(name, "equal", a, b);
    return difference(name, "changed", a, b);
  });
}

export function diffSkillArtifacts(left, right) {
  const a = new Map((left?.entries ?? []).filter((entry) => entry.kind !== "directory").map((entry) => [entry.path, entry]));
  const b = new Map((right?.entries ?? []).filter((entry) => entry.kind !== "directory").map((entry) => [entry.path, entry]));
  return [...new Set([...a.keys(), ...b.keys()])]
    .sort()
    .filter((file) => entryFingerprintOrMissing(a.get(file)) !== entryFingerprintOrMissing(b.get(file)))
    .map((file) => renderEntryDiff(file, a.get(file), b.get(file)));
}

export async function writeSkill(artifact, targetRoot, options = {}) {
  assertSkillSafeForWrite(artifact);
  const destination = path.join(targetRoot, artifact.name);
  const existing = await pathExists(destination);
  if (existing && !options.replace) {
    throw new Error(`${destination} already exists; pass --replace only after reviewing the diff.`);
  }

  await fs.mkdir(targetRoot, { recursive: true });
  const stage = path.join(targetRoot, `.hix-stage-${artifact.name}-${crypto.randomUUID()}`);
  const backup = path.join(targetRoot, `.hix-backup-${artifact.name}-${crypto.randomUUID()}`);
  await fs.mkdir(stage, { recursive: true });

  try {
    for (const entry of artifact.entries) {
      const destinationPath = safeJoin(stage, entry.path);
      if (entry.kind === "directory") {
        await fs.mkdir(destinationPath, { recursive: true });
      } else if (entry.kind === "file") {
        await fs.mkdir(path.dirname(destinationPath), { recursive: true });
        await fs.writeFile(destinationPath, entry.content);
        await fs.chmod(destinationPath, entry.mode);
      } else if (entry.kind === "symlink") {
        await fs.mkdir(path.dirname(destinationPath), { recursive: true });
        assertContainedSymlink(stage, destinationPath, entry.target, entry.path);
        await fs.symlink(entry.target, destinationPath);
      }
    }

    if (existing) await fs.rename(destination, backup);
    try {
      await fs.rename(stage, destination);
    } catch (error) {
      if (existing && (await pathExists(backup))) await fs.rename(backup, destination);
      throw error;
    }
    if (existing) await fs.rm(backup, { recursive: true, force: true });
    return destination;
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}

export async function existingSkillAt(targetRoot, name, endpoint) {
  assertValidSkillName(name);
  const candidate = path.join(targetRoot, name);
  if (!(await pathExists(candidate))) return undefined;
  if (!(await fileExists(path.join(candidate, "SKILL.md")))) return { path: candidate, artifact: undefined };
  return { path: candidate, artifact: await readSkill(candidate, endpoint) };
}

function changedPaths(left, right) {
  const a = new Map(left.entries.map((entry) => [entry.path, entryFingerprint(entry)]));
  const b = new Map(right.entries.map((entry) => [entry.path, entryFingerprint(entry)]));
  return [...new Set([...a.keys(), ...b.keys()])]
    .filter((key) => a.get(key) !== b.get(key))
    .sort();
}

function difference(name, status, left, right) {
  return {
    name,
    status,
    left,
    right,
    changedFiles: status === "equal" ? [] : changedPaths(left ?? { entries: [] }, right ?? { entries: [] }),
    diffs: status === "equal" ? [] : diffSkillArtifacts(left, right)
  };
}

function entryFingerprint(entry) {
  const hash = crypto.createHash("sha256");
  hash.update(entry.kind);
  hash.update("\0");
  hash.update(String(entry.mode ?? ""));
  hash.update("\0");
  if (entry.kind === "file") hash.update(entry.content);
  if (entry.kind === "symlink") hash.update(entry.target);
  return hash.digest("hex");
}

function hashEntries(entries) {
  const hash = crypto.createHash("sha256");
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(entry.path);
    hash.update("\0");
    hash.update(entryFingerprint(entry));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function walk(root, current, output, unsafeSymlinks) {
  const children = await fs.readdir(current, { withFileTypes: true });
  for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
    if (child.name === ".git") continue;
    const absolute = path.join(current, child.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) {
      const target = await fs.readlink(absolute);
      const resolvedTarget = path.resolve(path.dirname(absolute), target);
      output.push({ path: relative, kind: "symlink", target, mode: stat.mode });
      if (path.isAbsolute(target) || !isContained(root, resolvedTarget)) {
        unsafeSymlinks.push({ path: relative, target, resolvedTarget });
      }
    } else if (stat.isDirectory()) {
      output.push({ path: relative, kind: "directory", mode: stat.mode });
      await walk(root, absolute, output, unsafeSymlinks);
    } else if (stat.isFile()) {
      output.push({ path: relative, kind: "file", content: await fs.readFile(absolute), mode: stat.mode });
    }
  }
}

async function isDirectoryOrDirectorySymlink(candidate, dirent) {
  if (dirent.isDirectory()) return true;
  if (!dirent.isSymbolicLink()) return false;
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function symlinkEscapes(candidate, root) {
  const [resolvedCandidate, resolvedRoot] = await Promise.all([fs.realpath(candidate), fs.realpath(root)]);
  return !isContained(resolvedRoot, resolvedCandidate);
}

async function fileExists(candidate) {
  try {
    return (await fs.stat(candidate)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function pathExists(candidate) {
  try {
    await fs.lstat(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function safeJoin(root, relative) {
  const target = path.resolve(root, relative);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (target !== path.resolve(root) && !target.startsWith(prefix)) {
    throw new Error(`Unsafe skill path: ${relative}`);
  }
  return target;
}

export function assertSkillSafeForWrite(artifact) {
  assertValidSkillName(artifact.name);
  if (artifact.validationErrors?.length) {
    throw new Error(
      `Skill ${artifact.directoryName} is not writable because validation failed: ` +
        artifact.validationErrors.map((issue) => `[${issue.id}] ${issue.message}`).join("; ")
    );
  }
}

function assertContainedSymlink(root, linkPath, target, relative) {
  const resolvedTarget = path.resolve(path.dirname(linkPath), target);
  if (path.isAbsolute(target) || !isContained(root, resolvedTarget)) {
    throw new Error(`Unsafe skill symlink ${relative}: target ${target} escapes the skill root.`);
  }
}

function isContained(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

function entryFingerprintOrMissing(entry) {
  return entry ? entryFingerprint(entry) : "missing";
}

function renderEntryDiff(file, left, right) {
  const leftLabel = left ? `a/${file}` : "/dev/null";
  const rightLabel = right ? `b/${file}` : "/dev/null";
  const leftText = entryText(left);
  const rightText = entryText(right);
  if (leftText === undefined || rightText === undefined) {
    return {
      path: file,
      kind: "binary",
      patch: `Binary files ${leftLabel} and ${rightLabel} differ`
    };
  }
  return {
    path: file,
    kind: "text",
    patch: createTwoFilesPatch(leftLabel, rightLabel, leftText, rightText, "", "", { context: 3 }).trimEnd()
  };
}

function entryText(entry) {
  if (!entry) return "";
  if (entry.kind === "symlink") return `${entry.target}\n`;
  if (entry.kind !== "file" || entry.content.length > 256 * 1024 || !isUtf8(entry.content)) return undefined;
  return entry.content.toString("utf8");
}
