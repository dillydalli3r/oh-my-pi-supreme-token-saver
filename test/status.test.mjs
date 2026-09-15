// Contract: every invocation path produces the same per-app status symbol, all three apps share
// one status row (one key), and the row clears when everything is off.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const EXT = join(dirname(fileURLToPath(import.meta.url)), "..", "extensions");

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
      setStatus: (key, text) => status.set(key, text),
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

  assert.deepEqual(rt.keys(), ["modes"]);
  assert.equal(rt.row(), "");
});

test("a session with /combo off entries stays off", async () => {
  const rt = await createRuntime([
    { type: "custom", customType: "caveman-mode", data: { mode: "off" }, id: "b1" },
    { type: "custom", customType: "rtk-mode", data: { enabled: false }, id: "b2" },
    { type: "custom", customType: "ponytail-mode", data: { mode: "off" }, id: "b3" },
    { type: "custom", customType: "combo-level", data: { level: "off" }, id: "b4" },
  ]);
  await rt.start();

  assert.equal(rt.row(), "");
});

test("subagents inherit caveman and rtk", async () => {
  const rt = await createRuntime();
  await rt.start();

  const prompt = await rt.runBeforeAgentStart(SUBAGENT_PROMPT);

  assert.match(prompt, /Caveman ultra/);
  assert.match(prompt, /RTK mode active/);
});
