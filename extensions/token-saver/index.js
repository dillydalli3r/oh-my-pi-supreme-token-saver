// Supreme Token Saver — the one entry point for the pack: presets, the unified status row, and the
// driver that mirrors the running state onto OMP's own native settings.
//
// The three behaviours this pack used to reimplement in JS — structural read summaries, shell-output
// compression, and cache-aware pruning of stale tool results — ship inside OMP itself and are
// configured through `config.yml`. Duplicating them as hooks would drift from the host and cost a
// round trip per call, so the `read` / `compress` / `prune` knobs *select* native settings instead
// of running code, and the preset supplies the tier dials those behaviours do not cover. `omp
// config` is the only writer of the host's settings (it validates each key against the host's
// schema).

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CONFIG_FILE,
  DEFAULT_OPTIONS,
  DEFAULT_PRESET,
  KNOBS,
  MODE_KNOBS,
  OPTION_VALUES,
  PRESET_NAMES,
  clearConfig,
  canonicalKnob,
  getSharedState,
  normalizeMode,
  normalizeOptionValue,
  normalizePreset,
  presetModes,
  readConfig,
  readOptions,
  reconcileSharedEntries,
  setSharedListener,
  setSharedMode,
  setSharedPreset,
  setSharedUsage,
  syncPonytailDefault,
  writeConfig,
} from "../shared/session-state.js";
import { renderModes } from "../shared/status-line.js";

const IS_WINDOWS = process.platform === "win32";
const OMP_TIMEOUT_MS = 15000;
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".omp", "agent");

// Knob level -> native OMP settings. Every key below exists in the host's settings schema
// (pi-coding-agent src/config/settings-schema.ts), and `omp config set` rejects anything that is
// not in it, which is what keeps these tables honest as OMP moves.
//   read.summarize.*                       structural summaries for selector-less reads (the `read` knob)
//   read.defaultLimit                      the size dial that behaviour reads
//   shellMinimizer.* / tools.artifact*     compress verbose shell output (the `compress` knob)
//   compaction.*                           cache-aware elision of stale results (the `prune` knob)
// One table per knob, keyed by level, because the knobs are independent: a user who sets
// compress=ultra and leaves `read` alone must get the ultra compress keys and the default read
// keys, which a single preset-keyed column cannot express. Every key is spelled exactly as the
// host's schema spells it — `tools.artifactSpillThreshold` and the `tools.artifactTail*` keys are
// scalar dotted keys, not a `tools.artifact.*` group.
const KNOB_NATIVE = Object.freeze({
  read: Object.freeze({
    off: Object.freeze({
      "read.summarize.enabled": false,
      "read.summarize.prose": false,
      "read.summarize.minTotalLines": 100,
      "read.summarize.unfoldLimit": 100,
      "read.defaultLimit": 300,
    }),
    lite: Object.freeze({
      "read.summarize.enabled": true,
      "read.summarize.prose": false,
      "read.summarize.minTotalLines": 100,
      "read.summarize.unfoldLimit": 100,
      "read.defaultLimit": 300,
    }),
    full: Object.freeze({
      "read.summarize.enabled": true,
      "read.summarize.prose": true,
      "read.summarize.minTotalLines": 60,
      "read.summarize.unfoldLimit": 60,
      "read.defaultLimit": 200,
    }),
  }),
  compress: Object.freeze({
    off: Object.freeze({
      "shellMinimizer.enabled": false,
      "shellMinimizer.sourceOutlineLevel": "default",
      "tools.artifactSpillThreshold": 50,
      "tools.artifactTailBytes": 20,
      "tools.artifactHeadBytes": 20,
      "tools.artifactTailLines": 500,
    }),
    lite: Object.freeze({
      "shellMinimizer.enabled": true,
      "shellMinimizer.sourceOutlineLevel": "default",
      "tools.artifactSpillThreshold": 50,
      "tools.artifactTailBytes": 20,
      "tools.artifactHeadBytes": 20,
      "tools.artifactTailLines": 500,
    }),
    full: Object.freeze({
      "shellMinimizer.enabled": true,
      "shellMinimizer.sourceOutlineLevel": "default",
      "tools.artifactSpillThreshold": 20,
      "tools.artifactTailBytes": 12,
      "tools.artifactHeadBytes": 12,
      "tools.artifactTailLines": 300,
    }),
    ultra: Object.freeze({
      "shellMinimizer.enabled": true,
      "shellMinimizer.sourceOutlineLevel": "aggressive",
      "tools.artifactSpillThreshold": 10,
      "tools.artifactTailBytes": 8,
      "tools.artifactHeadBytes": 0,
      "tools.artifactTailLines": 200,
    }),
  }),
  prune: Object.freeze({
    off: Object.freeze({
      "compaction.supersedeReads": false,
      "compaction.dropUseless": false,
      "compaction.keepRecentTokens": 20000,
      "compaction.idleEnabled": false,
    }),
    lite: Object.freeze({
      "compaction.supersedeReads": true,
      "compaction.dropUseless": false,
      "compaction.keepRecentTokens": 20000,
      "compaction.idleEnabled": false,
    }),
    full: Object.freeze({
      "compaction.supersedeReads": true,
      "compaction.dropUseless": true,
      "compaction.keepRecentTokens": 12000,
      "compaction.idleEnabled": false,
    }),
    ultra: Object.freeze({
      "compaction.supersedeReads": true,
      "compaction.dropUseless": true,
      "compaction.keepRecentTokens": 8000,
      "compaction.idleEnabled": true,
    }),
  }),
});

