// Contract: the pack renders exactly one status row (key `modes`) whose nine knob segments are
// byte-identical no matter which command set them, `/ts` is the only writer of what a new session
// starts from, mode instructions reach subagents exactly once per mode set, and no extension
// rewrites message history or tool output.

import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
// The headroom wrap state is written next to the pack's config; same sandbox rule.
const HEADROOM_STATE = join(SANDBOX, "headroom.json");
// The updater keeps its own files beside the pack's config, and resolves the installed version from a
// stamp, the marketplace lock file and the plugin directory — all three pointed into the sandbox.
const VERSION_STAMP = join(SANDBOX, "token-saver-version");
const PLUGINS_ROOT = join(SANDBOX, "xdg", "omp", "plugins");
const LOCK_FILE = join(PLUGINS_ROOT, "omp-plugins.lock.json");
const PLUGIN_MANIFEST = join(PLUGINS_ROOT, "node_modules", "@dillydalli3r", "omp-supreme-token-saver", "package.json");
// A directory that does not exist: what a user without the plugin installed looks like.
const ABSENT_PONYTAIL_DIR = join(SANDBOX, "no-ponytail");

process.env.OMP_TOKEN_SAVER_CONFIG = CONFIG_FILE;
process.env.OMP_COMBO_DEFAULTS_FILE = LEGACY_DEFAULTS_FILE;
process.env.OMP_PONYTAIL_PACKAGE_DIR = PONYTAIL_DIR;
process.env.OMP_HEADROOM_STATE = HEADROOM_STATE;
process.env.OMP_TOKEN_SAVER_VERSION_STAMP = VERSION_STAMP;
// The plugins root only resolves under $XDG_DATA_HOME once that root exists on disk, so the sandbox
// creates it and every marketplace read lands there instead of the developer's own install.
process.env.XDG_DATA_HOME = join(SANDBOX, "xdg");
mkdirSync(PLUGINS_ROOT, { recursive: true });

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
  for (const file of [
    CONFIG_FILE, LEGACY_DEFAULTS_FILE, PONYTAIL_STUB, HEADROOM_STATE,
    VERSION_STAMP, LOCK_FILE, PLUGIN_MANIFEST,
  ]) rmSync(file, { force: true });
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

// The built-in default session, rendered: the preset word plus every knob. `names` is the shape a
// fresh session starts on (DEFAULT_STATUS in shared/session-state.js), so this is what a new session
// shows — a test that wants the one-token-per-knob `full` spelling has to set it.
const NAMES_ROW =
  "🧩 MAX · caveman ultra · rtk on · autoRtk on · ponytail ultra · read full · compress full · prune full · threshold full (70%) · headroom off";

// The other half of that: the same state in `full`, one icon and one short value per knob, grouped by
// layer (the preset plus one group per layer, not one segment per knob).
const MAX_ROW = "🧩 MAX · 🦴U 🦀ON 🔁ON 🐴U · 📖F 🗜️F 🧹F ⏱️70% · 🔀OFF";

// One row token per knob, plus the preset's two (`🧩`, the preset name): the row groups its knobs, so
// the group separators are not segments and the tokens are what a knob-per-knob assertion counts.
const MODE_KNOB_COUNT = 9;

const EXTENSION_FILES = [
  join(EXT, "caveman-session", "index.js"),
  join(EXT, "rtk-session", "index.js"),
  join(EXT, "token-saver", "index.js"),
  join(EXT, "shared", "mode-reinforcement.js"),
];

// Every pi.exec call any runtime in this file made; the last test reads it back.
const ALL_EXEC = [];

const segments = (row) => String(row).split(" · ");
// The row's groups are ` · `-separated and a knob inside a group is space-separated, so the tokens
// are the knobs plus the preset's own two words (`🧩`, `MAX`).
const tokens = (row) => segments(row).flatMap((part) => part.split(" "));
const occurrences = (text, needle) => String(text).split(needle).length - 1;

function zodStub() {
  const chain = new Proxy(function () {}, {
    get: (_t, prop) =>
      ["describe", "min", "max", "optional", "default"].includes(prop) ? () => chain : chain,
    apply: () => chain,
  });
  return new Proxy({}, { get: () => () => chain });
}

