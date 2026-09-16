// Contract: the installer owns config.yml carefully — every write is atomic, keeps the file's own
// line endings, and is rolled back if the result would not read back as an extensions list; it never
// leaves the same extensions in two auto-discovered trees; uninstall removes exactly what its scope
// installed; and the plugin verb touches the runtime dependencies only.
//
// Everything runs against a temp HOME and a temp CWD through the real CLI: the real ~/.omp is never
// read or written. The only install direction exercised for real is `uninstall`, because a real
// user-scope install reaches the network (the Ponytail plugin and the rtk release archive); the
// adding direction is covered through the dry-run proposals, which run the same rewrite code.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = join(REPO, "install-omp-addons.js");

const SANDBOXES = [];
after(() => {
  for (const dir of SANDBOXES) rmSync(dir, { recursive: true, force: true });
});

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "omp-installer-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "omp-installer-cwd-"));
  SANDBOXES.push(home, cwd);
  return { home, cwd };
}

const userAgentDir = (home) => join(home, ".omp", "agent");
const userExtDir = (home) => join(userAgentDir(home), "extensions");
const configPath = (home) => join(userAgentDir(home), "config.yml");
const projectExtDir = (cwd) => join(cwd, ".omp", "extensions");
const normalize = (p) => p.replaceAll("\\", "/");

function run(args, { home, cwd }) {
  const result = spawnSync(process.execPath, [INSTALLER, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 120000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, "xdg-config"),
      // Empty on purpose: the plugin root has to resolve to the temp HOME, not this machine's.
      XDG_DATA_HOME: "",
      APPDATA: join(home, "appdata"),
      OMP_TOKEN_SAVER_CONFIG: join(home, "token-saver.json"),
    },
  });
  return { code: result.status, out: `${result.stdout || ""}${result.stderr || ""}` };
}

function seedTree(extDir, names) {
  for (const name of names) mkdirSync(join(extDir, name), { recursive: true });
}

function seedConfig(home, text) {
  mkdirSync(userAgentDir(home), { recursive: true });
  writeFileSync(configPath(home), text, "utf8");
}

function seedFile(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
}

// Every path under a directory plus its bytes, so "wrote nothing" is a whole-tree claim.
function snapshot(dir) {
  const entries = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        entries.push(`${full}/`);
        walk(full);
      } else {
        entries.push(`${full}:${readFileSync(full, "utf8")}`);
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return entries.sort();
}

const MANAGED_DIRS = ["caveman-session", "rtk-session", "token-saver", "ai-addons-updater", "shared", "amanai-reward"];
// A project-scope install replays four steps plus the updater step: token-saver is user-level only.
const PROJECT_DIRS = ["caveman-session", "rtk-session", "ai-addons-updater", "shared", "amanai-reward"];
// The name the runtime keys the plugin lock by; the rename in flight does not change the test's point.
const PACKAGE_NAME = "@dillydalli3r/omp-supreme-token-saver";

test("a dry-run install proposes the same config.yml change twice and writes nothing", () => {
  const { home, cwd } = sandbox();
  const original = "theme: dark\nextensions:\n  - /keep/index.js\n";
  seedConfig(home, original);

  const first = run(["install", "--dry-run", "--yes"], { home, cwd });
  const second = run(["install", "--dry-run", "--yes"], { home, cwd });

  assert.equal(first.code, 0, first.out);
  assert.equal(second.code, 0, second.out);
  assert.match(first.out, /would add token-saver to config\.yml/);
  // Same proposal both times: nothing about the install drifts between two runs.
  assert.equal(first.out, second.out);
  assert.equal(readFileSync(configPath(home), "utf8"), original);
});

test("an already-registered extension is not proposed again", () => {
  const { home, cwd } = sandbox();
  const registered = `extensions:\n  - ${normalize(join(userExtDir(home), "token-saver", "index.js"))}\n`;
  seedConfig(home, registered);

  const result = run(["install", "--dry-run", "--yes"], { home, cwd });

  assert.equal(result.code, 0, result.out);
  assert.doesNotMatch(result.out, /would add token-saver/);
  assert.equal(readFileSync(configPath(home), "utf8"), registered);
});

test("uninstall removes its entries once, backs config.yml up once, and is a no-op after that", () => {
  const { home, cwd } = sandbox();
  seedTree(userExtDir(home), MANAGED_DIRS);
  const tokenSaverEntry = `  - ${normalize(join(userExtDir(home), "token-saver", "index.js"))}`;
  const original = `theme: dark\nextensions:\n  - /keep/index.js\n${tokenSaverEntry}\n  - /keep2/index.js\n`;
  seedConfig(home, original);

  const first = run(["uninstall", "--scope", "user", "--yes"], { home, cwd });
  assert.equal(first.code, 0, first.out);
  const after = readFileSync(configPath(home), "utf8");
  assert.equal(after, "theme: dark\nextensions:\n  - /keep/index.js\n  - /keep2/index.js\n");
  // The backup holds the file as it was before the first edit this tool made.
  assert.equal(readFileSync(`${configPath(home)}.bak`, "utf8"), original);

  const second = run(["uninstall", "--scope", "user", "--yes"], { home, cwd });
  assert.equal(second.code, 0, second.out);
  assert.equal(readFileSync(configPath(home), "utf8"), after);
  assert.equal(readFileSync(`${configPath(home)}.bak`, "utf8"), original);
});