// The tier dials — prompt-level behaviour that no single knob owns, so they stay keyed by preset.
//   tools.intentTracing defaults to TRUE and adds an intent string to every tool call; it is the one
//   key whose token-saving value is `false`, so only `high` and above switch it off.
//   skillful=false removes the skill inventory from the system prompt — a real tradeoff, so `ultra`.
//   tools.artifactHeadBytes=0 (in `compress`) means tail-only spill.
//   compaction.keepRecentTokens is the verbatim-history floor left after a compaction: the main dial
//   on post-compaction context size.
// Left deliberately alone: provider.appendOnlyContext (already cache-friendly), memory.backend,
// advisor/autolearn/prewalk (off by default), snapcompact (experimental), and every
// display/statusLine/tui key — display-only, zero model tokens.
const PRESET_NATIVE = Object.freeze({
  lite: Object.freeze({
    "tools.intentTracing": true,
    "task.maxEffort": "max",
    "task.softRequestBudget": 200,
    skillful: true,
  }),
  medium: Object.freeze({
    "tools.intentTracing": true,
    "task.maxEffort": "max",
    "task.softRequestBudget": 200,
    skillful: true,
  }),
  high: Object.freeze({
    "tools.intentTracing": false,
    "task.maxEffort": "high",
    "task.softRequestBudget": 200,
    skillful: true,
  }),
  max: Object.freeze({
    "tools.intentTracing": false,
    "task.maxEffort": "high",
    "task.softRequestBudget": 150,
    skillful: true,
  }),
  ultra: Object.freeze({
    "tools.intentTracing": false,
    "task.maxEffort": "medium",
    "task.softRequestBudget": 90,
    skillful: false,
  }),
});

// Every key any table can write, computed once at load: `off` resets exactly this set, and the
// status table walks it so it can never drift from the mapping above.
const NATIVE_KEYS = Object.freeze([
  ...new Set([
    ...Object.values(KNOB_NATIVE).flatMap((levels) => Object.values(levels).flatMap((level) => Object.keys(level))),
    ...Object.values(PRESET_NATIVE).flatMap((tier) => Object.keys(tier)),
  ]),
]);

// `off` writes no anti-defaults: it resets this exact key set to the host's defaults, because a
// pinned `false` would outlive the release it was written for, while a reset returns to whatever the
// host then considers sane.
const NATIVE_OFF = "off";

// The tier dials come from the state's preset. A hand-mixed knob set has no tier of its own, so the
// dials fall back to the built-in default tier rather than inventing one from whichever knobs happen
// to be set.
function tierOf(state) {
  return PRESET_NATIVE[state.preset] ? state.preset : DEFAULT_PRESET;
}

// What the running state wants written: the three knobs' keys plus the tier's dials.
function nativeMapping(state) {
  return {
    ...KNOB_NATIVE.read[state.read],
    ...KNOB_NATIVE.compress[state.compress],
    ...KNOB_NATIVE.prune[state.prune],
    ...PRESET_NATIVE[tierOf(state)],
  };
}

// What a write or a status report is based on: a preset state names itself, a hand-mixed one says so
// and names the tier whose dials it fell back to.
function nativeTier(state) {
  return PRESET_NAMES.includes(state.preset) ? state.preset : `${tierOf(state)} (state is custom)`;
}