// `sessionId` stands in for `ctx.sessionManager.getSessionId()`: the real OMP passes one, and a
// second runtime in this process (the docs give a subagent its own) must not republish over the
// first session's live state.
async function createRuntime(branch = [], files = EXTENSION_FILES, { sessionId, select, model } = {}) {
  const handlers = new Map();
  const commands = new Map();
  const status = new Map();
  const notifications = [];
  const intervals = [];
  const execCalls = [];
  const entries = [...branch];
  const providers = new Map();
  // The session's live model: `pi.setModel(resolve(...))` is what re-points it, exactly as a real
  // session holds a resolved Model rather than re-reading the registry per request.
  let current = model ? { ...model } : undefined;
  const resolve = (spec) => {
    if (!model) return undefined;
    if (spec !== `${model.provider}/${model.id}`) return undefined;
    return { ...model, baseUrl: providers.get(model.provider)?.baseUrl ?? model.baseUrl };
  };
  const modelSwitches = [];
  let thinkingLevel = "high";
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
    // `pi.registerProvider(id, {baseUrl})` is a runtime transport override in OMP: it outranks models.yml
    // and the bundled catalog for that provider id, so `ctx.models.current()` reads it back.
    registerProvider(name, config) {
      providers.set(name, config);
    },
    unregisterProvider(name) {
      providers.delete(name);
    },
    // A real session holds one resolved Model; switching it is what changes the endpoint the next
    // request uses, so the stub tracks the switch instead of re-reading per call.
    setModel: async (next) => {
      current = { ...next };
      modelSwitches.push(next.baseUrl);
      return true;
    },
    getThinkingLevel: () => thinkingLevel,
    setThinkingLevel: (level) => {
      thinkingLevel = level;
    },
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) || []), handler]);
    },
  };

  const ctx = {
    hasUI: true,
    cwd: process.cwd(),
    // The session's active model, with any runtime provider override applied — the same read-back a
    // real session gets from the registry.
    models: { current: () => (current ? { ...current } : undefined), resolve },
    ui: {
      // OMP deletes the key on `undefined` and keeps any other string, including "".
      setStatus: (key, text) => {
        if (text === undefined) status.delete(key);
        else status.set(key, text);
      },
      notify: (text, type) => notifications.push({ text, type }),
      // `/ts config` is driven by selector answers; a test supplies the picks it wants chosen (a
      // pick of `undefined` is the user pressing escape).
      ...(select ? { select } : {}),
    },
    sessionManager: {
      getBranch: () => entries,
      ...(sessionId ? { getSessionId: () => sessionId } : {}),
    },
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
    modelSwitches: () => [...modelSwitches],
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

test("a fresh session renders one row: the default preset with every knob segment", async () => {
  const rt = await createRuntime();
  await rt.start();

  assert.deepEqual(rt.keys(), ["modes"], "the pack owns one status row");
  assert.equal(rt.row(), NAMES_ROW, "the default shape spells every knob out");
  assert.equal(
    tokens(rt.row()).length,
    MODE_KNOB_COUNT * 2 + 3,
    "preset marker + preset name + a name and a value per knob, plus the threshold note's two words"
  );
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
  await liteKnobByKnob.run("ts", "set caveman=lite ponytail=lite read=off compress=lite prune=off threshold=off");
  const liteKnobsRow = liteKnobByKnob.row();

  assert.match(liteRow, /^🧩 LITE · /);
  assert.equal(liteComboRow, liteRow, "/combo lite matches /ts preset lite");
  assert.equal(liteKnobsRow, liteRow, "setting the same values knob by knob matches the preset");
});

test("a per-knob override changes only its segments, derives CUSTOM, and replays from the branch", async () => {
  const rt = await createRuntime();
  await rt.start();
  await rt.run("ts", "set status=full");
  const before = rt.row();

  await rt.run("ts", "set caveman=wenyan prune=off");
  const after = rt.row();

  assert.equal(
    after,
    "🧩 CUSTOM · 🦴W 🦀ON 🔁ON 🐴U · 📖F 🗜️F 🧹O ⏱️70% · 🔀OFF"
  );
  const changed = tokens(after).filter((part, index) => part !== tokens(before)[index]);
  assert.deepEqual(changed, ["CUSTOM", "🦴W", "🧹O"], "only the two knob tokens and the preset word moved");

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
  assert.equal(reset.row(), NAMES_ROW, "back to the built-in preset in the default shape");
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
  assert.match(fresh.row(), /^🧩 CUSTOM · caveman wenyan /, "a stored override reaches a new session");

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
  assert.match(rt.row(), /🦴L/);
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

// Four row shapes, because a footer can be narrower than nine knobs: `full` is the one that fits
// (icon + short value, grouped), `names` spells the same knobs out for when a letter would not be
// clear, and `preset` drops them for one word.
test("the status knob picks the row's shape", async () => {
  const rt = await createRuntime();
  await rt.start();

  await rt.run("ts", "set status=names");
  assert.equal(
    rt.row(),
    "🧩 MAX · caveman ultra · rtk on · autoRtk on · ponytail ultra · read full · compress full · prune full · threshold full (70%) · headroom off"
  );
  assert.equal(rt.row().includes("🦴"), false, "no icon is left to decode");
  assert.equal(rt.row().includes(":"), false, "the knob's name and its value are two words, not a label");

  await rt.run("ts", "set status=preset");
  assert.equal(rt.row(), "🧩 MAX");

  await rt.run("ts", "set status=full");
  assert.equal(rt.row(), MAX_ROW);
  assert.equal(segments(rt.row()).length, 4, "the preset plus one group per layer, not one segment per knob");
});

// A display-only knob must not demote the session: `custom` would also drop the preset's native tier
// dials, so the row would report a different preset than the knobs the session actually runs.
test("changing only the row's shape keeps the preset the session reports", async () => {
  const rt = await createRuntime();
  await rt.start();

  await rt.run("ts", "preset ultra");
  await rt.run("ts", "set status=full");

  assert.match(rt.row(), /^🧩 ULTRA · /, "the knobs are still ultra's");
  assert.match(rt.notifications.at(-1).text, /^Set status=full/);
  assert.doesNotMatch(rt.notifications.at(-1).text, /custom/);
});

// One vocabulary for the rtk knob — the words `/ts set rtk=…` accepts, and no others. `enable` and
// `disable` came from a local word list that used to live in the add-on, so accepting them again
// would be a second vocabulary for one setting that the row and `/rtk status` would then have to
// describe.
test("the rtk knob accepts the same vocabulary /ts set rtk= does, and nothing else", async () => {
  const rt = await createRuntime();
  await rt.start();

  await rt.run("rtk", "on");
  assert.match(rt.row(), /· rtk on ·/);

  await rt.run("rtk", "off");
  assert.match(rt.row(), /· rtk off ·/);

  // `true`/`false` are the boolean spelling of the same two states, not a third vocabulary.
  await rt.run("rtk", "true");
  assert.match(rt.row(), /· rtk on ·/);
  await rt.run("rtk", "false");
  assert.match(rt.row(), /· rtk off ·/);

  const running = rt.row();
  await rt.run("rtk", "enable");

  const refused = rt.notifications.at(-1);
  assert.equal(refused.type, "warning");
  assert.match(refused.text, /Usage: \/rtk /);
  assert.equal(rt.row(), running, "a word outside the vocabulary leaves the knob alone");
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

  // Every shape SHELL_SYNTAX refuses: a pipe, `;`, a redirection, `&&`, a newline (a command
  // separator) and a substitution. A rewrite of any of them would drop what the shell was told to do
  // with the output, so each has to reach the shell exactly as written.
  for (const command of [
    "cat notes.md | head -5",
    "ls; ls",
    "git log > out.txt",
    "npm run build && npm run test",
    "git log --oneline\ngit status",
    "echo `date`",
    "echo $(date)",
    "rtk git status",
  ]) {
    rt.clearExecCalls();
    const [result] = await rt.emit("tool_call", { toolName: "bash", input: { command } });
    assert.equal(result, undefined, `no rewrite for ${command}`);
    assert.deepEqual(rt.execCalls, [], `no subprocess for ${command}`);
  }

  // …and the shell syntax is the only reason those were skipped: a plain eligible command standing
  // next to them is still rewritten.
  rt.setExec(async (_command, args) =>
    args.includes("rewrite") ? { code: 0, stdout: "rtk git diff HEAD~1", stderr: "" } : { code: 0, stdout: "", stderr: "" }
  );
  rt.clearExecCalls();
  const [plain] = await rt.emit("tool_call", { toolName: "bash", input: { command: "git diff HEAD~1" } });
  assert.deepEqual(plain, { input: { command: "rtk git diff HEAD~1" } });
  assert.equal(rt.execCalls.length, 1, "the eligible command is the one handed to rtk");

  await rt.run("ts", 'option autoRtk.exclude=["git log"]');
  await rt.start();

  rt.clearExecCalls();
  const [excluded] = await rt.emit("tool_call", { toolName: "bash", input: { command: "git log --all" } });
  assert.equal(excluded, undefined, "an excluded command is left alone");
  assert.deepEqual(rt.execCalls, []);
});

// A re-run after a compaction is handed back the prompt it already extended: appending the block
// again would bill the same instructions twice for one turn.
test("a compacted re-run does not append the rtk block a second time", async () => {
  const rt = await createRuntime();
  await rt.start();

  const first = await rt.runBeforeAgentStart("You are a helpful assistant.");
  assert.equal(occurrences(first, "RTK mode active for this session"), 1);

  const second = await rt.runBeforeAgentStart(first);
  assert.equal(occurrences(second, "RTK mode active for this session"), 1, "the block is appended once per prompt");
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

// A reward key only counts on the final response: a turn that continues can still write it, so a key
// seen mid-run must not spend the session's one notification.
test("a reward key in a continued turn notifies nothing, and one in the final response does", async () => {
  const rt = await createRuntime([], [join(EXT, "amanai-reward", "pi.js")]);
  const finalResponse = (text) => ({
    messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text }] }],
  });
  const key = "AMANAI-GACHA-ABC123-XY9";

  await rt.emit("agent_start", {});
  await rt.emit("agent_end", { willContinue: true, ...finalResponse(key) });
  await rt.emit("agent_settled", {});
  assert.deepEqual(rt.notifications, [], "a continued turn is not the final response");

  await rt.emit("agent_end", finalResponse(key));
  await rt.emit("agent_settled", {});
  assert.equal(rt.notifications.length, 1);
  assert.match(rt.notifications[0].text, /Amanai reward key/);
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

// --- Regression pins for the six reproduced defects -------------------------------------------
// Every handler here is reached through the command surface a user types: a refused name has to
// warn, change nothing, and leave the process alive.

test("a prototype-chain name is an unknown knob or option, never a crash", async () => {
  const rt = await createRuntime();
  await rt.start();
  const before = rt.row();

  await rt.run("ts", "set constructor=off");
  const refusedKnob = rt.notifications.at(-1);
  assert.equal(refusedKnob.type, "warning");
  assert.match(refusedKnob.text, /Unknown knob: constructor=off/);
  assert.deepEqual(
    rt.entries.filter((entry) => entry.customType === "ts-mode"),
    [],
    "nothing is written to the branch"
  );
  assert.equal(rt.row(), before, "the row keeps every knob it had");

  for (const line of ["option compress.toString=9", "option constructor.name=x"]) {
    await rt.run("ts", line);
    const refusedOption = rt.notifications.at(-1);
    assert.equal(refusedOption.type, "warning", line);
    assert.match(refusedOption.text, /Unknown option/, line);
  }
  assert.equal(existsSync(CONFIG_FILE), false, "a refused option writes nothing");

  // A branch entry naming an inherited property must not take a session down either.
  const branch = [{ type: "custom", customType: "ts-mode", data: { name: "constructor", value: "off" }, id: "entry-0" }];
  const replay = await createRuntime(branch);
  await replay.start();
  assert.equal(replay.row(), before, "the entry is ignored, not indexed");
});

test("a wrong-shaped autoRtk.exclude is refused at read time, not applied as a list", async () => {
  writeFileSync(CONFIG_FILE, JSON.stringify({ version: 2, options: { autoRtk: { exclude: { "git log": true } } } }));
  const { readOptions } = await import(pathToFileURL(join(EXT, "shared", "session-state.js")).href);
  assert.deepEqual(readOptions().autoRtk.exclude, [], "an object where a list of strings belongs falls back");

  const rt = await createRuntime();
  await rt.start();
  rt.setExec(async (_command, args) => ({
    code: 0,
    stdout: args.includes("rewrite") ? "rtk git log --all" : "",
    stderr: "",
  }));

  rt.clearExecCalls();
  const [result] = await rt.emit("tool_call", { toolName: "bash", input: { command: "git log --all" } });
  assert.deepEqual(result, { input: { command: "rtk git log --all" } }, "the object is not an exclusion list");
  assert.equal(rt.execCalls.length, 1, "the handler ran past the exclude check instead of throwing");

  // Nothing about the shape can silently stop rewriting: the knob is the only gate.
  await rt.run("ts", "set autoRtk=off");
  rt.clearExecCalls();
  const [off] = await rt.emit("tool_call", { toolName: "bash", input: { command: "git log --all" } });
  assert.equal(off, undefined);
  assert.deepEqual(rt.execCalls, []);
});

test("/ts default reports the preset a fresh session actually renders", async () => {
  const rt = await createRuntime();
  await rt.start();

  // Every knob of `lite` written as per-knob defaults: the file keeps the old `max` name, so the
  // report has to come from the modes themselves.
  await rt.run(
    "ts",
    "default caveman=lite rtk=on ponytail=lite read=off compress=lite prune=off threshold=off autoRtk=on status=full"
  );
  assert.match(rt.notifications.at(-1).text, /Default for new sessions: LITE/);

  const fresh = await createRuntime();
  await fresh.start();
  assert.match(fresh.row(), /^🧩 LITE · /, "the report and the rendered row agree");
});

test("/ts option native.mode is an enum, and `on` means auto", async () => {
  const rt = await createRuntime();
  await rt.start();
  const stored = () => JSON.parse(readFileSync(CONFIG_FILE, "utf8")).options.native.mode;

  await rt.run("ts", "option native.mode=on");
  assert.equal(stored(), "auto", "`on` is the same word `/ts native on` writes");

  for (const value of ["nope", "", "yes please"]) {
    await rt.run("ts", `option native.mode=${value}`);
    const refused = rt.notifications.at(-1);
    assert.equal(refused.type, "warning", value);
    assert.match(refused.text, /native\.mode takes off \| auto/);
    assert.equal(stored(), "auto", `a refused value changes nothing: ${value}`);
  }
});

test("an unwritable config path warns instead of throwing out of the handler", async () => {
  // A directory at the config path: the temp file is writable, the rename over it is not.
  const reported = [];
  let leftovers = [];
  mkdirSync(CONFIG_FILE, { recursive: true });
  try {
    const rt = await createRuntime();
    await rt.start();
    for (const line of ["default lite", "default reset", "option autoRtk.timeoutMs=5000", "native on"]) {
      await rt.run("ts", line);
      reported.push({ line, ...rt.notifications.at(-1) });
    }
    leftovers = readdirSync(SANDBOX).filter((name) => name.includes(".tmp"));
  } finally {
    rmSync(CONFIG_FILE, { recursive: true, force: true });
  }

  for (const { line, type, text } of reported) {
    assert.equal(type, "warning", line);
    assert.match(text, /Config not written/, line);
    assert.ok(text.includes(CONFIG_FILE), `${line} names the path it could not write`);
  }
  assert.deepEqual(leftovers, [], "no temp file survives the failed write");
});

test("a second session in one process does not republish over the live state", async () => {
  const first = await createRuntime([], EXTENSION_FILES, { sessionId: "session-1" });
  await first.start();
  await first.run("ts", "set caveman=off");
  const row = first.row();
  assert.match(row, /^🧩 CUSTOM · caveman off /);

  const second = await createRuntime([], EXTENSION_FILES, { sessionId: "session-2" });
  await second.start();

  assert.equal(first.row(), row, "the first session's row is untouched");
  // A later render reads the shared state again, so a clobber would show up here.
  await first.emit("turn_end", {});
  assert.equal(first.row(), row, "and stays untouched on the next render");
  await first.run("ts", "status");
  assert.match(first.notifications.at(-1).text, /Token Saver: CUSTOM/);
  assert.equal(second.row(), row, "the second session joins the state already running");
});

// The add-on's knob and the shared state are the same fact twice, so a turn where they already agree
// has nothing to publish. Publishing the unchanged value anyway freezes and redraws the footer row a
// second time in the same turn — token-saver's own `agent_start` is the write that already happened —
// so the guard is exactly the difference between a turn that costs one row write and one that costs
// two. Divergence is created by publishing straight into the shared state, the way the ponytail
// plugin's own entries do: `/ts set` reloads the session, which resyncs this add-on's copy.
test("the caveman add-on republishes the row only when its mode actually differs", async () => {
  const { setSharedMode } = await import(pathToFileURL(join(EXT, "shared", "session-state.js")).href);
  const rt = await createRuntime();
  await rt.start();
  await rt.run("caveman", "ultra");

  const writes = [];
  const setStatus = rt.ctx.ui.setStatus;
  rt.ctx.ui.setStatus = (key, text) => {
    writes.push(key);
    setStatus(key, text);
  };

  // Agreed: the add-on's mode and the shared state are both ultra.
  await rt.emit("agent_start", {});
  const agreed = writes.length;

  // A sibling moved the shared state under the add-on's feet: now its own mode really is news, and
  // that one publish is the one extra row write.
  setSharedMode("caveman", "lite");
  writes.length = 0;
  await rt.emit("agent_start", {});
  const divergent = writes.length;

  assert.equal(
    divergent - agreed,
    1,
    `a divergent mode publishes once (${agreed} row writes with an agreed mode, ${divergent} with a divergent one)`
  );
  assert.deepEqual([...new Set(writes)], ["modes"], "there is still one row to redraw");
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
  assert.match(rt.row(), /· autoRtk off ·/);
  assert.deepEqual(
    rt.entries.filter((entry) => entry.customType === "ts-mode").map((entry) => entry.data),
    [{ name: "autoRtk", value: "off" }],
    "the knob is stored under its canonical name"
  );

  await rt.run("ts", "set AUTORTK=on");
  assert.match(rt.row(), /· autoRtk on ·/);
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

// The proxy is a real HTTP service; `/health` is the only thing the pack reads back from it, so the
// probe is what the tests stand in for. A proxy that is up is the only case that skips spawning.
const withProxyHealth = async (run, { ready = true, status = "healthy", config = {} } = {}) => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ status, ready, version: "0.37.0", rust_core: "loaded", config }),
  });
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
};

