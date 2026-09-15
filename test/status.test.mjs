// Contract: the pack renders exactly one status row (key `modes`) whose seven knob segments are
// byte-identical no matter which command set them, `/ts` is the only writer of what a new session
// starts from, mode instructions reach subagents exactly once per mode set, and no extension
// rewrites message history or tool output.

import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXT = join(dirname(fileURLToPath(import.meta.url)), "..", "extensions");

// The config, the pre-2.0 defaults file and the ponytail plugin all resolve under the real OMP home
// by default; point all three at a temp tree so a test run never edits the developer's own install.
const SANDBOX = mkdtempSync(join(tmpdir(), "omp-token-saver-"));
const CONFIG_FILE = join(SANDBOX, "token-saver.json");
const LEGACY_DEFAULTS_FILE = join(SANDBOX, "combo-defaults.json");
const PONYTAIL_DIR = join(SANDBOX, "ponytail");
const PONYTAIL_STUB = join(PONYTAIL_DIR, "stub-default.json");
// A directory that does not exist: what a user without the plugin installed looks like.
const ABSENT_PONYTAIL_DIR = join(SANDBOX, "no-ponytail");

process.env.OMP_TOKEN_SAVER_CONFIG = CONFIG_FILE;
process.env.OMP_COMBO_DEFAULTS_FILE = LEGACY_DEFAULTS_FILE;
process.env.OMP_PONYTAIL_PACKAGE_DIR = PONYTAIL_DIR;

// The ponytail plugin owns its own default (its command writes this module), so the stub stands in
// for the real one rather than for one of our modules.
mkdirSync(join(PONYTAIL_DIR, "hooks"), { recursive: true });
writeFileSync(
  join(PONYTAIL_DIR, "hooks", "ponytail-config.js"),
  `const fs = require("node:fs");
const path = require("node:path");
const file = path.join(__dirname, "..", "stub-default.json");
module.exports = {
  getDefaultMode: () => {
    try { return JSON.parse(fs.readFileSync(file, "utf8")).defaultMode; } catch { return "ultra"; }
  },
  writeDefaultMode: (mode) => { fs.writeFileSync(file, JSON.stringify({ defaultMode: mode })); return mode; },
};
`
);

after(() => rmSync(SANDBOX, { recursive: true, force: true }));

// Both files mean "a stored default"; a test that wants the built-in defaults starts by deleting them.
const clearSandboxFiles = () => {
  for (const file of [CONFIG_FILE, LEGACY_DEFAULTS_FILE, PONYTAIL_STUB]) rmSync(file, { force: true });
};

beforeEach(clearSandboxFiles);

const stubPonytailDefault = () => {
  try { return JSON.parse(readFileSync(PONYTAIL_STUB, "utf8")).defaultMode; } catch { return null; }
};

const withoutPonytailPlugin = async (run) => {
  const previous = process.env.OMP_PONYTAIL_PACKAGE_DIR;
  process.env.OMP_PONYTAIL_PACKAGE_DIR = ABSENT_PONYTAIL_DIR;
  try { return await run(); } finally { process.env.OMP_PONYTAIL_PACKAGE_DIR = previous; }
};

// mode-reinforcement.js is the only writer of the model-facing reminder line; its closing sentence
// is the part that differs for a subagent.
const SUBAGENT_PROMPT = "You are operating on a piece of work assigned to you by the main agent.";
const SUBAGENT_TAIL = "Do not weaken or disable a mode unless the main agent asks for it.";

// The built-in default session, rendered: preset marker plus all seven knob segments.
const MAX_ROW = "🧩 MAX · 🦴 caveman: ULTRA · 🦀 rtk: ON · 🐴 ponytail: ULTRA · 📖 read: FULL · 🗜️ compress: FULL · 🧹 prune: FULL · 🔁 auto: ON";

const EXTENSION_FILES = [
  join(EXT, "caveman-session", "index.js"),
  join(EXT, "rtk-session", "index.js"),
  join(EXT, "token-saver", "index.js"),
  join(EXT, "shared", "mode-reinforcement.js"),
];

// Every pi.exec call any runtime in this file made; the last test reads it back.
const ALL_EXEC = [];