function nativeText(value) {
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

// Windows resolves `omp` to an .exe/.cmd shim that Node refuses to spawn without a shell; the repo
// installer's execCli does the same thing for the same reason.
function ompCommand(args) {
  return IS_WINDOWS ? ["cmd.exe", ["/c", "omp", ...args]] : ["omp", args];
}

// Headroom is detect-and-guide only: it is an optional external Python tool whose Rust core is a
// CPython extension (no JS surface for us to import, nothing to bundle), and `headroom wrap omp`
// only redirects the anthropic provider — so we report what the machine has and hand over the
// commands, and we never wrap, install, or call it on a session event.
const HEADROOM_TIMEOUT_MS = 10000;
const HEADROOM_INSTALL = 'uv tool install --python 3.13 "headroom-ai[all]"';

// Same Windows shim as ompCommand: a bare `headroom` does not resolve to the .exe without a shell.
function headroomCommand(args) {
  return IS_WINDOWS
    ? [process.env.ComSpec || "cmd.exe", ["/c", "headroom", ...args]]
    : ["headroom", args];
}

async function execHeadroom(pi, args) {
  if (typeof pi?.exec !== "function") throw new Error("this session exposes no exec");
  const [command, argv] = headroomCommand(args);
  const result = await pi.exec(command, argv, { timeout: HEADROOM_TIMEOUT_MS });
  if (result?.code !== 0) {
    const stderr = String(result?.stderr || result?.stdout || "").trim().split("\n").filter(Boolean).pop();
    throw new Error(stderr || `headroom exited ${result?.code}`);
  }
  return clip(result?.stdout || result?.stderr, 600);
}

// A status report is a notification, not a file dump.
function clip(text, max) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// `headroom wrap omp` fenced-injects a providers.anthropic.baseUrl override into the agent dir's
// models.yml, so that mention is the whole wrap state visible from here.
function headroomWrapState() {
  const file = path.join(AGENT_DIR, "models.yml");
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { file, state: "models.yml missing", line: "" };
  }
  const line = text.split(/\r?\n/).find((row) => /headroom/i.test(row));
  return { file, state: line ? "wrapped" : "not wrapped", line: clip(line, 120) };
}

// The wrap only rewrites the anthropic baseUrl, so any other active provider keeps its own endpoint.
function activeProvider(ctx) {
  try {
    return clip(ctx?.models?.current?.()?.provider, 120);
  } catch {
    return "";
  }
}

async function headroomStatusText(pi, ctx) {
  let version = "";
  try {
    version = await execHeadroom(pi, ["--version"]);
  } catch {
    version = "";
  }

  const wrap = headroomWrapState();
  const provider = activeProvider(ctx);
  return [
    version ? `Headroom: ${version}` : `Headroom: not installed\nInstall: ${HEADROOM_INSTALL}`,
    `Wrap: ${wrap.state}${wrap.line ? ` — ${wrap.line}` : ""}`,
    `Session provider: ${provider || "unknown"} — \`headroom wrap omp\` redirects only the anthropic provider, so ${
      provider === "anthropic"
        ? "a wrap would cover this session's traffic"
        : "a wrap changes nothing for this session"
    }`,
    `models.yml: ${wrap.file}`,
    "Run from your own shell — it starts a proxy and launches a new omp, so not from inside omp:",
    "  headroom wrap omp",
    "Undo (safe here or there): /ts headroom unwrap",
  ].join("\n");
}

async function execOmp(pi, args) {
  if (typeof pi?.exec !== "function") throw new Error("this session exposes no exec");
  const [command, argv] = ompCommand([...args, "--json"]);
  const result = await pi.exec(command, argv, { timeout: OMP_TIMEOUT_MS });
  if (result?.code !== 0) {
    const stderr = String(result?.stderr || result?.stdout || "").trim().split("\n").filter(Boolean).pop();
    throw new Error(stderr || `omp config exited ${result?.code}`);
  }
  return String(result?.stdout || "");
}