const DEEPSEEK = { provider: "deepseek", id: "deepseek-flash", api: "openai-completions", baseUrl: "https://api.deepseek.com/v1" };
const PROXY_8787 = "http://127.0.0.1:8787/v1";

test("/ts headroom status names the proxy it found, that proxy's upstreams, and this session's routing", async () => {
  const rt = await createRuntime([], EXTENSION_FILES, { model: DEEPSEEK });
  await rt.start();
  rt.setExec(async () => ({ code: 0, stdout: "headroom, version 0.37.0\n", stderr: "" }));
  rt.clearExecCalls();

  await withProxyHealth(() => rt.run("ts", "headroom"), {
    config: { openai_api_url: "https://api.deepseek.com/v1" },
  });

  const report = rt.notifications.at(-1);
  assert.equal(report.type, "info");
  assert.match(report.text, /Headroom: headroom, version 0\.37\.0/);
  assert.match(report.text, /Proxy on 8787: up/);
  assert.match(report.text, /openai_api_url=https:\/\/api\.deepseek\.com\/v1/, "what the proxy forwards to");
  assert.match(report.text, /Routed through the proxy: no/, "a fresh session is not routed");
  assert.equal(rt.execCalls.length, 1, "one version probe");
  assert.match(headroomCall(rt.execCalls[0]), /headroom --version$/);
});