test("a flow-style extensions list is expanded instead of spliced into invalid YAML", () => {
  const { home, cwd } = sandbox();
  seedTree(userExtDir(home), ["caveman-session"]);
  const tokenSaverEntry = normalize(join(userExtDir(home), "token-saver", "index.js"));
  seedConfig(home, `extensions: [/keep/index.js, ${tokenSaverEntry}]\n`);

  const result = run(["uninstall", "--scope", "user", "--yes"], { home, cwd });

  assert.equal(result.code, 0, result.out);
  // Block form, unrelated entry kept, and no flow bracket left behind for the next edit to trip on.
  assert.equal(readFileSync(configPath(home), "utf8"), "extensions:\n  - /keep/index.js\n");
});

test("a CRLF config.yml keeps CRLF endings through a rewrite", () => {
  const { home, cwd } = sandbox();
  seedTree(userExtDir(home), ["token-saver"]);
  const tokenSaverEntry = `  - ${normalize(join(userExtDir(home), "token-saver", "index.js"))}`;
  const original = `theme: dark\r\nextensions:\r\n  - /keep/index.js\r\n${tokenSaverEntry}\r\n`;
  seedConfig(home, original);

  const result = run(["uninstall", "--scope", "user", "--yes"], { home, cwd });

  assert.equal(result.code, 0, result.out);
  const after = readFileSync(configPath(home), "utf8");
  assert.equal(after, "theme: dark\r\nextensions:\r\n  - /keep/index.js\r\n");
  assert.ok(!/[^\r]\n/.test(after), `bare LF left in a CRLF file: ${JSON.stringify(after)}`);
});

test("a rewrite that would leave an unreadable extensions section is rolled back", () => {
  const { home, cwd } = sandbox();
  seedTree(userExtDir(home), ["token-saver"]);
  const original = `theme: dark\nextensions: [a, b\n  - ${normalize(join(userExtDir(home), "token-saver", "index.js"))}\n`;
  seedConfig(home, original);

  const result = run(["uninstall", "--scope", "user", "--yes"], { home, cwd });

  assert.notEqual(result.code, 0, result.out);
  assert.match(result.out, /unreadable extensions section/);
  assert.equal(readFileSync(configPath(home), "utf8"), original);
  const leftovers = readdirSync(userAgentDir(home)).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "a temp file was left behind");
});

test("uninstall takes the project tree its scope installed, updater included", () => {
  const { home, cwd } = sandbox();
  seedTree(userExtDir(home), MANAGED_DIRS);
  seedTree(projectExtDir(cwd), PROJECT_DIRS);
  const original = `extensions:\n  - ${normalize(join(userExtDir(home), "token-saver", "index.js"))}\n`;
  seedConfig(home, original);

  const projectRun = run(["uninstall", "--scope", "project", "--yes"], { home, cwd });
  assert.equal(projectRun.code, 0, projectRun.out);
  for (const name of PROJECT_DIRS) {
    assert.ok(!existsSync(join(projectExtDir(cwd), name)), `${name} survived a project uninstall`);
  }
  // A project uninstall never touches the user tree or its config.yml entries.
  for (const name of MANAGED_DIRS) assert.ok(existsSync(join(userExtDir(home), name)), `${name} lost by a project uninstall`);
  assert.equal(readFileSync(configPath(home), "utf8"), original);

  const userRun = run(["uninstall", "--scope", "user", "--yes"], { home, cwd });
  assert.equal(userRun.code, 0, userRun.out);
  for (const name of MANAGED_DIRS) assert.ok(!existsSync(join(userExtDir(home), name)), `${name} survived a user uninstall`);
  assert.equal(readFileSync(configPath(home), "utf8"), "extensions:\n");
});