// `omp config get|set|reset|list --json` all print a JSON object (list prints a path -> entry map).
function firstJsonObject(raw) {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function readNativeValues(pi) {
  const parsed = firstJsonObject(await execOmp(pi, ["config", "list"]));
  if (!parsed || typeof parsed !== "object") throw new Error("unexpected `omp config list --json` output");
  const values = new Map();
  for (const [key, entry] of Object.entries(parsed)) {
    values.set(key, entry && typeof entry === "object" && "value" in entry ? entry.value : entry);
  }
  return values;
}

async function runNativeCommand(pi, args) {
  const parsed = firstJsonObject(await execOmp(pi, args));
  return parsed?.value;
}

function showValue(value) {
  if (value === undefined || value === null) return "(unset)";
  return String(value);
}

function pairs(text, separator) {
  return String(text || "").trim().split(separator).filter(Boolean);
}

function usageText() {
  return [
    "/ts                          — status: preset, knobs, context meter, config path",
    `/ts preset <${PRESET_NAMES.join("|")}>   — apply now (also /ts <preset>, /combo <preset>)`,
    "/ts set <knob>=<value> ...   — one knob for this session",
    "/ts default [<preset> | <knob>=<value> ... | reset]  — what new sessions start from",
    "/ts option <group>.<key>=<value>  — behaviour of our own add-ons",
    "/ts native [status|on|off|apply|reset]  — OMP's own read/shell/compaction settings",
    "/ts headroom [status|wrap|unwrap|install]  — optional Headroom proxy: detect it, unwrap in-session, run wrap yourself",
    "/ts help                     — this list",
    "",
    `Knobs: ${MODE_KNOBS.map((name) => `${name} (${KNOBS[name].join("|")})`).join(", ")}`,
    `Options: ${Object.entries(DEFAULT_OPTIONS)
      .map(([group, keys]) => `${group}.{${Object.keys(keys).join(",")}}`)
      .join(", ")}`,
  ].join("\n");
}

function statusText(ctx) {
  const state = getSharedState();
  const usage = ctx?.getContextUsage?.();
  const percent = typeof usage?.percent === "number" ? `${usage.percent}%` : "n/a";
  const defaults = readConfig();
  return [
    `Token Saver: ${String(state.preset).toUpperCase()}`,
    MODE_KNOBS.map((name) => `${name}=${state[name]}`).join(" "),
    `Context: ${percent}`,
    `Config: ${CONFIG_FILE}`,
    `Native config.yml: ${readOptions().native.mode}${
      readOptions().native.mode === "auto" ? " (follows the knobs and preset)" : " (/ts native apply writes it)"
    }`,
    `Default for new sessions: ${String(defaults.preset).toUpperCase()} (${MODE_KNOBS.map((name) => `${name}=${defaults.modes[name]}`).join(" ")})`,
    "Run /ts help for the command list.",
  ].join("\n");
}

function defaultSummary(ctx) {
  const defaults = readConfig();
  return [
    `Default for new sessions: ${String(defaults.preset).toUpperCase()}`,
    MODE_KNOBS.map((name) => `${name}=${defaults.modes[name]}`).join(" "),
    `Config: ${CONFIG_FILE}`,
  ].join("\n");
}

export default function tokenSaverExtension(pi) {
  let activeCtx = null;
  let watchTimer = null;
  let listenerInstalled = false;
  let nativeConfigPath = null;

  pi.setLabel?.("Supreme Token Saver");

  function notify(ctx, text, type) {
    ctx?.ui?.notify?.(text, type || "info");
  }

  function entriesFrom(ctx) {
    return ctx?.sessionManager?.getBranch?.() || ctx?.sessionManager?.getEntries?.() || [];
  }

  function render(ctx) {
    return renderModes(getSharedState(), ctx);
  }

  // A config path that cannot be written (a directory, a read-only install) must degrade to a
  // warning like the native and headroom layers do, never throw out of the command handler.
  function reportWrite(ctx, result) {
    if (!result.error) return true;
    notify(ctx, `Config not written: ${result.error}\nFile: ${CONFIG_FILE}`, "warning");
    return false;
  }

  function reconcile(ctx) {
    // The session id keeps a second runner in this process (a subagent gets its own) from
    // republishing its empty branch over this session's live state.
    const state = reconcileSharedEntries(entriesFrom(ctx), ctx?.sessionManager?.getSessionId?.());
    render(ctx);
    return state;
  }

  // The ponytail plugin appends `ponytail-mode` entries from its own commands without telling us,
  // and a sibling add-on can change a knob the same way. Watch the branch so the unified row tracks
  // it. // ponytail: 1s poll; switch to an event if omp emits a command-completed hook.
  function branchKey(ctx) {
    const entries = entriesFrom(ctx);
    return `${entries.length}:${entries.at(-1)?.id || ""}`;
  }

  function watchBranch(ctx) {
    if (!ctx?.setInterval || !ctx?.clearTimer) return;
    if (watchTimer) ctx.clearTimer(watchTimer);
    let lastKey = branchKey(ctx);
    watchTimer = ctx.setInterval(() => {
      const key = branchKey(ctx);
      if (key === lastKey) return;
      lastKey = key;
      reconcile(ctx);
    }, 1000);
  }

  function listen(ctx) {
    if (ctx) activeCtx = ctx;
    if (listenerInstalled) return;
    setSharedListener((state) => renderModes(state, activeCtx));
    listenerInstalled = true;
  }

  function onSession(_event, ctx) {
    listen(ctx);
    if (ctx) activeCtx = ctx;
    reconcile(ctx);
    watchBranch(ctx);
  }

  // One getContextUsage() call per event; the row reads the published usage back from shared state.
  function meter(_event, ctx) {
    const usage = ctx?.getContextUsage?.();
    setSharedUsage(usage && typeof usage.percent === "number" ? usage : null);
    render(ctx);
  }

  // --- native settings ---------------------------------------------------------------------

  async function nativePathOf() {
    if (nativeConfigPath) return nativeConfigPath;
    if (typeof pi?.exec === "function") {
      try {
        const [command, argv] = ompCommand(["config", "path"]);
        const result = await pi.exec(command, argv, { timeout: OMP_TIMEOUT_MS });
        const printed = String(result?.stdout || "").trim().split("\n").filter(Boolean).pop();
        if (result?.code === 0 && printed) {
          nativeConfigPath = path.join(printed, "config.yml");
          return nativeConfigPath;
        }
      } catch {
        // Fall through to the default location.
      }
    }
    nativeConfigPath = path.join(AGENT_DIR, "config.yml");
    return nativeConfigPath;
  }

  // `off` restores the host's defaults for exactly the mapped keys and reports which ones it reset.
  // `omp config reset` leaves each key pinned at its default rather than deleting the line, so a
  // reset leaves the mapped keys visible in config.yml at host defaults — inert, and one hand edit
  // away from gone.
  // ponytail: one `omp` process per key (19); a batch verb would make this ~20x faster if the CLI
  // ever grows one.
  async function resetNative(ctx, label) {
    const reset = [];
    const failed = [];
    for (const key of NATIVE_KEYS) {
      try {
        await runNativeCommand(pi, ["config", "reset", key]);
        reset.push(key);
      } catch (error) {
        failed.push(`${key} (${error?.message || error})`);
      }
    }
    notify(
      ctx,
      `Native OMP settings ${label}: ${reset.length}/${NATIVE_KEYS.length} key(s) reset to OMP defaults` +
        `${failed.length ? `; failed — ${failed.join("; ")}` : ""}\n${reset.join(" ")}` +
        `\nFile: ${await nativePathOf()}`,
      failed.length ? "warning" : "info"
    );
  }

  async function applyNative(ctx, force) {
    const state = getSharedState();
    if (state.preset === NATIVE_OFF) {
      await resetNative(ctx, "for preset OFF");
      return;
    }

    const mapping = nativeMapping(state);
    const tier = nativeTier(state);

    let current;
    try {
      current = await readNativeValues(pi);
    } catch (error) {
      notify(ctx, `Native settings unavailable: ${error?.message || error}. config.yml untouched.`, "warning");
      return;
    }

    // Read once, write only the keys that differ: a state change costs one `omp` call plus a handful
    // of writes instead of one call per key.
    const pending = Object.entries(mapping).filter(([key, value]) => current.get(key) !== value);
    if (!pending.length) {
      if (force) notify(ctx, `Native settings already match tier ${tier}.`, "info");
      return;
    }

    const written = [];
    const failed = [];
    for (const [key, value] of pending) {
      try {
        await runNativeCommand(pi, ["config", "set", key, nativeText(value)]);
        written.push(`${key}=${nativeText(value)}`);
      } catch (error) {
        failed.push(`${key} (${error?.message || error})`);
      }
    }

    notify(
      ctx,
      `Native OMP settings for tier ${tier}: ${written.length} key(s) written` +
        `${failed.length ? `, ${failed.length} failed — ${failed.join("; ")}` : ""}\n` +
        `${written.join(" ")}\nFile: ${await nativePathOf()}`,
      failed.length ? "warning" : "info"
    );
  }

  async function nativeStatus(ctx) {
    const gate = readOptions().native.mode;
    const state = getSharedState();
    const off = state.preset === NATIVE_OFF;
    const mapping = nativeMapping(state);

    let current;
    try {
      current = await readNativeValues(pi);
    } catch (error) {
      notify(
        ctx,
        `Native OMP settings: ${gate} (${gate === "auto" ? "follows" : "never writes"} config.yml)\n` +
          `Unavailable: ${error?.message || error}`,
        "warning"
      );
      return;
    }

    const lines = NATIVE_KEYS.map((key) => {
      const have = showValue(current.get(key));
      const want = off ? "OMP default" : nativeText(mapping[key]);
      return `${have === want ? "=" : "→"} ${key}: ${have} → ${want}`;
    });
    notify(
      ctx,
      `Native OMP settings: ${gate} (${gate === "auto" ? "follows" : "never writes"} config.yml)` +
        ` · tier: ${off ? `${NATIVE_OFF} — every key resets to the OMP default` : nativeTier(state)}` +
        `\n${lines.join("\n")}\nFile: ${await nativePathOf()}\n/ts native apply | reset | on | off`,
      "info"
    );
  }

  // --- commands ----------------------------------------------------------------------------

  async function applyPreset(name, ctx) {
    const preset = normalizePreset(name);
    if (!preset) {
      notify(ctx, `Unknown preset: ${name}. Use: ${PRESET_NAMES.join(" | ")}`, "warning");
      return;
    }

    const state = setSharedPreset(preset);
    const modes = presetModes(preset);
    pi.appendEntry("ts-preset", { preset });
    // Pre-2.0 builds and the upstream ponytail plugin read these three, so a preset keeps writing
    // them: a session reopened by an older install (or by the plugin) still shows the same state.
    pi.appendEntry("caveman-mode", { mode: modes.caveman });
    pi.appendEntry("rtk-mode", { enabled: modes.rtk === "on" });
    pi.appendEntry("ponytail-mode", { mode: modes.ponytail });
    renderModes(state, ctx);
    notify(ctx, `Preset ${preset.toUpperCase()} applied: ${MODE_KNOBS.map((knob) => `${knob}=${modes[knob]}`).join(" ")}`);

    if (readOptions().native.mode === "auto") await applyNative(ctx, false);
    await ctx?.reload?.();
  }

  async function applySet(arg, ctx) {
    const items = pairs(arg, /[\s,]+/);
    if (!items.length) {
      notify(ctx, `Usage: /ts set <knob>=<value> ...\nKnobs: ${MODE_KNOBS.join(", ")}`, "warning");
      return;
    }

    // Validate every pair before writing any: one typo must not half-apply a line of them.
    const changes = [];
    for (const item of items) {
      const split = item.indexOf("=");
      const name = canonicalKnob(split > 0 ? item.slice(0, split) : "");
      const raw = split > 0 ? item.slice(split + 1).trim() : "";
      // `canonicalKnob` is the guard: a name it cannot resolve is not a knob, and testing
      // `KNOBS[name]` instead would accept `constructor` and then index a function.
      if (!name) {
        notify(ctx, `Unknown knob: ${item}. Knobs: ${MODE_KNOBS.join(", ")}`, "warning");
        return;
      }
      const mode = normalizeMode(name, raw);
      if (!mode) {
        notify(ctx, `Invalid value for ${name}: ${raw}. Use: ${KNOBS[name].join(" | ")}`, "warning");
        return;
      }
      changes.push([name, mode]);
    }

    for (const [name, mode] of changes) {
      pi.appendEntry("ts-mode", { name, value: mode });
      // The upstream ponytail plugin reads its own `ponytail-mode` entries for session state, so the
      // knob needs the same entry a preset writes — a `ts-mode` entry alone is display-only.
      if (name === "ponytail") pi.appendEntry("ponytail-mode", { mode });
      setSharedMode(name, mode);
    }
    render(ctx);
    notify(ctx, `Set ${changes.map(([name, mode]) => `${name}=${mode}`).join(" ")}`);
    // A knob is a level of a native behaviour, so opting into auto means /ts set writes too, not just
    // /ts preset: the shared state is already published, so applyNative sees the new levels.
    if (readOptions().native.mode === "auto") await applyNative(ctx, false);
    await ctx?.reload?.();
  }

  function applyDefault(arg, ctx) {
    const text = String(arg || "").trim();
    if (!text) {
      notify(ctx, `${defaultSummary(ctx)}\nRunning sessions are unchanged.`, "info");
      return;
    }

    let synced = true;
    let ponytail = null;

    if (text === "reset") {
      if (!reportWrite(ctx, clearConfig())) return;
      ponytail = readConfig().modes.ponytail;
    } else {
      const preset = normalizePreset(text);
      if (preset) {
        if (!reportWrite(ctx, writeConfig({ preset }))) return;
        ponytail = presetModes(preset).ponytail;
      } else {
        const items = pairs(text, /[\s,]+/);
        const modes = {};
        for (const item of items) {
          const split = item.indexOf("=");
          const name = canonicalKnob(split > 0 ? item.slice(0, split) : "");
          const raw = split > 0 ? item.slice(split + 1).trim() : "";
          // `canonicalKnob` already answered "is this a knob"; `KNOBS[name]` would answer for
          // `constructor` too and then index a function.
          if (!name) {
            notify(ctx, `Unknown knob: ${item}. Knobs: ${MODE_KNOBS.join(", ")}`, "warning");
            return;
          }
          const mode = normalizeMode(name, raw);
          if (!mode) {
            notify(ctx, `Invalid value for ${name}: ${raw}. Use: ${KNOBS[name].join(" | ")}`, "warning");
            return;
          }
          modes[name] = mode;
        }
        if (!reportWrite(ctx, writeConfig({ modes }))) return;
        ponytail = modes.ponytail ?? null;
      }
    }

    // The ponytail plugin owns its own default, so push it only when this write chose one.
    if (ponytail) synced = syncPonytailDefault(ponytail);
    notify(
      ctx,
      `${defaultSummary(ctx)}` +
        `${synced ? "" : "\n[pending] Ponytail plugin not found — its own default was not synced."}\n` +
        "Running session unchanged; /ts preset <name> applies a preset now.",
      synced ? "info" : "warning"
    );
  }

  function applyOption(arg, ctx) {
    const text = String(arg || "").trim();
    const split = text.indexOf("=");
    const [group, key] = (split > 0 ? text.slice(0, split) : text).split(".");
    const raw = split > 0 ? text.slice(split + 1).trim() : "";

    // Own-property lookups on both halves: `DEFAULT_OPTIONS.constructor` and a bare `key in group`
    // both resolve through Object.prototype, which is how a junk group reached the config file.
    const keys = Object.prototype.hasOwnProperty.call(DEFAULT_OPTIONS, group) ? DEFAULT_OPTIONS[group] : null;
    if (!key || !keys || !Object.prototype.hasOwnProperty.call(keys, key)) {
      notify(
        ctx,
        `Unknown option: ${text || "(none)"}\nOptions: ${Object.entries(DEFAULT_OPTIONS)
          .map(([name, groupKeys]) => `${name}.{${Object.keys(groupKeys).join("|")}}`)
          .join(", ")}`,
        "warning"
      );
      return;
    }

    const current = keys[key];
    let value;
    if (typeof current === "boolean") {
      if (raw !== "true" && raw !== "false") {
        notify(ctx, `${group}.${key} takes true or false.`, "warning");
        return;
      }
      value = raw === "true";
    } else if (typeof current === "number") {
      value = Number(raw);
      if (!Number.isFinite(value)) {
        notify(ctx, `${group}.${key} takes a number.`, "warning");
        return;
      }
    } else if (Array.isArray(current)) {
      try {
        value = JSON.parse(raw);
      } catch {
        value = null;
      }
      if (!Array.isArray(value)) {
        notify(ctx, `${group}.${key} takes a JSON array, e.g. [".git", "node_modules"].`, "warning");
        return;
      }
    } else {
      // A string option is an enum: `/ts native on` writes "auto", so `native.mode=on` means the
      // same thing rather than a second word for one setting.
      value = normalizeOptionValue(group, key, raw);
      if (!value) {
        const allowed = OPTION_VALUES[group]?.[key] ?? [];
        notify(ctx, `${group}.${key} takes ${allowed.join(" | ")} (on and true mean auto).`, "warning");
        return;
      }
    }

    const result = writeConfig({ options: { [group]: { [key]: value } } });
    if (!reportWrite(ctx, result)) return;
    notify(
      ctx,
      `${group}.${key} = ${JSON.stringify(result.config.options[group][key])} · Config: ${CONFIG_FILE}\n` +
        "Applies to new sessions (options describe behaviour, not intensity).",
      "info"
    );
  }

  async function applyNativeVerb(arg, ctx) {
    const text = String(arg || "").trim().toLowerCase();
    if (!text || text === "status") {
      await nativeStatus(ctx);
      return;
    }
    if (text === "on" || text === "auto") {
      if (!reportWrite(ctx, writeConfig({ options: { native: { mode: "auto" } } }))) return;
      notify(ctx, "Native OMP settings: auto — a preset or a knob change now also writes its config.yml keys.", "info");
      return;
    }
    if (text === "off") {
      if (!reportWrite(ctx, writeConfig({ options: { native: { mode: "off" } } }))) return;
      notify(ctx, "Native OMP settings: off — presets no longer touch config.yml (/ts native apply still does).", "info");
      return;
    }
    if (text === "apply") {
      await applyNative(ctx, true);
      return;
    }
    if (text === "reset") {
      await resetNative(ctx, "reset");
      return;
    }
    notify(ctx, "Usage: /ts native [on|off|apply|reset|status]", "warning");
  }

  // Headroom is never wrapped automatically: the wrap command launches its own omp, so only the
  // safe half (status, unwrap) and the pure-information half (install) run here.
  async function headroomVerb(arg, ctx) {
    const verb = String(arg || "").trim().split(/\s+/)[0].toLowerCase();

    if (!verb || verb === "status") {
      notify(ctx, await headroomStatusText(pi, ctx), "info");
      return;
    }

    if (verb === "wrap") {
      notify(
        ctx,
        "Refusing: `headroom wrap omp` starts a proxy and launches its own omp, so running it here would nest omp inside omp.\n" +
          "Run it from your own shell instead: headroom wrap omp",
        "warning"
      );
      return;
    }

    if (verb === "unwrap") {
      const wrap = headroomWrapState();
      try {
        const printed = await execHeadroom(pi, ["unwrap", "omp"]);
        notify(ctx, `headroom unwrap omp: ${printed || "done (no output)"}\nmodels.yml: ${wrap.file}`, "info");
      } catch (error) {
        notify(
          ctx,
          `headroom unwrap omp failed: ${clip(error?.message || error, 600)}\nmodels.yml: ${wrap.file}\nRun /ts headroom status.`,
          "warning"
        );
      }
      return;
    }

    if (verb === "install") {
      notify(
        ctx,
        "Refusing to run an installer here: Headroom is a Python package (its Rust core is a CPython " +
          "extension) and installing it needs a Python toolchain and an interactive shell.\n" +
          `uv: ${HEADROOM_INSTALL} (canonical)\n` +
          'pip: pip install "headroom-ai[all]"\n' +
          "Docker: docker pull ghcr.io/headroomlabs-ai/headroom:latest\n" +
          "Windows: the prebuilt wheel works as-is; a source build needs MSVC + Rust.",
        "info"
      );
      return;
    }

    notify(ctx, "Usage: /ts headroom [status|wrap|unwrap|install]", "warning");
  }

  async function dispatch(arg, ctx, presetOnly) {
    const text = String(arg || "").trim();
    const head = text.split(/\s+/)[0].toLowerCase();
    const rest = text.slice(head.length).trim();

    if (!head || head === "status") {
      notify(ctx, statusText(ctx), "info");
      return;
    }
    if (head === "help") {
      notify(ctx, usageText(), "info");
      return;
    }

    const preset = normalizePreset(head);
    if (preset) {
      await applyPreset(preset, ctx);
      return;
    }

    // `/combo` predates the knob set and only ever spoke presets (`/combo max`, `/combo default lite`),
    // so it keeps accepting presets and `default` — the pre-2.0 command surface — and refuses the
    // newer knobs rather than half-supporting them.
    if (head === "preset") {
      await applyPreset(rest, ctx);
      return;
    }
    if (head === "default") {
      applyDefault(rest, ctx);
      return;
    }

    if (presetOnly) {
      notify(ctx, `Unknown preset: ${head}. Use: ${PRESET_NAMES.join(" | ")}, or /ts help.`, "warning");
      return;
    }

    if (head === "set") {
      await applySet(rest, ctx);
      return;
    }
    if (head === "option") {
      applyOption(rest, ctx);
      return;
    }
    if (head === "native") {
      await applyNativeVerb(rest, ctx);
      return;
    }
    if (head === "headroom") {
      await headroomVerb(rest, ctx);
      return;
    }
    notify(ctx, `Unknown command: ${head}. ${usageText()}`, "warning");
  }

  // `/token-saver` and `/ts` are the same surface; `/combo` stays as a preset-only alias so an
  // existing muscle memory (and the pre-2.0 help text) keeps working.
  const handler = async (args, ctx) => {
    if (ctx) activeCtx = ctx;
    await dispatch(args, ctx, false);
  };

  pi.registerCommand("token-saver", {
    description: "Supreme Token Saver: presets, knobs, context meter, native OMP settings",
    handler,
  });

  pi.registerCommand("ts", {
    description: "Alias for /token-saver",
    handler,
  });

  pi.registerCommand("combo", {
    description: `Set every token-saving knob at once. Usage: /combo <${PRESET_NAMES.join("|")}|status>`,
    handler: async (args, ctx) => {
      if (ctx) activeCtx = ctx;
      await dispatch(args, ctx, true);
    },
  });

  pi.on("session_start", onSession);
  pi.on("session_branch", onSession);
  pi.on("session_tree", onSession);
  pi.on("agent_start", onSession);
  // Metered at `turn_end` only: `message_end` fires for every message in a turn, and each firing
  // would re-read the usage and rewrite the footer row for no new information.
  pi.on("turn_end", meter);
}