test("/ts headroom status is honest about a proxy that is down and a family it cannot route", async () => {
  const rt = await createRuntime([], EXTENSION_FILES, {
    model: { provider: "bedrock", id: "claude-sonnet-4", api: "bedrock-converse-stream", baseUrl: "https://bedrock.example" },
  });
  await rt.start();
  rt.setExec(async () => ({ code: 0, stdout: "headroom, version 0.37.0", stderr: "" }));

  // Nothing is listening: the probe is stubbed to fail rather than to depend on the test machine
  // having no proxy on 8787 (a developer running one should still get a deterministic suite).
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("ECONNREFUSED 127.0.0.1:8787");
  };
  try {
    await rt.run("ts", "headroom status");
  } finally {
    globalThis.fetch = original;
  }
  const report = rt.notifications.at(-1);
  assert.match(report.text, /Proxy on 8787: down/);
  assert.match(report.text, /headroom has no upstream flag for this family/, "no invented support");
  assert.doesNotMatch(report.text, /Routed through the proxy: yes/);
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

test("/ts headroom wrap routes this session's provider at the proxy, for any family", async () => {
  const rt = await createRuntime([], EXTENSION_FILES, { model: DEEPSEEK });
  await rt.start();

  await withProxyHealth(() => rt.run("ts", "headroom wrap"), {
    config: { openai_api_url: DEEPSEEK.baseUrl },
  });

  const done = rt.notifications.at(-1);
  assert.equal(done.type, "info");
  assert.match(done.text, /omp → http:\/\/127\.0\.0\.1:8787\/v1 → https:\/\/api\.deepseek\.com\/v1/);
  assert.match(done.text, /Routing read back from the registry: yes/);
  assert.deepEqual(rt.modelSwitches(), [PROXY_8787], "the session model was handed the proxied endpoint");
  assert.equal(
    rt.ctx.models.current().baseUrl,
    PROXY_8787,
    "the registry reports the proxy, which is what the next request uses"
  );

  // The anthropic family posts `<base>/v1/messages` itself, so its base carries no `/v1`.
  const anthropic = await createRuntime([], EXTENSION_FILES, {
    model: { provider: "anthropic", id: "claude-opus-4-5", api: "anthropic-messages", baseUrl: "https://api.anthropic.com" },
  });
  await anthropic.start();
  await withProxyHealth(() => anthropic.run("ts", "headroom wrap"), {
    config: { anthropic_api_url: "https://api.anthropic.com" },
  });
  assert.equal(anthropic.ctx.models.current().baseUrl, "http://127.0.0.1:8787");
});

test("/ts headroom wrap refuses a proxy pointed at another upstream, and a family with no flag", async () => {
  const rt = await createRuntime([], EXTENSION_FILES, { model: DEEPSEEK });
  await rt.start();
  // Sending this session's traffic (and its API key) to someone else's upstream is the failure this
  // guard exists for: the proxy on the port forwards openai traffic somewhere other than our provider.
  await withProxyHealth(() => rt.run("ts", "headroom wrap"), {
    config: { openai_api_url: "https://api.openai.com/v1" },
  });

  const refusal = rt.notifications.at(-1);
  assert.equal(refusal.type, "warning");
  assert.match(refusal.text, /already up on 8787 forwarding openai_api_url to https:\/\/api\.openai\.com\/v1/);
  assert.equal(rt.ctx.models.current().baseUrl, DEEPSEEK.baseUrl, "nothing was rerouted");

  const bedrock = await createRuntime([], EXTENSION_FILES, {
    model: { provider: "bedrock", id: "claude-sonnet-4", api: "bedrock-converse-stream", baseUrl: "https://bedrock.example" },
  });
  await bedrock.start();
  bedrock.ctx.models.current = () => ({ provider: "bedrock", api: "bedrock-converse-stream", baseUrl: "https://bedrock.example" });
  await bedrock.run("ts", "headroom wrap");
  const noFlag = bedrock.notifications.at(-1);
  assert.equal(noFlag.type, "warning");
  assert.match(noFlag.text, /no upstream flag for api "bedrock-converse-stream"/);
});

test("/ts headroom unwrap removes the routing the pack added", async () => {
  const rt = await createRuntime([], EXTENSION_FILES, { model: DEEPSEEK });
  await rt.start();
  await withProxyHealth(() => rt.run("ts", "headroom wrap"), {
    config: { openai_api_url: DEEPSEEK.baseUrl },
  });
  assert.equal(rt.ctx.models.current().baseUrl, PROXY_8787);

  await rt.run("ts", "headroom unwrap");
  const done = rt.notifications.at(-1);
  assert.equal(done.type, "info");
  assert.match(done.text, /Routing removed for deepseek/);
  assert.equal(rt.ctx.models.current().baseUrl, DEEPSEEK.baseUrl, "the provider is back on its own endpoint");
  assert.equal(existsSync(HEADROOM_STATE), false, "the wrap state is gone, so a stale unwrap cannot fire");

  // Nothing to undo is reported, not thrown.
  await rt.run("ts", "headroom unwrap");
  assert.match(rt.notifications.at(-1).text, /Nothing to unroute: deepseek is not pointed at a proxy/);
});

test("/ts headroom unwrap-models restores the file `headroom wrap omp` wrote", async () => {
  const rt = await createRuntime();
  await rt.start();
  rt.setExec(async () => ({ code: 0, stdout: "restored models.yml\n", stderr: "" }));
  rt.clearExecCalls();

  await rt.run("ts", "headroom unwrap-models");
  assert.equal(rt.execCalls.length, 1);
  assert.deepEqual(rt.execCalls[0].args.slice(-2), ["unwrap", "omp"]);
  const done = rt.notifications.at(-1);
  assert.match(done.text, /restored models\.yml/);
  assert.match(done.text, /models\.yml:/, "the file it rewrote is named");

  rt.setExec(async () => {
    throw new Error("spawn headroom ENOENT");
  });
  await rt.run("ts", "headroom unwrap-models");
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

// The knobs select OMP's own settings, so these tests read back the `omp config set` calls the
// extension makes rather than our tables: a stub `omp` reports config.yml and records the writes.
// The pack passes `--json` alongside every `config set`, and puts the `--` separator in front of a
// value that starts with `-`, so the value is the first argument after the key that is neither of
// those flags.
const setValue = (args, at) => args.slice(at + 2).find((arg) => arg !== "--json" && arg !== "--");

const nativeWrites = (rt) =>
  rt.execCalls
    .filter((call) => call.args.includes("set") && call.args.includes("config"))
    .map((call) => {
      const at = call.args.indexOf("set");
      return `${call.args[at + 1]}=${setValue(call.args, at)}`;
    });

const stale = (value) => (value === "true" ? true : value === "false" ? false : Number.isNaN(Number(value)) ? value : Number(value));

const stubOmp = (rt, values = {}) => {
  const stored = new Map(Object.entries(values));
  rt.setExec(async (_command, args) => {
    const argv = args.join(" ");
    if (argv.endsWith("config path")) return { code: 0, stdout: join(SANDBOX, "agent"), stderr: "" };
    if (argv.includes("config list")) {
      const entries = [...stored].map(([key, value]) => [key, { value }]);
      return { code: 0, stdout: JSON.stringify(Object.fromEntries(entries)), stderr: "" };
    }
    if (argv.includes("config set")) {
      const at = args.indexOf("set");
      stored.set(args[at + 1], stale(setValue(args, at)));
      return { code: 0, stdout: "{}", stderr: "" };
    }
    return { code: 0, stdout: "{}", stderr: "" };
  });
  return stored;
};

test("the read knob's level picks read.summarize.*, and auto makes /ts set write them", async () => {
  const rt = await createRuntime();
  await rt.start();
  stubOmp(rt, {
    "read.summarize.enabled": true,
    "read.summarize.prose": true,
    "read.summarize.minTotalLines": 60,
    "read.summarize.unfoldLimit": 60,
    "read.defaultLimit": 200,
  });

  // read=off: no summariser at all, and the size dials back at their conservative values.
  await rt.run("ts", "set read=off");
  rt.clearExecCalls();
  await rt.run("ts", "native apply");
  const off = nativeWrites(rt);
  assert.ok(off.includes("read.summarize.enabled=false"), off.join(" "));
  assert.ok(off.includes("read.summarize.prose=false"));
  assert.ok(off.includes("read.summarize.minTotalLines=100"));
  assert.ok(off.includes("read.defaultLimit=300"));

  // Once the user opts into auto, a knob set writes without a second verb.
  await rt.run("ts", "native on");
  rt.clearExecCalls();
  await rt.run("ts", "set read=lite");
  assert.deepEqual(nativeWrites(rt), ["read.summarize.enabled=true"], "lite differs from off by summarising at all");

  rt.clearExecCalls();
  await rt.run("ts", "set read=full");
  const full = nativeWrites(rt);
  assert.ok(full.includes("read.summarize.prose=true"), full.join(" "));
  assert.ok(full.includes("read.summarize.minTotalLines=60"));

  // A preset supplies the levels too; the shared preset table ships `lite` with read=off, so it
  // writes the same key a read=off would.
  rt.clearExecCalls();
  await rt.run("ts", "preset lite");
  assert.ok(nativeWrites(rt).includes("read.summarize.enabled=false"), nativeWrites(rt).join(" "));
});

test("the compress knob alone picks the spill keys, so ultra and medium differ", async () => {
  for (const [preset, before, threshold, outline] of [
    ["ultra", { "tools.artifactSpillThreshold": 20, "shellMinimizer.sourceOutlineLevel": "default" }, "10", "aggressive"],
    ["medium", { "tools.artifactSpillThreshold": 10, "shellMinimizer.sourceOutlineLevel": "aggressive" }, "20", "default"],
  ]) {
    const rt = await createRuntime();
    await rt.start();
    stubOmp(rt, before);

    await rt.run("ts", `preset ${preset}`);
    rt.clearExecCalls();
    await rt.run("ts", "native apply");

    const called = nativeWrites(rt);
    assert.ok(called.includes(`tools.artifactSpillThreshold=${threshold}`), `${preset}: ${called.join(" ")}`);
    assert.ok(called.includes(`shellMinimizer.sourceOutlineLevel=${outline}`), preset);
  }
});

test("the threshold knob's level picks the compaction trigger keys", async () => {
  const rt = await createRuntime();
  await rt.start();
  stubOmp(rt);
  await rt.run("ts", "native on");

  await rt.run("ts", "set threshold=ultra");
  const ultra = nativeWrites(rt);
  assert.ok(ultra.includes("compaction.thresholdPercent=55"), ultra.join(" "));
  assert.ok(ultra.includes("compaction.idleEnabled=true"));
  assert.ok(ultra.includes("compaction.idleThresholdTokens=80000"));

  rt.clearExecCalls();
  await rt.run("ts", "set threshold=off");
  const off = nativeWrites(rt);
  assert.ok(off.includes("compaction.thresholdPercent=-1"), off.join(" "));
  assert.ok(off.includes("compaction.idleEnabled=false"));
  assert.ok(off.includes("compaction.idleThresholdTokens=200000"));

  // `-1` is only accepted after `--`: without the separator the host CLI refuses the write as an
  // unknown option and nothing lands, so the argv itself is the pin, not the mapped pair. The
  // `--json` flag has to come before the separator for the same reason — anything after `--` is
  // positional, so trailing it there would be read as part of the value (`Invalid number: -1 --json`).
  const percent = rt.execCalls.find((call) => call.args.includes("compaction.thresholdPercent"));
  const at = percent.args.indexOf("config");
  assert.deepEqual(percent.args.slice(at, at + 6), ["config", "set", "compaction.thresholdPercent", "--json", "--", "-1"]);
});

// The row's number and the percent a level writes are one fact living in two files (status-line.js /
// the threshold table above), so this pins them together: a retuned level must not leave the row
// saying `threshold ultra (55%)` while nothing sets 55.
test("the row's threshold note is the percent that level writes", async () => {
  const rt = await createRuntime();
  await rt.start();
  stubOmp(rt);
  await rt.run("ts", "native on");
  // The spelled shape, because it carries the level *and* the number: the default row shows the
  // number alone.
  await rt.run("ts", "set status=names");

  // The shared state is one per process, so an earlier test may have left `threshold` on the very
  // level under test — and a `set` that changes nothing writes nothing. Step onto the next level
  // first, then clear: what the second `set` writes is the diff this level alone is responsible for.
  const levels = ["off", "lite", "full", "ultra"];
  for (const [index, level] of levels.entries()) {
    await rt.run("ts", `set threshold=${levels[(index + 1) % levels.length]}`);
    rt.clearExecCalls();
    await rt.run("ts", `set threshold=${level}`);
    const written = nativeWrites(rt).find((key) => key.startsWith("compaction.thresholdPercent="));
    const percent = written.slice("compaction.thresholdPercent=".length);
    // `-1` is the host saying "no share of my own" — the reserve decides, and the row says so.
    const note = percent === "-1" ? "reserve" : `${percent}%`;
    assert.match(rt.row(), new RegExp(`threshold ${level} \\(${note}\\)`), `${level}: ${rt.row()}`);
  }
});

// `prune` used to switch idle compaction on while the token trigger stayed at its 200000 default —
// at or above the whole window of many models, so the setting could never fire. The trigger family
// belongs to `threshold` alone now, and this pins that prune writes none of it. The native gate is
// left off, so the knob change itself writes nothing and the apply is what turns the mapping into
// writes.
test("the prune knob no longer claims idle compaction", async () => {
  const rt = await createRuntime();
  await rt.start();
  // The session holds threshold=off, which is exactly what the stub already has, so those trigger
  // keys are never pending and the assertion below is about prune alone.
  stubOmp(rt, {
    "compaction.thresholdPercent": -1,
    "compaction.idleEnabled": false,
    "compaction.idleThresholdTokens": 200000,
  });

  await rt.run("ts", "set threshold=off prune=ultra");
  rt.clearExecCalls();
  await rt.run("ts", "native apply");

  const called = nativeWrites(rt);
  assert.ok(called.includes("compaction.supersedeReads=true"), called.join(" "));
  assert.ok(called.includes("compaction.dropUseless=true"));
  assert.ok(called.includes("compaction.keepRecentTokens=8000"));
  assert.deepEqual(called.filter((key) => key.startsWith("compaction.idle")), [], called.join(" "));
});

test("a preset carries the threshold level", async () => {
  const rt = await createRuntime();
  await rt.start();
  stubOmp(rt);
  await rt.run("ts", "native on");

  await rt.run("ts", "preset max");
  const max = nativeWrites(rt);
  assert.ok(max.includes("compaction.thresholdPercent=70"), max.join(" "));
  assert.ok(max.includes("compaction.idleThresholdTokens=120000"));

  rt.clearExecCalls();
  await rt.run("ts", "preset ultra");
  const ultra = nativeWrites(rt);
  assert.ok(ultra.includes("compaction.thresholdPercent=55"), ultra.join(" "));
  assert.ok(ultra.includes("compaction.idleThresholdTokens=80000"));

  // Below `high` the preset ships the knob at off, which is the host's reserve-based default rather
  // than a limit of its own.
  rt.clearExecCalls();
  await rt.run("ts", "preset lite");
  const lite = nativeWrites(rt);
  assert.ok(lite.includes("compaction.thresholdPercent=-1"), lite.join(" "));
});

// `options.threshold` says what a level cannot: an exact share, an exact token cap, and the rule for
// choosing between them. The host hands a positive `compaction.thresholdTokens` priority over the
// percent the moment it is set, so "use whichever fires first" has to be decided before the write —
// and the losing limit is written back to `-1` rather than left in the file to outrank the winner.
test("options.threshold picks the limit that fires first, and the row reports it", async () => {
  // 70% of this window is 140000, which is what the `full` level stands for.
  const rt = await createRuntime([], EXTENSION_FILES, { model: { ...DEEPSEEK, contextWindow: 200000 } });
  await rt.start();
  await rt.run("ts", "set threshold=full");
  stubOmp(rt);

  // A cap below the share wins, and the share is written alongside it for the case where the cap is
  // later lifted.
  await rt.run("ts", "option threshold.tokens=100000");
  rt.clearExecCalls();
  await rt.run("ts", "native apply");
  assert.ok(nativeWrites(rt).includes("compaction.thresholdTokens=100000"), nativeWrites(rt).join(" "));
  assert.ok(nativeWrites(rt).includes("compaction.thresholdPercent=70"));
  assert.match(rt.row(), /threshold full \(100k\)/, "the row names the limit in force");

  // A cap above it loses the `auto` pick: the share fires first.
  await rt.run("ts", "option threshold.tokens=160000");
  rt.clearExecCalls();
  await rt.run("ts", "native apply");
  assert.ok(nativeWrites(rt).includes("compaction.thresholdTokens=-1"), nativeWrites(rt).join(" "));
  assert.match(rt.row(), /threshold full \(70%\)/, "and the row goes back to the share");

  // A pin overrides the comparison in either direction.
  await rt.run("ts", "option threshold.pick=tokens");
  rt.clearExecCalls();
  await rt.run("ts", "native apply");
  assert.ok(nativeWrites(rt).includes("compaction.thresholdTokens=160000"), nativeWrites(rt).join(" "));

  await rt.run("ts", "option threshold.pick=percent");
  rt.clearExecCalls();
  await rt.run("ts", "native apply");
  assert.ok(nativeWrites(rt).includes("compaction.thresholdTokens=-1"), nativeWrites(rt).join(" "));

  // A share of its own replaces the level's: `full` then writes 40, not 70.
  await rt.run("ts", "option threshold.percent=40");
  await rt.run("ts", "option threshold.pick=auto");
  rt.clearExecCalls();
  await rt.run("ts", "native apply");
  assert.ok(nativeWrites(rt).includes("compaction.thresholdPercent=40"), nativeWrites(rt).join(" "));
  assert.match(rt.row(), /threshold full \(40%\)/);
});

test("a knob set next to a preset keeps the preset's tier dials and says the state is custom", async () => {
  const rt = await createRuntime();
  await rt.start();
  stubOmp(rt, { "task.softRequestBudget": 200, "tools.intentTracing": false });

  // `max` is the built-in default tier, so a custom state falls back to its dials rather than
  // inventing a tier from the one knob that changed.
  await rt.run("ts", "set caveman=wenyan");
  assert.match(rt.row(), /^🧩 CUSTOM · /);
  rt.clearExecCalls();
  await rt.run("ts", "native apply");
  assert.ok(nativeWrites(rt).includes("task.softRequestBudget=150"), nativeWrites(rt).join(" "));
  assert.match(rt.notifications.at(-1).text, /tier max \(state is custom\)/);

  await rt.run("ts", "native status");
  const table = rt.notifications.at(-1).text;
  assert.match(table, /tier: max \(state is custom\)/);
  assert.match(table, /task\.softRequestBudget: 150 → 150|task\.softRequestBudget: 200 → 150/);
});

test("/ts set ponytail writes the entry the ponytail plugin reads", async () => {
  const rt = await createRuntime();
  await rt.start();

  await rt.run("ts", "set ponytail=full");
  assert.deepEqual(
    rt.entries.filter((entry) => entry.customType === "ponytail-mode").map((entry) => entry.data),
    [{ mode: "full" }],
    "the plugin's own custom type carries the running session's level"
  );
});

// A bare invocation is "configure this": the menu is the command, and the text moves behind its own
// verb — with the old text kept as the fallback for a session that has no selector to offer.
test("bare /token-saver opens the menu, and prints status when there is no selector", async () => {
  const asked = [];
  const rt = await createRuntime([], EXTENSION_FILES, {
    select: (title) => {
      asked.push(title);
      return title === "Supreme Token Saver" ? "Preset" : "off";
    },
  });
  await rt.start();

  await rt.run("token-saver");
  assert.deepEqual(asked, ["Supreme Token Saver", "Token Saver · preset (this session)"]);
  assert.match(rt.row(), /^🧩 OFF · /, "the pick reached the preset");

  const headless = await createRuntime();
  await headless.start();
  await headless.run("ts");
  assert.match(headless.notifications.at(-1).text, /^Token Saver: /);
});

test("bare /combo stays preset-only instead of opening the menu", async () => {
  const rt = await createRuntime([], EXTENSION_FILES, {
    select: () => assert.fail("/combo never had a menu"),
  });
  await rt.start();

  await rt.run("combo");
  assert.match(rt.notifications.at(-1).text, /^Token Saver: /);
});

// The row is the UI the pack prints, so the menu configures it directly and previews it: a shape has
// to be choosable by what it looks like, not by its name — and like every other knob, the pick has to
// be able to land in the file instead of only in the session.
test("/ts config configures the footer row, previews each shape, and stores it for new sessions", async () => {
  const asked = [];
  const rt = await createRuntime([], EXTENSION_FILES, {
    select: (title, options) => {
      if (title === "Supreme Token Saver") {
        asked.push("menu");
        return "Footer row";
      }
      if (title === "status=names") {
        asked.push(options.map((option) => option.label));
        return "New sessions";
      }
      asked.push(options.map((option) => option.label));
      asked.push(options.find((option) => option.label === "names").description);
      return "names";
    },
  });
  await rt.start();
  await rt.run("ts", "preset max");

  await rt.run("ts", "config");
  assert.equal(asked[0], "menu", "the row entry is on the top level, not only under Knob");
  assert.deepEqual(asked[1], ["off", "preset", "names", "full"]);
  assert.match(
    asked[2],
    /^every knob spelled out: its name and its level, no icons — 🧩 MAX · caveman ultra · rtk on/,
    "the description is the row this shape would render, not a second template"
  );
  assert.deepEqual(asked[3], ["This session", "New sessions"], "the row asks where the pick goes");
  assert.equal(
    JSON.parse(readFileSync(CONFIG_FILE, "utf8")).modes.status,
    "names",
    "the shape is stored, not just applied"
  );

  const fresh = await createRuntime();
  await fresh.start();
  assert.match(fresh.row(), /^🧩 MAX · caveman ultra · rtk on · /, "a new session starts on the stored shape");
});

// The other scope of the same entry: a session-scoped pick changes the row now and writes nothing.
test("/ts config applies a footer row shape to this session when asked to", async () => {
  const picks = ["Footer row", "preset", "This session"];
  const rt = await createRuntime([], EXTENSION_FILES, { select: () => picks.shift() });
  await rt.start();

  await rt.run("ts", "config");
  assert.equal(rt.row(), "🧩 MAX", "the session row took the shape");
  assert.equal(existsSync(CONFIG_FILE), false, "and nothing was stored for new sessions");
});

// A config file that does not parse must not be replaced by the next write: reading it yields the
// built-in defaults, so writing on top of it would silently discard everything it held.
test("a hand-broken config is refused, not overwritten", async () => {
  const rt = await createRuntime();
  await rt.start();

  writeFileSync(CONFIG_FILE, '{ "version": 2, "preset": "lite", }');
  await rt.run("ts", "default ultra");

  const refusal = rt.notifications.at(-1);
  assert.equal(refusal.type, "warning");
  assert.match(refusal.text, /Config not written: .*is not valid JSON/);
  assert.equal(
    readFileSync(CONFIG_FILE, "utf8"),
    '{ "version": 2, "preset": "lite", }',
    "the broken file is left exactly as the user left it"
  );
});

// The row is built from the knob table, so a knob added there cannot be missing from every shape.
// `status` is the one legitimate exclusion: it picks the shape, so it cannot be a token of it. Both
// value shapes are checked: the default row shows every knob's marker, `names` shows every knob's
// name — a knob with neither is a knob nobody can see.
test("every knob in the table has a marker in the row, except the shape knob", async () => {
  const { KNOBS, MODE_KNOBS } = await import(pathToFileURL(join(EXT, "shared", "session-state.js")).href);
  const rt = await createRuntime();
  await rt.start();

  const expected = MODE_KNOBS.filter((knob) => knob !== "status");
  await rt.run("ts", "set status=full");
  const short = rt.row();
  assert.equal(tokens(short).length, expected.length + 2, "preset marker + preset name + one token per knob");

  await rt.run("ts", "set status=names");
  const spelled = rt.row();
  for (const knob of expected) {
    assert.ok(KNOBS[knob], `${knob} is a knob`);
    assert.ok(spelled.includes(`${knob} `), `${knob} appears in the spelled row`);
  }
});

// An option value no verb would accept is not obeyed either: honoring it would make the gate read one
// setting while `/ts status` printed another.
test("an option value outside the accepted vocabulary is ignored, not obeyed", async () => {
  writeFileSync(CONFIG_FILE, JSON.stringify({ version: 2, options: { native: { mode: "yes" } } }));
  const { readOptions } = await import(pathToFileURL(join(EXT, "shared", "session-state.js")).href);
  assert.equal(readOptions().native.mode, "off", "falls back to the default rather than reading `yes`");
});

// The knob is the wiring, not a label: `on` has to route, `off` has to unroute, and the row has to say
// which of the two actually happened.
test("/ts set headroom=on routes the session and shows it on the row", async () => {
  const rt = await createRuntime([], EXTENSION_FILES, { model: DEEPSEEK });
  await rt.start();

  await withProxyHealth(() => rt.run("ts", "set headroom=on"), {
    config: { openai_api_url: DEEPSEEK.baseUrl },
  });
  assert.equal(rt.ctx.models.current().baseUrl, PROXY_8787, "the provider is on the proxy");
  assert.match(rt.row(), /headroom on$/);

  await rt.run("ts", "set headroom=off");
  assert.equal(rt.ctx.models.current().baseUrl, DEEPSEEK.baseUrl, "the provider is back on its own endpoint");
  assert.match(rt.row(), /headroom off$/);
});

// Every preset carries headroom=off, so applying one on a routed session unroutes it: the knob is part
// of a preset like the others, and the row cannot keep claiming a routing the preset turned off.
test("a preset turns the headroom knob off and unroutes", async () => {
  const rt = await createRuntime([], EXTENSION_FILES, { model: DEEPSEEK });
  await rt.start();
  await withProxyHealth(() => rt.run("ts", "set headroom=on"), {
    config: { openai_api_url: DEEPSEEK.baseUrl },
  });
  assert.match(rt.row(), /headroom on$/);

  await rt.run("ts", "preset max");
  assert.equal(rt.ctx.models.current().baseUrl, DEEPSEEK.baseUrl);
  assert.match(rt.row(), /headroom off$/);
});

// A resumed session was routed by a process that has since ended: the entry still says `on`, so the
// session re-establishes the wiring it was left with.
test("a session that was left routed re-wraps on session start", async () => {
  const branch = [{ type: "custom", customType: "ts-mode", data: { name: "headroom", value: "on" }, id: "e1" }];
  const rt = await createRuntime(branch, EXTENSION_FILES, { model: DEEPSEEK });

  await withProxyHealth(async () => {
    await rt.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }, { config: { openai_api_url: DEEPSEEK.baseUrl } });

  assert.equal(rt.ctx.models.current().baseUrl, PROXY_8787, "the wiring is back");
  assert.match(rt.row(), /headroom on$/);
  assert.equal(
    rt.notifications.some((entry) => /now routes through the proxy/.test(entry.text)),
    false,
    "a start that rebuilt the routing the row already shows says nothing"
  );
});

// Silencing the start must not swallow a refusal: the one case a launch banner still earns its lines
// is the proxy on the port forwarding this provider's traffic somewhere else.
test("a start that cannot route still reports why", async () => {
  const branch = [{ type: "custom", customType: "ts-mode", data: { name: "headroom", value: "on" }, id: "e1" }];
  const rt = await createRuntime(branch, EXTENSION_FILES, { model: DEEPSEEK });

  await withProxyHealth(async () => {
    await rt.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }, { config: { openai_api_url: "https://api.openai.com/v1" } });

  const refusal = rt.notifications.at(-1);
  assert.equal(refusal.type, "warning");
  assert.match(refusal.text, /already up on 8787 forwarding openai_api_url to https:\/\/api\.openai\.com\/v1/);
  assert.equal(rt.ctx.models.current().baseUrl, DEEPSEEK.baseUrl, "nothing was rerouted");
  assert.match(rt.row(), /headroom off$/, "the knob publishes what actually happened");
});

// A preset speaks about behaviour; the row's shape is a preference the user set. Applying one must not
// relayout the footer under them, whichever shape they chose.
test("no preset touches the row's shape", async () => {
  const rt = await createRuntime();
  await rt.start();

  await rt.run("ts", "set status=names");
  for (const preset of ["off", "lite", "medium", "high", "max", "ultra"]) {
    await rt.run("ts", `preset ${preset}`);
    assert.match(rt.row(), /^🧩 [A-Z]+ · caveman [a-z]+ · /, `${preset} still spells the tool out`);
    assert.equal(rt.row().includes("🦴"), false, `${preset} kept the icon-free shape`);
  }

  await rt.run("ts", "set status=preset");
  await rt.run("ts", "preset ultra");
  assert.equal(rt.row(), "🧩 ULTRA", "the one-word shape survives a preset too");
});

// The shape is still storable for new sessions — it just is not part of a preset.
test("the row's shape stores as a preference and is replayed from the session", async () => {
  const rt = await createRuntime();
  await rt.start();
  await rt.run("ts", "default status=names");

  const { readConfig } = await import(pathToFileURL(join(EXT, "shared", "session-state.js")).href);
  assert.equal(readConfig().modes.status, "names", "a new session resolves the stored shape");
  assert.equal(readConfig().preset, "max", "a shape preference is not a behaviour, so the preset stands");

  const branch = [{ type: "custom", customType: "ts-mode", data: { name: "status", value: "names" }, id: "e1" }];
  const replayed = await createRuntime(branch);
  await replayed.start();
  assert.match(replayed.row(), /^🧩 MAX · caveman ultra · /, "the branch replays the shape it was left with");
});

// `compact` was retired with the overhaul: the default `full` row is now the narrow one, so a stored
// or branched `compact` is not a shape any more. It must fall back to the default, not throw, and not
// resurrect a third rendering.
test("a retired shape falls back to the default instead of breaking the row", async () => {
  const retired = await createRuntime([
    { type: "custom", customType: "ts-mode", data: { name: "status", value: "compact" }, id: "e1" },
  ]);
  const bare = await createRuntime();
  await retired.start();
  await bare.start();
  assert.equal(retired.row(), bare.row(), "a retired shape renders exactly what no shape renders");

  const before = retired.row();
  await retired.run("ts", "set status=compact");
  assert.match(retired.notifications.at(-1).text, /Invalid value for status: compact\. Use: off \| preset \| names \| full/);
  assert.equal(retired.row(), before, "a typed retired shape changes nothing either");
});

test("preset ultra turns headroom on, and the presets below it turn it back off", async () => {
  const rt = await createRuntime([], EXTENSION_FILES, { model: DEEPSEEK });
  await rt.start();

  await withProxyHealth(() => rt.run("ts", "preset ultra"), {
    config: { openai_api_url: DEEPSEEK.baseUrl },
  });
  assert.equal(rt.ctx.models.current().baseUrl, PROXY_8787, "ultra routed the session");
  assert.match(rt.row(), /headroom on$/);

  await rt.run("ts", "preset max");
  assert.equal(rt.ctx.models.current().baseUrl, DEEPSEEK.baseUrl, "max unroutes it again");
  assert.match(rt.row(), /headroom off$/);
});

// Writing a preset for new sessions drops the behaviour overrides that would fight it — but the row's
// shape is not behaviour, so a stored shape preference has to survive it.
test("storing a preset keeps a stored row-shape preference", async () => {
  const rt = await createRuntime();
  await rt.start();
  await rt.run("ts", "default status=names");
  await rt.run("ts", "default lite");

  const stored = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  assert.equal(stored.preset, "lite");
  assert.equal(stored.modes.status, "names", "the shape preference outlives the preset write");

  const { readConfig } = await import(pathToFileURL(join(EXT, "shared", "session-state.js")).href);
  assert.equal(readConfig().modes.status, "names");
  assert.equal(readConfig().preset, "lite", "and the preset is still what the behaviour knobs say");
});

test("/ts option rejects a group that no longer exists", async () => {
  const rt = await createRuntime();
  await rt.start();

  await rt.run("ts", "option compress.maxLines=100");
  const refused = rt.notifications.at(-1);
  assert.equal(refused.type, "warning");
  assert.match(refused.text, /Unknown option: compress\.maxLines=100/);
  assert.match(refused.text, /autoRtk\.\{timeoutMs\|exclude\}/);
  assert.equal(existsSync(CONFIG_FILE), false, "a rejected option writes nothing");
});

// The menu is a front end for the verbs, not a second implementation: a pick has to reach the same
// write the typed form reaches. Selectors answer with their label, so a label is a real value.
test("/ts config reaches the same writes as the typed verbs", async () => {
  const picks = ["Knob", "ponytail", "off", "This session"];
  const rt = await createRuntime([], EXTENSION_FILES, { select: () => picks.shift() });
  await rt.start();

  await rt.run("ts", "config");
  assert.deepEqual(
    rt.entries.filter((entry) => entry.customType === "ponytail-mode").map((entry) => entry.data),
    [{ mode: "off" }],
    "a session-scoped pick writes what `/ts set ponytail=off` writes"
  );
  assert.match(rt.row(), /· ponytail off ·/, "the ponytail token is off, spelled out in the default shape");

  // The same menu, the other scope: the pick lands in the config file and not in the session.
  const stored = ["Knob", "read", "off", "New sessions"];
  rt.ctx.ui.select = () => stored.shift();
  await rt.run("ts", "config");
  assert.equal(JSON.parse(readFileSync(CONFIG_FILE, "utf8")).modes.read, "off", "stored for new sessions");
  assert.match(rt.row(), /· read full ·/, "storing a default leaves the running session alone");
  assert.deepEqual(stored, [], "the menu consumed exactly the selectors it showed");
});

test("/ts config with no selector prints the verbs instead of opening nothing", async () => {
  const rt = await createRuntime();
  await rt.start();
  rt.ctx.hasUI = false;

  await rt.run("ts", "config");
  assert.match(rt.notifications.at(-1).text, /No selector in this session/);
});

test("/ts config escape lands on nothing", async () => {
  const rt = await createRuntime([], EXTENSION_FILES, { select: () => undefined });
  await rt.start();
  const before = rt.row();

  await rt.run("ts", "config");
  assert.deepEqual(rt.entries, [], "an abandoned menu writes no session entry");
  assert.equal(rt.row(), before, "an abandoned menu leaves the row alone");
  assert.equal(existsSync(CONFIG_FILE), false, "an abandoned menu writes no config");
});

// --- /ai-addons: where the version comes from ----------------------------------------------------
//
// The updater is a second extension with its own seams: every version it reads over the network goes
// through `fetch`, so a stub decides what is published, and the pack's own directory is derived from
// the module URL — which is why the stamp, the lock file and the plugin root all live in the sandbox.

const AI_ADDONS = join(EXT, "ai-addons-updater", "index.js");
const PACK_VERSION = JSON.parse(readFileSync(join(EXT, "..", "package.json"), "utf8")).version;
// The upstream caveman rule, verbatim in the part that matters: it advertises three levels this pack
// does not have, which is the whole reason the rule is validated before it is injected.
const UPSTREAM_RULE =
  "Respond terse like smart caveman. All technical substance stay. Only fluff die.\n\n" +
  "Switch level: /caveman lite|full|ultra|wenyan-lite|wenyan-full|wenyan-ultra\n" +
  'Stop: "stop caveman" or "normal mode"\n';

// Every check the updater makes, stubbed. `versions` is mutated by a test that wants newer news.
function withNetwork(versions = {}) {
  const previous = globalThis.fetch;
  const json = (value) => ({ ok: true, status: 200, json: async () => value, text: async () => JSON.stringify(value) });
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes("caveman-activate.md") && versions.caveman) {
      return { ok: true, status: 200, json: async () => ({}), text: async () => versions.caveman };
    }
    if (target.includes("omp-supreme-token-saver/main/package.json") && versions.published) return json({ version: versions.published });
    if (target.includes("registry.npmjs.org") && versions.npm) return json({ version: versions.npm });
    if (target.includes("DietrichGebert/ponytail") && versions.ponytail) return json({ version: versions.ponytail });
    if (target.includes("api.github.com") && versions.rtk) return json({ tag_name: versions.rtk });
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
  return () => { globalThis.fetch = previous; };
}

const tokenSaverRow = (rt) => rt.notifications.map((n) => n.text).find((text) => text.startsWith("Token saver "));

test("/ai-addons reports the version each source holds, and never a date", async () => {
  const rt = await createRuntime([], [AI_ADDONS]);
  const restore = withNetwork({ published: "2.2.0" });
  try {
    // Only the package.json the module travels with is there: the plugin layout's last resort, and the
    // version a repo checkout reports.
    await rt.run("ai-addons", "check");
    const row = tokenSaverRow(rt);
    assert.match(row, new RegExp(`local=${PACK_VERSION} \\(package\\.json\\)`));
    assert.match(row, /published=2\.2\.0/);

    // A plugin install: the manifest under the plugins root answers for it.
    mkdirSync(dirname(PLUGIN_MANIFEST), { recursive: true });
    writeFileSync(PLUGIN_MANIFEST, JSON.stringify({ version: "7.7.7" }));
    rt.notifications.length = 0;
    await rt.run("ai-addons", "check");
    assert.match(tokenSaverRow(rt), /local=7\.7\.7 \(package\.json\)/);

    // The lock file is what omp believes is installed: it outranks the manifest.
    writeFileSync(LOCK_FILE, JSON.stringify({ plugins: { "@dillydalli3r/omp-supreme-token-saver": { version: "8.8.8" } } }));
    rt.notifications.length = 0;
    await rt.run("ai-addons", "check");
    assert.match(tokenSaverRow(rt), /local=8\.8\.8 \(omp-plugins\.lock\.json\)/);

    // The stamp an install writes into the tree is the most specific of the three.
    writeFileSync(VERSION_STAMP, JSON.stringify({ version: "9.9.9" }));
    rt.notifications.length = 0;
    await rt.run("ai-addons", "check");
    assert.match(tokenSaverRow(rt), /local=9\.9\.9 \(stamp\)/);

    for (const { text } of rt.notifications) {
      assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}/, "a version row never guesses from a date");
    }
  } finally { restore(); }
});

