// Contract: every invocation path produces the same per-app status symbol, all three apps share
// one status row (one key), and the row clears when everything is off.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXT = join(dirname(fileURLToPath(import.meta.url)), "..", "extensions");

// The defaults file and the ponytail plugin resolve under the real OMP home by default; point both
// at a temp tree so a test run never edits the developer's own config.
const SANDBOX = mkdtempSync(join(tmpdir(), "omp-combo-"));
const DEFAULTS_FILE = join(SANDBOX, "combo-defaults.json");
const PONYTAIL_DIR = join(SANDBOX, "ponytail");
const PONYTAIL_STUB = join(PONYTAIL_DIR, "stub-default.json");

process.env.OMP_COMBO_DEFAULTS_FILE = DEFAULTS_FILE;
process.env.OMP_PONYTAIL_PACKAGE_DIR = PONYTAIL_DIR;

mkdirSync(join(PONYTAIL_DIR, "hooks"), { recursive: true });
writeFileSync(join(PONYTAIL_DIR, "hooks", "ponytail-config.js"), `const fs = require("node:fs");
const path = require("node:path");
const file = path.join(__dirname, "..", "stub-default.json");
module.exports = {
  getDefaultMode: () => {
    try { return JSON.parse(fs.readFileSync(file, "utf8")).defaultMode; } catch { return "ultra"; }
  },
  writeDefaultMode: (mode) => { fs.writeFileSync(file, JSON.stringify({ defaultMode: mode })); return mode; },
};
`);

after(() => rmSync(SANDBOX, { recursive: true, force: true }));

// `/combo default` writes both the combo file and the ponytail plugin default, so the helpers do too.
const setDefaults = (modes) => {
  writeFileSync(DEFAULTS_FILE, JSON.stringify(modes));
  writeFileSync(PONYTAIL_STUB, JSON.stringify({ defaultMode: modes.ponytail }));
};
const clearDefaults = () => {
  rmSync(DEFAULTS_FILE, { force: true });
  rmSync(PONYTAIL_STUB, { force: true });
};
const stubPonytailDefault = () => {
  try { return JSON.parse(readFileSync(PONYTAIL_STUB, "utf8")).defaultMode; } catch { return null; }
};

const EXTENSION_FILES = [
  join(EXT, "caveman-session", "index.js"),
  join(EXT, "rtk-session", "index.js"),
  join(EXT, "combo-toggle", "index.js"),
  join(EXT, "shared", "mode-reinforcement.js"),
];

const SUBAGENT_PROMPT = "You are operating on a piece of work assigned to you by the main agent.";

function zodStub() {
  const chain = new Proxy(function () {}, {
    get: (_t, prop) =>
      ["describe", "min", "max", "optional", "default"].includes(prop) ? () => chain : chain,
    apply: () => chain,
  });
  return new Proxy({}, { get: () => () => chain });
}