test("--legacy-only cuts the tree over without touching the plugin cache or the rtk binary", () => {
  const { home, cwd } = sandbox();
  seedTree(userExtDir(home), MANAGED_DIRS);
  seedConfig(home, `extensions:\n  - ${normalize(join(userExtDir(home), "token-saver", "index.js"))}\n`);
  const pluginsDir = join(home, ".omp", "plugins");
  const rtkBin = join(home, ".bun", "bin", process.platform === "win32" ? "rtk.exe" : "rtk");
  seedFile(join(pluginsDir, "package.json"), "{\"name\":\"omp-plugins\"}\n");
  seedFile(join(pluginsDir, "package.json.bak"), "{\"name\":\"omp-plugins\"}\n");
  seedFile(rtkBin, "rtk\n");

  const result = run(["uninstall", "--legacy-only", "--yes"], { home, cwd });

  assert.equal(result.code, 0, result.out);
  const leftovers = readdirSync(userExtDir(home));
  assert.deepEqual(leftovers, [], `legacy tree survived: ${leftovers.join(", ")}`);
  assert.equal(readFileSync(configPath(home), "utf8"), "extensions:\n");
  // A plugin install needs both of these: the cutover leaves them alone.
  assert.ok(existsSync(join(pluginsDir, "package.json")), "plugin manifest removed by the cutover");
  assert.ok(existsSync(join(pluginsDir, "package.json.bak")), "plugin manifest backup removed by the cutover");
  assert.ok(existsSync(rtkBin), "rtk binary removed by the cutover");
});

test("a second auto-discovered scope is refused instead of registering everything twice", () => {
  const { home, cwd } = sandbox();
  seedTree(userExtDir(home), ["caveman-session"]);

  const project = run(["install", "--scope", "project", "--yes"], { home, cwd });
  assert.equal(project.code, 1, project.out);
  assert.match(project.out, /register \/caveman and \/rtk twice/);
  assert.ok(!existsSync(projectExtDir(cwd)), "the refused install still wrote a project tree");

  const both = run(["install", "--scope", "both", "--yes"], { home, cwd });
  assert.equal(both.code, 1, both.out);
  assert.ok(!existsSync(projectExtDir(cwd)), "the refused install still wrote a project tree");

  // --force is the documented override, and it stays a preview here.
  const forced = run(["install", "--scope", "project", "--dry-run", "--yes", "--force"], { home, cwd });
  assert.equal(forced.code, 0, forced.out);
  assert.doesNotMatch(forced.out, /\[fail\]/);

  // The other direction, plus reinstall refusing before it cleans — a refusal must not leave the
  // tree half removed. The conflicting project tree has to exist for those to fire at all.
  seedTree(userExtDir(home), ["caveman-session"]);
  seedTree(projectExtDir(cwd), ["caveman-session"]);

  const userOverProject = run(["install", "--scope", "user", "--yes"], { home, cwd });
  assert.equal(userOverProject.code, 1, userOverProject.out);
  assert.match(userOverProject.out, /register \/caveman and \/rtk twice/);

  const reinstallRun = run(["reinstall", "--scope", "user", "--yes"], { home, cwd });
  assert.equal(reinstallRun.code, 1, reinstallRun.out);
  assert.ok(existsSync(join(userExtDir(home), "caveman-session")), "the refused reinstall removed the tree anyway");
});

test("plugin --dry-run previews the dependencies and writes nothing", () => {
  const { home, cwd } = sandbox();
  seedTree(userExtDir(home), ["caveman-session"]);
  seedConfig(home, "extensions:\n  - /keep/index.js\n");
  const before = snapshot(home);

  const result = run(["plugin", "--dry-run", "--yes"], { home, cwd });

  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /\[dry-run\] would run: omp plugin install/);
  assert.match(result.out, /\[dry-run\] would download rtk-/);
  assert.doesNotMatch(result.out, /\[ok\]|\[write\]|\[rm\]/);
  assert.deepEqual(snapshot(home), before, "a plugin dry run wrote to disk");
  assert.equal(readFileSync(configPath(home), "utf8"), "extensions:\n  - /keep/index.js\n");
});

test("plugin refuses to install next to a legacy tree", () => {
  const { home, cwd } = sandbox();
  seedTree(userExtDir(home), ["caveman-session"]);
  const before = snapshot(home);

  const result = run(["plugin", "--yes"], { home, cwd });

  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /--legacy-only/);
  assert.deepEqual(snapshot(home), before, "the refused plugin install wrote to disk");
});

test("doctor reports a drifted file as drift, not as installed", () => {
  const { home, cwd } = sandbox();
  seedTree(userExtDir(home), ["caveman-session"]);
  seedFile(join(userExtDir(home), "caveman-session", "rule.md"), "an older rule\n");
  // The plugin lock is one of the runtime's version sources; doctor has to read the same one.
  seedFile(
    join(home, ".omp", "plugins", "omp-plugins.lock.json"),
    `${JSON.stringify({ plugins: { [PACKAGE_NAME]: { version: "9.9.9" } } })}\n`,
  );

  const result = run(["doctor"], { home, cwd });

  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /Caveman rule\.md: drift/);
  assert.match(result.out, /Caveman extension: MISSING/);
  assert.match(result.out, /Installed version: 9\.9\.9 \(omp-plugins\.lock\.json\)/);
});