test("/ts status names the command that makes the native knobs real, and stops once they are", async () => {
  const rt = await createRuntime();
  await rt.start();
  // The process-wide state bridge keeps whatever the previous test left behind, so this session states
  // the preset it is about rather than inheriting one.
  await rt.run("ts", "preset max");
  await rt.run("ts", "status");
  assert.match(rt.notifications.at(-1).text, /Native knobs: knobs are prompt-level only — \/ts native on/);

  await rt.run("ts", "native on");
  await rt.run("ts", "status");
  assert.doesNotMatch(rt.notifications.at(-1).text, /Native knobs:/, "the line goes away once the gate writes");
});

test("the caveman rule a session is given never names a level /caveman rejects", async () => {
  const upstreamPath = join(SANDBOX, "upstream-rule.md");
  writeFileSync(upstreamPath, UPSTREAM_RULE);

  const rt = await createRuntime(
    [{ type: "custom", customType: "caveman-mode", data: { mode: "full" }, id: "e1" }],
    [join(EXT, "caveman-session", "index.js")]
  );
  await rt.start();

  const previous = process.env.OMP_CAVEMAN_RULE;
  try {
    process.env.OMP_CAVEMAN_RULE = join(EXT, "caveman-session", "rule.md");
    const shipped = await rt.runBeforeAgentStart("base");
    assert.match(shipped, /Switch level: \/caveman off\|lite\|full\|ultra\|wenyan/);

    // The installer's overwrite: three of those levels are not values this pack has.
    process.env.OMP_CAVEMAN_RULE = upstreamPath;
    const overwritten = await rt.runBeforeAgentStart("base");
    assert.doesNotMatch(overwritten, /wenyan-(lite|full|ultra)/);
    assert.equal(overwritten, shipped, "an overwritten rule.md injects what the repo ships, byte for byte");
  } finally {
    if (previous === undefined) delete process.env.OMP_CAVEMAN_RULE;
    else process.env.OMP_CAVEMAN_RULE = previous;
  }
});
