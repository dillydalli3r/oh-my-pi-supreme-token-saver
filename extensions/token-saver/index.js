// Supreme Token Saver — the one entry point for the pack: presets, the unified status row, and the
// driver that mirrors a preset onto OMP's own native settings.
//
// The three behaviours this pack used to reimplement in JS — structural read summaries, shell-output
// compression, and cache-aware pruning of stale tool results — ship inside OMP itself and are
// configured through `config.yml`. Duplicating them as hooks would drift from the host and cost a
// round trip per call, so the `read` / `compress` / `prune` knobs now *select* native settings
// instead of running code: this extension is the single place a preset is chosen, and `omp config`
// is the only writer of the host's settings (it validates each key against the host's schema).

import os from "node:os";
import path from "node:path";
import {
  CONFIG_FILE,
  DEFAULT_OPTIONS,
  DEFAULT_PRESET,
  KNOBS,
  MODE_KNOBS,
  PRESET_NAMES,
  clearConfig,
  canonicalKnob,
  getSharedState,
  normalizeMode,
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

// Preset -> native OMP settings. Every key below exists in the host's settings schema
// (pi-coding-agent src/config/settings-schema.ts), and `omp config set` rejects anything that is
// not in it, which is what keeps this table honest as OMP moves.
//   read.summarize.*                       structural summaries for selector-less reads (the `read` knob)
//   shellMinimizer.*                       compresses verbose shell output (the `compress` knob)
//   compaction.supersedeReads/dropUseless  cache-aware elision of stale results (the `prune` knob)
// plus the size dials those behaviours read: read.defaultLimit, the tools.artifact* spill keys,
// compaction.keepRecentTokens/idleEnabled, task.* and the top-level skillful.
const NATIVE_TABLE_ORDER = Object.freeze(["lite", "medium", "high", "max", "ultra"]);

// One column per preset, one row per setting, so the whole mapping is reviewable at a glance. Every
// key is spelled exactly as the host's schema spells it — `tools.artifactSpillThreshold` and the
// `tools.artifactTail*` keys are scalar dotted keys, not a `tools.artifact.*` group.
//   tools.intentTracing defaults to TRUE and adds an intent string to every tool call; it is the one
//   key whose token-saving value is `false`, so only `high` and above switch it off.
//   skillful=false removes the skill inventory from the system prompt — a real tradeoff, so `ultra`.
//   tools.artifactHeadBytes=0 means tail-only spill.
//   compaction.keepRecentTokens is the verbatim-history floor left after a compaction: the main dial
//   on post-compaction context size.
// Left deliberately alone: provider.appendOnlyContext (already cache-friendly), memory.backend,
// advisor/autolearn/prewalk (off by default), snapcompact (experimental), and every
// display/statusLine/tui key — display-only, zero model tokens.
const NATIVE_TABLE = Object.freeze({
  "read.summarize.enabled": Object.freeze([true, true, true, true, true]),
  "read.summarize.prose": Object.freeze([false, false, false, true, true]),
  "read.summarize.minTotalLines": Object.freeze([100, 100, 80, 60, 40]),
  "read.summarize.unfoldLimit": Object.freeze([100, 100, 80, 60, 40]),
  "read.defaultLimit": Object.freeze([300, 300, 200, 200, 200]),
  "shellMinimizer.enabled": Object.freeze([true, true, true, true, true]),
  "shellMinimizer.sourceOutlineLevel": Object.freeze(["default", "default", "default", "default", "aggressive"]),
  "tools.artifactSpillThreshold": Object.freeze([50, 50, 30, 20, 10]),
  "tools.artifactTailBytes": Object.freeze([20, 20, 16, 12, 8]),
  "tools.artifactHeadBytes": Object.freeze([20, 20, 16, 12, 0]),
  "tools.artifactTailLines": Object.freeze([500, 500, 400, 300, 200]),
  "tools.intentTracing": Object.freeze([true, true, false, false, false]),
  "compaction.supersedeReads": Object.freeze([true, true, true, true, true]),
  "compaction.dropUseless": Object.freeze([true, true, true, true, true]),
  "compaction.keepRecentTokens": Object.freeze([20000, 20000, 16000, 12000, 8000]),
  "compaction.idleEnabled": Object.freeze([false, false, false, true, true]),
  "task.maxEffort": Object.freeze(["max", "max", "high", "high", "medium"]),
  "task.softRequestBudget": Object.freeze([200, 200, 200, 150, 90]),
  skillful: Object.freeze([true, true, true, true, false]),
});

const NATIVE_KEYS = Object.freeze(Object.keys(NATIVE_TABLE));

// `off` writes no anti-defaults: it resets this exact key set to the host's defaults, because a
// pinned `false` would outlive the release it was written for, while a reset returns to whatever the
// host then considers sane.
const NATIVE_OFF = "off";

function nativeMapping(preset) {
  const column = NATIVE_TABLE_ORDER.indexOf(preset);
  if (column < 0) return null;
  const mapping = {};
  for (const key of NATIVE_KEYS) mapping[key] = NATIVE_TABLE[key][column];
  return mapping;
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

function presetOf(state) {
  return NATIVE_TABLE_ORDER.includes(state.preset) || state.preset === NATIVE_OFF ? state.preset : null;
}

function usageText() {
  return [
    "/ts                          — status: preset, knobs, context meter, config path",
    `/ts preset <${PRESET_NAMES.join("|")}>   — apply now (also /ts <preset>, /combo <preset>)`,
    "/ts set <knob>=<value> ...   — one knob for this session",
    "/ts default [<preset> | <knob>=<value> ... | reset]  — what new sessions start from",
    "/ts option <group>.<key>=<value>  — behaviour of our own add-ons",
    "/ts native [status|on|off|apply|reset]  — OMP's own read/shell/compaction settings",
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
    `Native config.yml: ${readOptions().native.mode}${readOptions().native.mode === "auto" ? " (follows the preset)" : " (/ts native apply writes it)"}`,
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

  function reconcile(ctx) {
    const state = reconcileSharedEntries(entriesFrom(ctx));
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

  async function applyNative(preset, ctx, force) {
    if (preset === NATIVE_OFF) {
      await resetNative(ctx, `for preset OFF`);
      return;
    }

    const mapping = nativeMapping(preset);
    if (!mapping) {
      notify(ctx, `No native mapping for preset "${preset}" — pick a preset first, then /ts native apply.`, "warning");
      return;
    }

    let current;
    try {
      current = await readNativeValues(pi);
    } catch (error) {
      notify(ctx, `Native settings unavailable: ${error?.message || error}. config.yml untouched.`, "warning");
      return;
    }

    // Read once, write only the keys that differ: a preset switch costs one `omp` call plus a handful
    // of writes instead of one call per key.
    const pending = Object.entries(mapping).filter(([key, value]) => current.get(key) !== value);
    if (!pending.length) {
      if (force) notify(ctx, `Native settings already match preset ${String(preset).toUpperCase()}.`, "info");
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
      `Native OMP settings for ${String(preset).toUpperCase()}: ${written.length} key(s) written` +
        `${failed.length ? `, ${failed.length} failed — ${failed.join("; ")}` : ""}\n` +
        `${written.join(" ")}\nFile: ${await nativePathOf()}`,
      failed.length ? "warning" : "info"
    );
  }

  async function nativeStatus(ctx) {
    const gate = readOptions().native.mode;
    const state = getSharedState();
    const preset = presetOf(state);
    const shown = preset || DEFAULT_PRESET;
    const mapping = nativeMapping(shown);

    let current;
    try {
      current = await readNativeValues(pi);
    } catch (error) {
      notify(
        ctx,
        `Native OMP settings: ${gate} (presets ${gate === "auto" ? "write" : "never write"} config.yml)\n` +
          `Unavailable: ${error?.message || error}`,
        "warning"
      );
      return;
    }

    const header =
      preset === NATIVE_OFF
        ? `${NATIVE_KEYS.length} keys reset to OMP defaults`
        : `${NATIVE_KEYS.length - Object.keys(mapping).length} key(s) left at OMP defaults`;
    const lines = NATIVE_KEYS.map((key) => {
      const have = showValue(current.get(key));
      const want = preset === NATIVE_OFF ? "OMP default" : nativeText(mapping[key]);
      return `${have === want ? "=" : "→"} ${key}: ${have} → ${want}`;
    });
    notify(
      ctx,
      `Native OMP settings: ${gate} (presets ${gate === "auto" ? "write" : "never write"} config.yml)` +
        ` · preset ${String(shown).toUpperCase()} (${header})` +
        `${preset ? "" : " — running state is custom, showing the " + DEFAULT_PRESET.toUpperCase() + " mapping"}\n` +
        `${lines.join("\n")}\nFile: ${await nativePathOf()}\n/ts native apply | reset | on | off`,
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

    if (readOptions().native.mode === "auto") await applyNative(preset, ctx, false);
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
      if (!KNOBS[name]) {
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
      setSharedMode(name, mode);
    }
    render(ctx);
    notify(ctx, `Set ${changes.map(([name, mode]) => `${name}=${mode}`).join(" ")}`);
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
      clearConfig();
      ponytail = readConfig().modes.ponytail;
    } else {
      const preset = normalizePreset(text);
      if (preset) {
        writeConfig({ preset });
        ponytail = presetModes(preset).ponytail;
      } else {
        const items = pairs(text, /[\s,]+/);
        const modes = {};
        for (const item of items) {
          const split = item.indexOf("=");
          const name = canonicalKnob(split > 0 ? item.slice(0, split) : "");
          const raw = split > 0 ? item.slice(split + 1).trim() : "";
          if (!KNOBS[name]) {
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
        writeConfig({ modes });
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

    if (!group || !key || !DEFAULT_OPTIONS[group] || !(key in DEFAULT_OPTIONS[group])) {
      notify(
        ctx,
        `Unknown option: ${text || "(none)"}\nOptions: ${Object.entries(DEFAULT_OPTIONS)
          .map(([name, keys]) => `${name}.{${Object.keys(keys).join("|")}}`)
          .join(", ")}`,
        "warning"
      );
      return;
    }

    const current = DEFAULT_OPTIONS[group][key];
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
      value = raw;
    }

    const config = writeConfig({ options: { [group]: { [key]: value } } });
    notify(
      ctx,
      `${group}.${key} = ${JSON.stringify(config.options[group][key])} · Config: ${CONFIG_FILE}\n` +
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
      writeConfig({ options: { native: { mode: "auto" } } });
      notify(ctx, "Native OMP settings: auto — applying a preset now also writes its config.yml keys.", "info");
      return;
    }
    if (text === "off") {
      writeConfig({ options: { native: { mode: "off" } } });
      notify(ctx, "Native OMP settings: off — presets no longer touch config.yml (/ts native apply still does).", "info");
      return;
    }
    if (text === "apply") {
      await applyNative(presetOf(getSharedState()) || DEFAULT_PRESET, ctx, true);
      return;
    }
    if (text === "reset") {
      await resetNative(ctx, "reset");
      return;
    }
    notify(ctx, "Usage: /ts native [on|off|apply|reset|status]", "warning");
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
    if (head === "default") {
      applyDefault(rest, ctx);
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
