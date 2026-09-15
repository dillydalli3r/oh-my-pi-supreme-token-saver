import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const BRIDGE_KEY = Symbol.for("@fernado03/oh-my-pi-supreme-token-saver/combo-session-state");
const requireFromDir = createRequire(import.meta.url);

export const OMP_SUBAGENT_MARKER = "You are operating on a piece of work assigned to you by the main agent.";

export const COMBO_LEVELS = Object.freeze({
  off: Object.freeze({ level: "off", caveman: "off", rtk: "off", ponytail: "off" }),
  medium: Object.freeze({ level: "medium", caveman: "lite", rtk: "on", ponytail: "lite" }),
  max: Object.freeze({ level: "max", caveman: "ultra", rtk: "on", ponytail: "ultra" }),
});

// Session-start defaults: a branch with no combo/caveman/rtk/ponytail entries starts from these
// modes. `/combo default <level|app=mode>` writes the file; it is the only knob that carries a
// choice into new sessions.
export const COMBO_DEFAULTS_FILE =
  process.env.OMP_COMBO_DEFAULTS_FILE || path.join(os.homedir(), ".omp", "agent", "combo-defaults.json");

const MODE_VALUES = {
  caveman: new Set(["off", "lite", "full", "ultra", "wenyan"]),
  rtk: new Set(["off", "on"]),
  ponytail: new Set(["off", "lite", "full", "ultra", "review"]),
};

function normalizeMode(name, value) {
  if (name === "rtk" && typeof value === "boolean") return value ? "on" : "off";
  const mode = String(value ?? "").trim().toLowerCase();
  return MODE_VALUES[name]?.has(mode) ? mode : null;
}

function deriveLevel(modes) {
  for (const level of ["off", "medium", "max"]) {
    const preset = COMBO_LEVELS[level];
    if (preset.caveman === modes.caveman && preset.rtk === modes.rtk && preset.ponytail === modes.ponytail) return level;
  }
  return "custom";
}

function isKnownLevel(value) {
  return value === "custom" || Object.prototype.hasOwnProperty.call(COMBO_LEVELS, value);
}

function normalizedState(modes, level = deriveLevel(modes)) {
  const state = {
    caveman: normalizeMode("caveman", modes?.caveman) || "off",
    rtk: normalizeMode("rtk", modes?.rtk) || "off",
    ponytail: normalizeMode("ponytail", modes?.ponytail) || "off",
  };
  return Object.freeze({ level: isKnownLevel(level) ? level : deriveLevel(state), ...state });
}

// Location of the ponytail plugin's own modules. OMP_PONYTAIL_PACKAGE_DIR overrides it (tests,
// non-standard plugin locations).
export function ponytailPackageFile(file) {
  const dir = process.env.OMP_PONYTAIL_PACKAGE_DIR ||
    path.join(os.homedir(), ".omp", "plugins", "node_modules", "@dietrichgebert", "ponytail");
  return path.join(dir, file);
}

// Ponytail's own plugin owns the ponytail default (its config.json / PONYTAIL_DEFAULT_MODE), so read
// it back rather than trusting a second copy: a fresh session must never claim a ponytail level the
// plugin is not running.
function ponytailPluginConfig() {
  try {
    return requireFromDir(ponytailPackageFile("hooks/ponytail-config.js"));
  } catch {
    return null;
  }
}

function readDefaultsFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(COMBO_DEFAULTS_FILE, "utf8").replace(/^\uFEFF/, ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function readComboDefaults() {
  const stored = readDefaultsFile();
  // The plugin's value is what actually runs: it already folds in `PONYTAIL_DEFAULT_MODE`, which
  // outranks any config file. Our stored ponytail mode is only a mirror we keep in sync.
  const pluginDefault = normalizeMode("ponytail", ponytailPluginConfig()?.getDefaultMode?.());
  return normalizedState({
    caveman: normalizeMode("caveman", stored.caveman) || COMBO_LEVELS.max.caveman,
    rtk: normalizeMode("rtk", stored.rtk) || COMBO_LEVELS.max.rtk,
    ponytail: pluginDefault || normalizeMode("ponytail", stored.ponytail) || COMBO_LEVELS.max.ponytail,
  });
}

// Merge `modes` into the stored defaults. Keys absent from the file keep deferring to the built-in or
// plugin default, so a caveman-only write never pins ponytail. Read readComboDefaults() for the
// effective state after the caller syncs the ponytail plugin.
export function writeComboDefaults(modes) {
  const next = { ...readDefaultsFile() };
  for (const name of ["caveman", "rtk", "ponytail"]) {
    const mode = normalizeMode(name, modes?.[name]);
    if (mode) next[name] = mode;
  }
  fs.mkdirSync(path.dirname(COMBO_DEFAULTS_FILE), { recursive: true });
  fs.writeFileSync(
    COMBO_DEFAULTS_FILE,
    `${JSON.stringify({ caveman: next.caveman, rtk: next.rtk, ponytail: next.ponytail }, null, 2)}\n`,
    "utf8"
  );
}

// Drop the override entirely: the built-in default (and, for ponytail, the plugin's own default) applies again.
export function clearComboDefaults() {
  fs.rmSync(COMBO_DEFAULTS_FILE, { force: true });
  return readComboDefaults();
}

function bridge() {
  const existing = globalThis[BRIDGE_KEY];
  if (existing?.state) return existing;
  return (globalThis[BRIDGE_KEY] = { state: readComboDefaults(), listener: null });
}

function publish(state) {
  const shared = bridge();
  shared.state = state;
  shared.listener?.(state);
  return state;
}

export function isOmpSubagentPrompt(systemPrompt) {
  const prompts = Array.isArray(systemPrompt) ? systemPrompt : [systemPrompt];
  return prompts.some((prompt) => typeof prompt === "string" && prompt.includes(OMP_SUBAGENT_MARKER));
}

export function normalizeComboLevel(value) {
  const level = String(value || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(COMBO_LEVELS, level) ? level : null;
}

export function getSharedComboState() {
  return bridge().state;
}

export function setSharedComboLevel(value) {
  const level = normalizeComboLevel(value) || "off";
  return publish(normalizedState(COMBO_LEVELS[level], level));
}

export function setSharedComboMode(name, value) {
  const mode = normalizeMode(name, value);
  if (!mode) return getSharedComboState();
  const modes = { ...getSharedComboState(), [name]: mode };
  return publish(normalizedState(modes, deriveLevel(modes)));
}

export function reconcileSharedComboEntries(entries) {
  const defaults = readComboDefaults();
  let modes = { caveman: defaults.caveman, rtk: defaults.rtk, ponytail: defaults.ponytail };
  let level = defaults.level;
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (entry?.type !== "custom") continue;
      if (entry.customType === "combo-level") {
        const preset = normalizeComboLevel(entry?.data?.level);
        if (preset) {
          modes = { ...COMBO_LEVELS[preset] };
          level = preset;
        }
        continue;
      }
      const name = entry.customType === "caveman-mode"
        ? "caveman"
        : entry.customType === "rtk-mode"
          ? "rtk"
          : entry.customType === "ponytail-mode"
            ? "ponytail"
            : null;
      if (!name) continue;
      const value = name === "rtk" ? entry?.data?.enabled : entry?.data?.mode;
      const mode = normalizeMode(name, value);
      if (mode) {
        modes[name] = mode;
        level = deriveLevel(modes);
      }
    }
  }
  return publish(normalizedState(modes, level));
}

export function setSharedComboListener(listener) {
  const shared = bridge();
  shared.listener = typeof listener === "function" ? listener : null;
  return () => {
    if (shared.listener === listener) shared.listener = null;
  };
}

export function resetSharedComboState() {
  return setSharedComboLevel("off");
}