const segments = (row) => String(row).split(" · ");
const occurrences = (text, needle) => String(text).split(needle).length - 1;

function zodStub() {
  const chain = new Proxy(function () {}, {
    get: (_t, prop) =>
      ["describe", "min", "max", "optional", "default"].includes(prop) ? () => chain : chain,
    apply: () => chain,
  });
  return new Proxy({}, { get: () => () => chain });
}

async function createRuntime(branch = [], files = EXTENSION_FILES) {
  const handlers = new Map();
  const commands = new Map();
  const status = new Map();
  const notifications = [];
  const intervals = [];
  const execCalls = [];
  const entries = [...branch];
  let usage;
  let execImpl = async () => ({ code: 0, stdout: "", stderr: "" });

  const pi = {
    cwd: process.cwd(),
    zod: { z: zodStub() },
    exec: async (command, args, options) => {
      const call = { command, args: [...(args || [])], options };
      ALL_EXEC.push(call);
      execCalls.push(call);
      return execImpl(command, args, options);
    },
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
    getContextUsage: () => usage,
    ui: {
      // OMP deletes the key on `undefined` and keeps any other string, including "".
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
    const results = [];
    for (const handler of handlers.get(event) || []) results.push(await handler(payload, ctx));
    return results;
  };

  // `/ts` reloads the session so sibling extensions re-read the branch.
  ctx.reload = () => emit("session_start", {});

  for (const file of files) {
    const mod = await import(pathToFileURL(file).href);
    (mod.default || mod)(pi);
  }

  return {
    ctx,
    status,
    entries,
    notifications,
    execCalls,
    emit,
    appendEntry: (customType, data) => pi.appendEntry(customType, data),
    handlers: (event) => handlers.get(event) || [],
    events: () => [...handlers.keys()],
    row: (key = "modes") => status.get(key),
    keys: () => [...status.keys()],
    setUsage: (value) => {
      usage = value;
    },
    setExec: (impl) => {
      execImpl = impl;
    },
    clearExecCalls: () => {
      execCalls.length = 0;
    },
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

test("a fresh session renders one row: the default preset with all seven knob segments", async () => {
  const rt = await createRuntime();
  await rt.start();

  assert.deepEqual(rt.keys(), ["modes"], "the pack owns one status row");
  assert.equal(rt.row(), MAX_ROW);
  assert.equal(segments(rt.row()).length, 8, "preset marker + seven knobs");
});

test("session start is silent: no add-on announces itself loading", async () => {
  const rt = await createRuntime();
  await rt.start();

  assert.deepEqual(rt.notifications, []);
});

test("every invocation path renders the same row for the same knob values", async () => {
  const fresh = await createRuntime();
  await fresh.start();
  const defaultRow = fresh.row();

  const viaCombo = await createRuntime();
  await viaCombo.start();
  await viaCombo.run("combo", "max");
  const comboRow = viaCombo.row();

  const viaTsPreset = await createRuntime();
  await viaTsPreset.start();
  await viaTsPreset.run("ts", "preset max");
  const tsPresetRow = viaTsPreset.row();

  // The ponytail plugin writes this entry from its own `/ponytail` command.
  const viaPerApp = await createRuntime();
  await viaPerApp.start();
  await viaPerApp.run("caveman", "ultra");
  await viaPerApp.run("rtk", "on");
  viaPerApp.appendEntry("ponytail-mode", { mode: "ultra" });
  await viaPerApp.tickWatcher();
  const perAppRow = viaPerApp.row();

  assert.equal(comboRow, defaultRow, "/combo max matches a fresh max session");
  assert.equal(tsPresetRow, defaultRow, "/ts preset max matches a fresh max session");
  assert.equal(perAppRow, defaultRow, "per-app commands match the preset they describe");

  const viaTsLite = await createRuntime();
  await viaTsLite.start();
  await viaTsLite.run("ts", "preset lite");
  const liteRow = viaTsLite.row();

  const liteViaCombo = await createRuntime();
  await liteViaCombo.start();
  await liteViaCombo.run("combo", "lite");
  const liteComboRow = liteViaCombo.row();

  const liteKnobByKnob = await createRuntime();
  await liteKnobByKnob.start();
  await liteKnobByKnob.run("ts", "set caveman=lite ponytail=lite read=off compress=lite prune=off");
  const liteKnobsRow = liteKnobByKnob.row();

  assert.match(liteRow, /^🧩 LITE · /);
  assert.equal(liteComboRow, liteRow, "/combo lite matches /ts preset lite");
  assert.equal(liteKnobsRow, liteRow, "setting the same values knob by knob matches the preset");
});

test("a per-knob override changes only its segments, derives CUSTOM, and replays from the branch", async () => {
  const rt = await createRuntime();
  await rt.start();
  const before = rt.row();

  await rt.run("ts", "set caveman=wenyan prune=off");
  const after = rt.row();

  assert.equal(
    after,
    "🧩 CUSTOM · 🦴 caveman: WENYAN · 🦀 rtk: ON · 🐴 ponytail: ULTRA · 📖 read: FULL · 🗜️ compress: FULL · 🧹 prune: OFF · 🔁 auto: ON"
  );
  const changed = segments(after).filter((part, index) => part !== segments(before)[index]);
  assert.deepEqual(changed, ["🧩 CUSTOM", "🦴 caveman: WENYAN", "🧹 prune: OFF"]);

  const replay = await createRuntime(rt.entries);
  await replay.start();
  assert.equal(replay.row(), after, "a session started from the same branch restores the override");
});

test("a preset default changes new sessions only, and reset returns them to max", async () => {
  const rt = await createRuntime();
  await rt.start();
  const running = rt.row();

  await rt.run("ts", "default lite");
  assert.equal(rt.row(), running, "the running session keeps its preset");
  assert.equal(existsSync(CONFIG_FILE), true, "the new default is persisted");

  const fresh = await createRuntime();
  await fresh.start();
  assert.match(fresh.row(), /^🧩 LITE · /);
  assert.equal(stubPonytailDefault(), "lite", "the ponytail plugin default follows the preset");

  await rt.run("ts", "default reset");
  assert.equal(existsSync(CONFIG_FILE), false, "reset drops the stored default");
  assert.equal(stubPonytailDefault(), "ultra", "reset restores the built-in ponytail default");

  const reset = await createRuntime();
  await reset.start();
  assert.equal(reset.row(), MAX_ROW);
});

test("a per-knob default derives a custom default and reports the ponytail sync state", async () => {
  const rt = await createRuntime();
  await rt.start();

  await rt.run("ts", "default caveman=wenyan");
  const synced = rt.notifications.at(-1);
  assert.match(synced.text, /Default for new sessions: CUSTOM/);
  assert.match(synced.text, /caveman=wenyan/);
  assert.doesNotMatch(synced.text, /pending/i, "a synced plugin reports no pending work");

  const fresh = await createRuntime();
  await fresh.start();
  assert.match(fresh.row(), /^🧩 CUSTOM · 🦴 caveman: WENYAN · /);

  await withoutPonytailPlugin(async () => {
    await rt.run("ts", "default ponytail=full");
    const pending = rt.notifications.at(-1);
    assert.equal(pending.type, "warning");
    assert.match(pending.text, /Ponytail plugin not found/);
  });
});

test("status=off deletes the row while the other knobs stay applied", async () => {
  const rt = await createRuntime();
  await rt.start();

  await rt.run("ts", "set caveman=lite status=off");
  assert.deepEqual(rt.keys(), [], "an off status deletes the key instead of leaving it empty");
  assert.equal(rt.row(), undefined);

  await rt.run("ts", "status");
  const report = rt.notifications.at(-1).text;
  assert.match(report, /caveman=lite/, "the other knobs are still set");
  assert.match(report, /status=off/);
  assert.deepEqual(rt.keys(), [], "reporting status does not resurrect the row");

  await rt.run("ts", "set status=full");
  assert.deepEqual(rt.keys(), ["modes"]);
  assert.match(rt.row(), /🦴 caveman: LITE/);
});

test("subagent prompts inherit the caveman and rtk blocks", async () => {
  const rt = await createRuntime();
  await rt.start();

  const prompt = await rt.runBeforeAgentStart(SUBAGENT_PROMPT);

  assert.match(prompt, /Caveman ultra active for this session/);
  assert.match(prompt, /RTK mode active for this session/);
  assert.equal(occurrences(prompt, SUBAGENT_TAIL), 1, "the reinforcement line is added once");
});

test("the mode-reinforcement line is appended at most once for a mode set", async () => {
  const rt = await createRuntime([], [join(EXT, "shared", "mode-reinforcement.js")]);
  await rt.start();

  const first = await rt.runBeforeAgentStart(SUBAGENT_PROMPT);
  assert.equal(occurrences(first, SUBAGENT_TAIL), 1);

  const second = await rt.runBeforeAgentStart(first);
  assert.equal(second, first, "re-asserting the same mode set appends nothing");
});

test("nothing is appended when every knob is off", async () => {
  const rt = await createRuntime();
  await rt.start();
  await rt.run("ts", "preset off");

  assert.deepEqual(rt.keys(), ["modes"], "the row stays: it reports that everything is off");

  const prompt = await rt.runBeforeAgentStart(SUBAGENT_PROMPT);
  assert.equal(prompt, SUBAGENT_PROMPT, "no mode is active, so no instruction is injected");
});

test("the meter renders the context usage it is handed", async () => {
  const rt = await createRuntime();
  await rt.start();

  rt.setUsage({ percent: 42 });
  await rt.emit("turn_end", {});
  assert.match(rt.row(), /👁 42% ctx/);
  assert.match(rt.row(), /^🧩 MAX · /);

  rt.setUsage(undefined);
  await rt.emit("turn_end", {});
  assert.equal(rt.row(), MAX_ROW, "no usage, no meter, no throw");
});

test("autoRtk off never spawns rtk and leaves the command alone", async () => {
  const rt = await createRuntime();
  await rt.start();
  await rt.run("rtk", "auto off");

  rt.setExec(async () => {
    throw new Error("autoRtk is off; rtk must not be spawned");
  });
  rt.clearExecCalls();

  const event = { toolName: "bash", input: { command: "git status" } };
  const [result] = await rt.emit("tool_call", event);

  assert.equal(result, undefined);
  assert.deepEqual(rt.execCalls, []);
  assert.deepEqual(event.input, { command: "git status" });
});

test("autoRtk on returns a revised command without mutating the event", async () => {
  const rt = await createRuntime();
  await rt.start();
  rt.setExec(async (_command, args) =>
    args.includes("rewrite")
      ? { code: 0, stdout: "rtk git log --oneline -5", stderr: "" }
      : { code: 0, stdout: "", stderr: "" }
  );

  const event = { toolName: "bash", input: { command: "git log --oneline -5", timeout: 5000 } };
  const [result] = await rt.emit("tool_call", event);

  assert.deepEqual(result, { input: { command: "rtk git log --oneline -5", timeout: 5000 } });
  assert.deepEqual(event.input, { command: "git log --oneline -5", timeout: 5000 });
  assert.equal(rt.execCalls.length, 1, "one rewrite subprocess");
});

test("shell syntax, an existing rtk prefix and the exclude list all skip the subprocess", async () => {
  const rt = await createRuntime();
  await rt.start();

  rt.setExec(async () => {
    throw new Error("this command must not be handed to rtk");
  });

  for (const command of [
    "cat notes.md | head -5",
    "npm run build && npm run test",
    "ls; ls",
    "echo `date`",
    "echo $(date)",
    "rtk git status",
  ]) {
    rt.clearExecCalls();
    const [result] = await rt.emit("tool_call", { toolName: "bash", input: { command } });
    assert.equal(result, undefined, `no rewrite for ${command}`);
    assert.deepEqual(rt.execCalls, [], `no subprocess for ${command}`);
  }

  await rt.run("ts", 'option autoRtk.exclude=["git log"]');
  await rt.start();

  rt.clearExecCalls();
  const [excluded] = await rt.emit("tool_call", { toolName: "bash", input: { command: "git log --all" } });
  assert.equal(excluded, undefined, "an excluded command is left alone");
  assert.deepEqual(rt.execCalls, []);
});

test("the pack registers no context and no tool_result handler", async () => {
  const rt = await createRuntime();
  await rt.start();

  assert.deepEqual(rt.handlers("context"), [], "message history is OMP's to rewrite");
  assert.deepEqual(rt.handlers("tool_result"), [], "tool output is OMP's to rewrite");
  assert.deepEqual(
    rt.events().filter((event) => event === "context" || event === "tool_result"),
    [],
    "the registered event map carries neither"
  );
});

test("/ts native status renders the key table and a missing omp degrades to a warning", async () => {
  const rt = await createRuntime();
  await rt.start();
  rt.setExec(async (_command, args) => {
    const argv = args.join(" ");
    if (argv.includes("config list")) {
      return {
        code: 0,
        stdout: JSON.stringify({
          "read.defaultLimit": { value: 200 },
          "read.summarize.enabled": { value: true },
        }),
        stderr: "",
      };
    }
    if (argv.includes("config path")) return { code: 0, stdout: join(SANDBOX, "agent"), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });

  await rt.run("ts", "native status");
  const table = rt.notifications.at(-1);
  assert.equal(table.type, "info");
  assert.match(table.text, /Native OMP settings/);
  assert.match(table.text, /read\.defaultLimit: 200/);
  assert.match(table.text, /read\.summarize\.enabled: true/);
  assert.ok(
    (table.text.match(/^[=→] \S+:/gm) || []).length >= 10,
    "every mapped key gets a row"
  );

  const broken = await createRuntime();
  await broken.start();
  broken.setExec(async () => {
    throw new Error("spawn omp ENOENT");
  });

  await broken.run("ts", "native status");
  const warning = broken.notifications.at(-1);
  assert.equal(warning.type, "warning");
  assert.match(warning.text, /Unavailable: spawn omp ENOENT/);
});

// Last: reads back every pi.exec call the whole file made. Nothing above may drive `omp config
// set` / `reset` — only the tests that stub `omp` explicitly would be allowed to.
test("no test path writes native OMP settings", () => {
  assert.ok(ALL_EXEC.length > 0, "the file exercised the exec seam");
  const writes = ALL_EXEC.filter((call) => /config (set|reset)/.test(call.args.join(" ")));
  assert.deepEqual(writes, []);
});

test("/ts set accepts a camelCase knob typed in any case", async () => {
  const rt = await createRuntime();
  await rt.start();

  await rt.run("ts", "set autoRtk=off");
  assert.match(rt.row(), /🔁 auto: OFF/);
  assert.deepEqual(
    rt.entries.filter((entry) => entry.customType === "ts-mode").map((entry) => entry.data),
    [{ name: "autoRtk", value: "off" }],
    "the knob is stored under its canonical name"
  );

  await rt.run("ts", "set AUTORTK=on");
  assert.match(rt.row(), /🔁 auto: ON/);
});

test("/combo keeps the pre-2.0 default verb and refuses the newer knobs", async () => {
  const rt = await createRuntime();
  await rt.start();
  const running = rt.row();

  await rt.run("combo", "default lite");
  assert.equal(rt.row(), running, "the running session keeps its preset");
  assert.match(rt.notifications.at(-1).text, /Default for new sessions: LITE/);

  await rt.run("combo", "set caveman=lite");
  const refused = rt.notifications.at(-1);
  assert.equal(refused.type, "warning");
  assert.match(refused.text, /Unknown preset: set/);
  assert.equal(rt.row(), running, "a refused verb changes nothing");
});

// Headroom is detect-and-guide: the pack never bundles it (a Python package with a CPython-extension
// core), never wraps automatically (the wrap launches its own omp), and only redirects the anthropic
// provider, so these tests pin the report, the in-session-safe half and the two refusals.
const headroomCall = (call) => [call.command, ...call.args].join(" ");

test("/ts headroom reports the installed version and this session's provider", async () => {
  const rt = await createRuntime();
  await rt.start();
  rt.setExec(async () => ({ code: 0, stdout: "headroom, version 0.37.0\n", stderr: "" }));

  rt.clearExecCalls();
  await rt.run("ts", "headroom");
  const report = rt.notifications.at(-1);
  assert.equal(report.type, "info");
  assert.match(report.text, /Headroom: headroom, version 0\.37\.0/);
  assert.match(report.text, /wrap omp/, "the external command is printed");
  assert.equal(rt.execCalls.length, 1, "one version probe");
  assert.match(headroomCall(rt.execCalls[0]), /headroom --version$/);

  // The alias surface reaches the same verb, and the provider line never claims a saving.
  await rt.run("token-saver", "headroom status");
  assert.match(rt.notifications.at(-1).text, /Headroom: headroom, version 0\.37\.0/);
  assert.match(rt.notifications.at(-1).text, /Session provider: unknown/);

  const openai = await createRuntime();
  await openai.start();
  openai.setExec(async () => ({ code: 0, stdout: "headroom, version 0.37.0", stderr: "" }));
  openai.ctx.models = { current: () => ({ provider: "openai" }) };

  await openai.run("ts", "headroom status");
  const other = openai.notifications.at(-1);
  assert.match(other.text, /Session provider: openai/);
  assert.match(other.text, /a wrap changes nothing for this session/);
});

test("/ts headroom says not installed and prints the install line when the binary is absent", async () => {
  const rt = await createRuntime();
  await rt.start();
  rt.setExec(async () => {
    throw new Error("spawn headroom ENOENT");
  });

  await rt.run("ts", "headroom status");
  const report = rt.notifications.at(-1);
  assert.match(report.text, /Headroom: not installed/);
  assert.match(report.text, /uv tool install --python 3\.13 "headroom-ai\[all\]"/);

  // A non-zero exit is the same story: never a throw out of the command handler.
  rt.setExec(async () => ({ code: 1, stdout: "", stderr: "not a command" }));
  await rt.run("ts", "headroom");
  assert.match(rt.notifications.at(-1).text, /Headroom: not installed/);
});

test("/ts headroom wrap refuses and spawns nothing", async () => {
  const rt = await createRuntime();
  await rt.start();
  rt.setExec(async () => {
    throw new Error("wrap must not be spawned");
  });
  rt.clearExecCalls();

  await rt.run("ts", "headroom wrap omp");
  const refusal = rt.notifications.at(-1);
  assert.equal(refusal.type, "warning");
  assert.match(refusal.text, /nest omp inside omp/);
  assert.match(refusal.text, /Run it from your own shell/);
  assert.deepEqual(rt.execCalls, [], "no subprocess at all");
});

test("/ts headroom unwrap runs `headroom unwrap omp` exactly once", async () => {
  const rt = await createRuntime();
  await rt.start();
  rt.setExec(async () => ({ code: 0, stdout: "restored models.yml\n", stderr: "" }));
  rt.clearExecCalls();

  await rt.run("ts", "headroom unwrap");
  assert.equal(rt.execCalls.length, 1);
  assert.deepEqual(rt.execCalls[0].args.slice(-2), ["unwrap", "omp"]);
  const done = rt.notifications.at(-1);
  assert.equal(done.type, "info");
  assert.match(done.text, /restored models\.yml/);
  assert.match(done.text, /models\.yml:/, "the file it rewrote is named");

  rt.setExec(async () => {
    throw new Error("spawn headroom ENOENT");
  });
  await rt.run("ts", "headroom unwrap");
  const failed = rt.notifications.at(-1);
  assert.equal(failed.type, "warning");
  assert.match(failed.text, /spawn headroom ENOENT/);
});

test("/combo refuses the headroom verb like the other non-preset verbs", async () => {
  const rt = await createRuntime();
  await rt.start();
  const running = rt.row();
  rt.setExec(async () => {
    throw new Error("a refused verb must not spawn anything");
  });
  rt.clearExecCalls();

  await rt.run("combo", "headroom");
  const refused = rt.notifications.at(-1);
  assert.equal(refused.type, "warning");
  assert.match(refused.text, /Unknown preset: headroom/);
  assert.equal(rt.row(), running, "a refused verb changes nothing");
  assert.deepEqual(rt.execCalls, []);
});