async function createRuntime(branch = []) {
  const handlers = new Map();
  const commands = new Map();
  const status = new Map();
  const notifications = [];
  const intervals = [];
  const entries = [...branch];

  const pi = {
    cwd: process.cwd(),
    zod: { z: zodStub() },
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    setLabel() {},
    registerTool() {},
    appendEntry(customType, data) {
      entries.push({ type: "custom", customType, data, id: `entry-${entries.length}` });
    },
    registerCommand(name, def) {
      commands.set(name, def);
    },
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) || []), handler]);
    },
  };

  const ctx = {
    hasUI: true,
    cwd: process.cwd(),
    ui: {
      // omp's setHookStatus deletes the key for `undefined` and keeps any other string.
      setStatus: (key, text) => {
        if (text === undefined) status.delete(key);
        else status.set(key, text);
      },
      notify: (text, type) => notifications.push({ text, type }),
    },
    sessionManager: { getBranch: () => entries },
    setInterval: (fn) => {
      intervals.push(fn);
      return fn;
    },
    clearTimer: () => {},
  };

  const emit = async (event, payload = {}) => {
    for (const handler of handlers.get(event) || []) await handler(payload, ctx);
  };

  // `/combo` reloads the session so sibling extensions re-read the branch.
  ctx.reload = () => emit("session_start", {});

  for (const file of EXTENSION_FILES) {
    const mod = await import(pathToFileURL(file).href);
    (mod.default || mod)(pi);
  }

  const appendEntry = (customType, data) => pi.appendEntry(customType, data);

  return {
    ctx,
    status,
    entries,
    notifications,
    appendEntry,
    handlers: (event) => handlers.get(event) || [],
    row: () => status.get("modes"),
    keys: () => [...status.keys()],
    run: async (name, args = "") => {
      const command = commands.get(name);
      assert.ok(command, `command /${name} is registered`);
      await command.handler(args, ctx);
    },
    start: () => emit("session_start", {}),
    tickWatcher: async () => {
      for (const fn of intervals) await fn();
    },
    runBeforeAgentStart: async (systemPrompt) => {
      let prompt = systemPrompt;
      for (const handler of handlers.get("before_agent_start") || []) {
        const res = await handler({ systemPrompt: prompt }, ctx);
        if (res?.systemPrompt) prompt = res.systemPrompt;
      }
      return Array.isArray(prompt) ? prompt.join("\n") : prompt;
    },
  };
}

const appSegment = (row, app) =>
  String(row)
    .split(" · ")
    .find((part) => new RegExp(`\\b${app}: `).test(part)) || null;

test("fresh session: one status row with stable markers for all three apps", async () => {
  const rt = await createRuntime();
  await rt.start();

  assert.deepEqual(rt.keys(), ["modes"]);
  assert.equal(rt.row(), "🧩 MAX · 🦴 caveman: ULTRA · 🦀 rtk: ON · 🐴 ponytail: ULTRA");
});

test("session start is silent: no add-on announces itself loading", async () => {
  const rt = await createRuntime();
  await rt.start();

  assert.deepEqual(rt.notifications, []);
});

test("combo, per-app commands and the plugin default agree on every per-app symbol", async () => {
  const combo = await createRuntime();
  await combo.start();
  await combo.run("combo", "max");

  const manual = await createRuntime();
  await manual.start();
  await manual.run("caveman", "ultra");
  await manual.run("rtk", "on");
  // The ponytail plugin writes this from its own `/ponytail` command.
  manual.appendEntry("ponytail-mode", { mode: "ultra" });
  await manual.tickWatcher();

  for (const app of ["caveman", "rtk", "ponytail"]) {
    assert.equal(appSegment(manual.row(), app), appSegment(combo.row(), app));
  }
  assert.equal(manual.row(), combo.row());
});

test("per-app commands stay on the single row and update in place", async () => {
  const rt = await createRuntime();
  await rt.start();

  await rt.run("caveman", "full");
  assert.deepEqual(rt.keys(), ["modes"]);
  assert.match(rt.row(), /🦴 caveman: FULL/);
  assert.match(rt.row(), /🦀 rtk: ON/);
  assert.match(rt.row(), /🐴 ponytail: ULTRA/);

  await rt.run("caveman", "off");
  assert.deepEqual(rt.keys(), ["modes"]);
  assert.match(rt.row(), /🦴 caveman: OFF/);
});

test("a ponytail-mode entry written by the plugin reaches the row", async () => {
  const rt = await createRuntime();
  await rt.start();

  rt.appendEntry("ponytail-mode", { mode: "lite" });
  await rt.tickWatcher();

  assert.deepEqual(rt.keys(), ["modes"]);
  assert.match(rt.row(), /🐴 ponytail: LITE/);
});

test("everything off clears the row", async () => {
  const rt = await createRuntime();
  await rt.start();
  await rt.run("combo", "off");

  assert.deepEqual(rt.keys(), [], "an empty status string still draws a row, so the key must go");
});

