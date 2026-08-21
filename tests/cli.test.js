import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const cli = path.resolve("src/cli.js");

test("--check returns strict CI exit codes and diff prints a unified patch", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "hix-cli-test-"));
  await writeSkill(path.join(home, ".claude", "skills"), "review", "source");
  await writeSkill(path.join(home, ".agents", "skills"), "review", "target");

  const normal = await run(process.execPath, [cli, "diff", "claude:user", "codex:user", "--home", home]);
  assert.match(normal.stdout, /@@/);
  assert.match(normal.stdout, /-source/);
  assert.match(normal.stdout, /\+target/);

  await assert.rejects(
    run(process.execPath, [cli, "diff", "claude:user", "codex:user", "--home", home, "--check"]),
    (error) => error.code === 1 && /@@/.test(error.stdout)
  );
});

test("--check reports invalid Agent Skills and blanket lossy authorization is rejected", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "hix-cli-test-"));
  const root = path.join(home, ".agents", "skills", "safe-name");
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "SKILL.md"), "---\nname: ../escape\ndescription: Invalid.\n---\n", "utf8");

  await assert.rejects(
    run(process.execPath, [cli, "inspect", "codex:user", "--home", home, "--check", "--json"]),
    (error) => error.code === 1 && /agent-skills-invalid-name/.test(error.stdout)
  );
  await assert.rejects(
    run(process.execPath, [cli, "transfer", "codex:user", "claude:user", "--all", "--home", home, "--allow-lossy"]),
    (error) => error.code === 1 && /--allow-lossy has been removed/.test(error.stderr)
  );
});

async function writeSkill(root, name, instruction) {
  const directory = path.join(root, name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: Review.\n---\n\n${instruction}\n`,
    "utf8"
  );
}
