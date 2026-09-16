import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const cli = path.resolve("src/cli.js");

// probe is intentionally not covered here: it observes the harnesses installed
// on the machine running the tests, so its findings are not hermetic.

async function tempHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), "hix-cli-check-test-"));
}

async function writeSkill(root, name, body, extras = {}) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), body, "utf8");
  for (const [file, content] of Object.entries(extras)) {
    const target = path.join(dir, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
}

function validSkill(name) {
  return `---\nname: ${name}\ndescription: Do the work.\n---\n\nDo the work.\n`;
}

function invalidSkill() {
  return `---\nname: Invalid Name\ndescription: Broken.\n---\n\nBroken.\n`;
}

function conflictedSkillExtras() {
  return { "agents/openai.yaml": "policy:\n  allow_implicit_invocation: true\n" };
}

const conflictedSkill = `---\nname: conflicted\ndescription: Conflicting policy.\ndisable-model-invocation: true\n---\n\nWork.\n`;

async function exec(args) {
  try {
    const result = await run(process.execPath, [cli, ...args]);
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

async function setupClean(home) {
  await writeSkill(path.join(home, ".claude", "skills"), "tidy", validSkill("tidy"));
}

async function setupInvalid(home) {
  await writeSkill(path.join(home, ".claude", "skills"), "broken", invalidSkill());
}

async function setupConflict(home) {
  await writeSkill(path.join(home, ".claude", "skills"), "conflicted", conflictedSkill, conflictedSkillExtras());
}

const cases = [
  {
    name: "inspect",
    clean: { setup: setupClean, args: ["inspect", "claude:user"] },
    failing: { setup: setupInvalid, args: ["inspect", "claude:user"], marker: /agent-skills-invalid-name/ }
  },
  {
    name: "behavior",
    clean: { setup: setupClean, args: ["behavior", "claude:user"] },
    failing: { setup: setupConflict, args: ["behavior", "claude:user"], marker: /CONFLICT/ }
  },
  {
    name: "compose",
    clean: { setup: setupClean, args: ["compose", "claude:user"] },
    failing: { setup: setupConflict, args: ["compose", "claude:user"], marker: /CONFLICT/ }
  },
  {
    name: "review",
    clean: { setup: setupClean, args: ["review", "claude:user"] },
    failing: {
      setup: async (home) => {
        await writeSkill(
          path.join(home, ".claude", "skills"),
          "odd",
          `---\nname: odd\ndescription: Odd effort.\neffort: extreme\n---\n\nWork.\n`
        );
      },
      args: ["review", "claude:user"],
      marker: /unknown-effort-level|needs-review/
    }
  },
  {
    name: "diff",
    clean: {
      setup: async (home) => {
        await writeSkill(path.join(home, ".claude", "skills"), "same", validSkill("same"));
        await writeSkill(path.join(home, ".agents", "skills"), "same", validSkill("same"));
      },
      args: ["diff", "claude:user", "codex:user"]
    },
    failing: {
      setup: async (home) => {
        await writeSkill(path.join(home, ".claude", "skills"), "same", validSkill("same"));
      },
      args: ["diff", "claude:user", "codex:user"],
      marker: /same/
    }
  },
  {
    name: "transfer",
    clean: { setup: setupClean, args: ["transfer", "claude:user", "codex:user", "--all"] },
    failing: {
      setup: setupConflict,
      args: ["transfer", "claude:user", "codex:user", "--all"],
      marker: /conflicting-execution-behavior/
    }
  },
  {
    name: "materialize",
    clean: {
      setup: setupClean,
      args: (home) => ["materialize", "claude:user", "codex", "--skill", "tidy", "--out", path.join(home, "bundle")]
    },
    failing: {
      setup: async (home) => {
        await writeSkill(
          path.join(home, ".claude", "skills"),
          "modeled",
          `---\nname: modeled\ndescription: Uses a model.\nmodel: source-model\n---\n\nWork.\n`
        );
      },
      args: (home) => [
        "materialize", "claude:user", "codex",
        "--skill", "modeled", "--out", path.join(home, "bundle"),
        "--codex-agent", "worker"
      ],
      marker: /model-selection/
    }
  }
];

for (const command of cases) {
  test(`${command.name}: clean state passes --check and finding state fails only under --check`, async () => {
    const cleanHome = await tempHome();
    await command.clean.setup(cleanHome);
    const cleanArgs = typeof command.clean.args === "function" ? command.clean.args(cleanHome) : command.clean.args;
    const clean = await exec([...cleanArgs, "--home", cleanHome, "--check"]);
    assert.equal(clean.code, 0, `clean --check should exit 0: ${clean.stderr}`);

    const failingHome = await tempHome();
    await command.failing.setup(failingHome);
    const failingArgs = typeof command.failing.args === "function" ? command.failing.args(failingHome) : command.failing.args;
    const strict = await exec([...failingArgs, "--home", failingHome, "--check"]);
    assert.equal(strict.code, 1, `finding state with --check should exit 1: ${strict.stdout} ${strict.stderr}`);
    assert.match(`${strict.stdout}${strict.stderr}`, command.failing.marker);

    const lenient = await exec([...failingArgs, "--home", failingHome]);
    assert.equal(lenient.code, 0, `finding state without --check should exit 0: ${lenient.stderr}`);
  });
}

test("support: a tested version passes --check and an unrecorded version fails only under --check", async () => {
  const matrix = JSON.parse(await fs.readFile(path.resolve("harnesses/support.json"), "utf8"));
  const tested = matrix.participants.claude.testedVersions[0].version;

  const clean = await exec(["support", "claude", tested, "--check"]);
  assert.equal(clean.code, 0, clean.stderr);

  const strict = await exec(["support", "claude", "0.0.1", "--check"]);
  assert.equal(strict.code, 1);
  assert.match(strict.stdout, /tested: no/);

  const lenient = await exec(["support", "claude", "0.0.1"]);
  assert.equal(lenient.code, 0, lenient.stderr);
});

test("--apply cannot be combined with --check", async () => {
  const home = await tempHome();
  await setupClean(home);
  const combos = [
    ["transfer", "claude:user", "codex:user", "--all"],
    ["review", "claude:user"],
    ["materialize", "claude:user", "codex", "--skill", "tidy", "--out", path.join(home, "bundle")]
  ];
  for (const args of combos) {
    const result = await exec([...args, "--home", home, "--apply", "--check"]);
    assert.equal(result.code, 1, args.join(" "));
    assert.match(result.stderr, /--check is a dry-run\/inspection mode and cannot be combined with --apply\./);
  }
});