test("a session with /combo off entries stays off", async () => {
  const rt = await createRuntime([
    { type: "custom", customType: "caveman-mode", data: { mode: "off" }, id: "b1" },
    { type: "custom", customType: "rtk-mode", data: { enabled: false }, id: "b2" },
    { type: "custom", customType: "ponytail-mode", data: { mode: "off" }, id: "b3" },
    { type: "custom", customType: "combo-level", data: { level: "off" }, id: "b4" },
  ]);
  await rt.start();

  assert.deepEqual(rt.keys(), []);
});

test("subagents inherit caveman and rtk", async () => {
  const rt = await createRuntime();
  await rt.start();

  const prompt = await rt.runBeforeAgentStart(SUBAGENT_PROMPT);

  assert.match(prompt, /Caveman ultra/);
  assert.match(prompt, /RTK mode active/);
});

test("a fresh session starts from the persisted default", async () => {
  setDefaults({ caveman: "off", rtk: "off", ponytail: "off" });
  try {
    const rt = await createRuntime();
    await rt.start();
    assert.deepEqual(rt.keys(), []);
  } finally {
    clearDefaults();
  }
});

test("per-app defaults derive a custom level for fresh sessions", async () => {
  setDefaults({ caveman: "lite", rtk: "on", ponytail: "ultra" });
  try {
    const rt = await createRuntime();
    await rt.start();
    assert.match(rt.row(), /^🧩 CUSTOM · 🦴 caveman: LITE · 🦀 rtk: ON · 🐴 ponytail: ULTRA$/);
  } finally {
    clearDefaults();
  }
});

test("/combo default persists a level without changing the running session", async () => {
  const rt = await createRuntime();
  await rt.start();
  const running = rt.row();

  await rt.run("combo", "default medium");

  assert.equal(rt.row(), running, "the running session keeps its level");
  assert.deepEqual(JSON.parse(readFileSync(DEFAULTS_FILE, "utf8")), {
    caveman: "lite",
    rtk: "on",
    ponytail: "lite",
  });
  assert.equal(stubPonytailDefault(), "lite", "the ponytail plugin default is synced");

  const fresh = await createRuntime();
  await fresh.start();
  assert.match(fresh.row(), /^🧩 MEDIUM · 🦴 caveman: LITE · 🦀 rtk: ON · 🐴 ponytail: LITE$/);

  await fresh.run("combo", "default reset");
  assert.equal(existsSync(DEFAULTS_FILE), false, "reset drops the override");
  assert.equal(stubPonytailDefault(), "ultra", "reset returns ponytail to the built-in default");

  const reset = await createRuntime();
  await reset.start();
  assert.match(reset.row(), /^🧩 MAX · 🦴 caveman: ULTRA · 🦀 rtk: ON · 🐴 ponytail: ULTRA$/);
});

test("a caveman/rtk-only default leaves the ponytail plugin default alone", async () => {
  setDefaults({ caveman: "lite", rtk: "on", ponytail: "ultra" });
  // The user chose this with /ponytail default lite; a partial /combo default must not clobber it.
  writeFileSync(PONYTAIL_STUB, JSON.stringify({ defaultMode: "lite" }));
  try {
    const rt = await createRuntime();
    await rt.start();

    await rt.run("combo", "default caveman=off rtk=off");

    assert.equal(stubPonytailDefault(), "lite", "the ponytail default is untouched");
    assert.deepEqual(JSON.parse(readFileSync(DEFAULTS_FILE, "utf8")), {
      caveman: "off",
      rtk: "off",
      ponytail: "ultra",
    });
    assert.match(rt.notifications.at(-1).text, /^Combo default for new sessions: CUSTOM \(caveman=off rtk=off ponytail=lite\)/);
  } finally {
    clearDefaults();
  }
});

test("a default the ponytail plugin cannot run is refused", async () => {
  clearDefaults();
  try {
    const rt = await createRuntime();
    await rt.start();

    await rt.run("combo", "default ponytail=review");

    assert.equal(existsSync(DEFAULTS_FILE), false);
    assert.match(rt.notifications.at(-1).text, /^Usage: \/combo default/);
  } finally {
    clearDefaults();
  }
});
