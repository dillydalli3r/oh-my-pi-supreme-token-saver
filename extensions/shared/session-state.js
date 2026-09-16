// Shared configuration + per-session state for the Supreme Token Saver add-ons.
//
// One module owns three things so every add-on agrees on them:
//   1. the knob table — which knobs exist and which values each accepts,
//   2. the presets — a named value per knob (off -> ultra),
//   3. the persisted defaults a fresh session starts from (~/.omp/agent/token-saver.json).
// Per-session overrides live in the session branch as custom entries and are folded back in
// by reconcileSharedEntries(), so two sessions can run different presets without writing config.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const BRIDGE_KEY = Symbol.for("@fernado03/oh-my-pi-supreme-token-saver/combo-session-state");
const requireFromDir = createRequire(import.meta.url);

const OMP_SUBAGENT_MARKER = "You are operating on a piece of work assigned to you by the main agent.";

// Knob -> accepted values. A knob's first value is its off state, and every preset below sets
// every knob, so `derivePreset` can compare whole states and no knob can be half-configured.
//
// The order is the order every surface lists them in — the footer row, `/ts status`, `/ts default` —
// and it is grouped rather than historical: a knob that modifies another sits directly after it
// (`autoRtk` next to the `rtk` it auto-wraps), and the four knobs driving OMP's own token economy stay
// together (`read`, `compress`, `prune`, `threshold`). `status` is last because it is the one knob that is not a
// behaviour: it picks the row's shape.
export const KNOBS = Object.freeze({
  caveman: Object.freeze(["off", "lite", "full", "ultra", "wenyan"]),
  rtk: Object.freeze(["off", "on"]),
  autoRtk: Object.freeze(["off", "on"]),
  ponytail: Object.freeze(["off", "lite", "full", "ultra"]),
  read: Object.freeze(["off", "lite", "full"]),
  compress: Object.freeze(["off", "lite", "full", "ultra"]),
  prune: Object.freeze(["off", "lite", "full", "ultra"]),
  // *When* compaction fires, where `prune` decides what it may elide. It is a host-side timing dial,
  // not a prompt behaviour, so no preset below `high` moves it off OMP's reserve-based default.
  // `off` pins that default explicitly: `-1` means "reserve-based", which is the stock host value,
  // not "never compact".
  threshold: Object.freeze(["off", "lite", "full", "ultra"]),
  // The proxy routes this session's provider traffic; `on` is an explicit opt-in to a process being
  // started, which is why no preset turns it on — a preset is a token dial, not a licence to spawn a
  // proxy on a machine that may not even have headroom installed.
  headroom: Object.freeze(["off", "on"]),
  // The row's shape. `full` is the default and the narrow one (icon + short value per knob), `names`
  // spells the same knobs out; a third letter-based shape would have been a second rendering of
  // `full`, so there is none.
  status: Object.freeze(["off", "preset", "names", "full"]),
});

export const MODE_KNOBS = Object.freeze(Object.keys(KNOBS));

// Presets, lightest first. `lite` is the smallest useful saving; `ultra` trades prompt tokens for
// behaviour (deferred tool schemas, aggressive pruning) on top of `max`.
//
// A preset describes *behaviour* only: it deliberately carries no `status`, so applying one can never
// change the footer row's layout under you — the shape is a preference, set with `/ts set status=` or
// stored with `/ts default status=`. `headroom` is the one knob a preset switches, and only `ultra`
// turns it on, because it is the only knob whose `on` starts a process.
const PRESETS = Object.freeze({
  off: Object.freeze({
    caveman: "off", rtk: "off", autoRtk: "off", ponytail: "off",
    read: "off", compress: "off", prune: "off", threshold: "off", headroom: "off",
  }),
  lite: Object.freeze({
    caveman: "lite", rtk: "on", autoRtk: "on", ponytail: "lite",
    read: "off", compress: "lite", prune: "off", threshold: "off", headroom: "off",
  }),
  medium: Object.freeze({
    caveman: "full", rtk: "on", autoRtk: "on", ponytail: "full",
    read: "lite", compress: "full", prune: "off", threshold: "off", headroom: "off",
  }),
  high: Object.freeze({
    caveman: "ultra", rtk: "on", autoRtk: "on", ponytail: "full",
    read: "full", compress: "full", prune: "lite", threshold: "lite", headroom: "off",
  }),
  max: Object.freeze({
    caveman: "ultra", rtk: "on", autoRtk: "on", ponytail: "ultra",
    read: "full", compress: "full", prune: "full", threshold: "full", headroom: "off",
  }),
  ultra: Object.freeze({
    caveman: "ultra", rtk: "on", autoRtk: "on", ponytail: "ultra",
    read: "full", compress: "ultra", prune: "ultra", threshold: "ultra", headroom: "on",
  }),
});

// What a preset speaks about: every knob except the row's shape.
export const BEHAVIOUR_KNOBS = Object.freeze(MODE_KNOBS.filter((knob) => knob !== "status"));

// The row shape a session starts with when nothing stored a preference. It lives beside the presets
// rather than inside them, which is what keeps a preset application from touching the layout. `names`
// is the default because a footer is read, not decoded: the nine one-letter tokens say nothing until
// the reader has learned the table, and the names themselves are what `/ts set` takes.
export const DEFAULT_STATUS = "names";

// The share of the context window each `threshold` level stands for, mapped by token-saver onto
// `compaction.thresholdPercent` and printed by status-line.js in the row — one number, two readers,
// so it lives here rather than in either of them. `-1` is the host's own "no share of my own", whose
// limit is the reserve rather than a share.
export const THRESHOLD_PERCENT = Object.freeze({ off: -1, lite: 85, full: 70, ultra: 55 });

export const PRESET_NAMES = Object.freeze(Object.keys(PRESETS));
export const DEFAULT_PRESET = "max";

export const CONFIG_FILE =
  process.env.OMP_TOKEN_SAVER_CONFIG || path.join(os.homedir(), ".omp", "agent", "token-saver.json");

// Pre-2.0 installs stored the same defaults per app. Read once so an upgrade keeps the level the
// user chose; writes always go to CONFIG_FILE.
const LEGACY_DEFAULTS_FILE =
  process.env.OMP_COMBO_DEFAULTS_FILE || path.join(os.homedir(), ".omp", "agent", "combo-defaults.json");

// Numeric/extras a behaviour actually reads. Only keys with a reader live here: everything else a
// user could set would be a knob that changes nothing, and `/ts option` would advertise it.
// The `read` / `compress` / `prune` / `threshold` behaviours are configured through OMP's own settings
// (read.summarize.*, shellMinimizer.*, compaction.*) — the knob levels drive those, mapped by
// token-saver, not by this file.
export const DEFAULT_OPTIONS = Object.freeze({
  autoRtk: Object.freeze({ timeoutMs: 2000, exclude: Object.freeze([]) }),
  // Whether applying a preset also writes the matching OMP settings in ~/.omp/agent/config.yml.
  // `off` keeps the user's own OMP config untouched unless `/ts native apply` asks for it.
  native: Object.freeze({ mode: "off" }),
  // Which port the pack's headroom proxy listens on. 8787 is headroom's own default, so a proxy you
  // started yourself owns it — this is how the pack runs beside one instead of fighting it.
  headroom: Object.freeze({ port: 8787 }),
  // The two compaction limits, and which one is written when both are set. `percent` is a share of
  // the context window (`-1` = whatever the `threshold` level stands for), `tokens` is an absolute
  // cap (`-1` = none), and `pick` decides between them: `auto` writes the one that fires first,
  // `percent`/`tokens` pin one. The decision has to be made here because a positive
  // `compaction.thresholdTokens` silently outranks the percent in the host — "whichever is lower"
  // is not something the host can express.
  threshold: Object.freeze({ percent: -1, tokens: -1, pick: "auto" }),
});

// Accepted values for the string options. An option that gates a behaviour is an enum, not free
// text: `/ts native on` already writes "auto", so the option verb has to accept the same word
// instead of letting a second vocabulary for one setting into the config file.
export const OPTION_VALUES = Object.freeze({
  native: Object.freeze({ mode: Object.freeze(["off", "auto"]) }),
  threshold: Object.freeze({ pick: Object.freeze(["auto", "percent", "tokens"]) }),
});

// Own-property lookup, never `KNOBS[name]`: `constructor`, `toString` and friends are inherited from
// Object.prototype, so a bare lookup answers a truthiness test with a function and a `.includes`
// call on it throws out of the command handler.
const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

export function normalizeMode(name, value) {
  if (!owns(KNOBS, name)) return null;
  if (name === "rtk" || name === "autoRtk") {
    if (typeof value === "boolean") return value ? "on" : "off";
    if (value === "true") return "on";
    if (value === "false") return "off";
  }
  const mode = String(value ?? "").trim().toLowerCase();
  return KNOBS[name].includes(mode) ? mode : null;
}

// Every level a piece of caveman rule text names after `/caveman` that no `/caveman` here accepts, in
// order of appearance. Two readers need the same verdict: caveman-session refuses to inject a rule
// naming a foreign level, and the updater refuses to call the upstream copy an update while it names
// one. That upstream text advertises `wenyan-lite|wenyan-full|wenyan-ultra` — three values this pack
// does not have — which is why the check exists at all.
export function foreignLevels(text) {
  const allowed = new Set(KNOBS.caveman);
  const foreign = new Set();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const at = line.indexOf("/caveman");
    if (at < 0) continue;
    // Everything after the command name on that line, split on the separators a level list uses.
    for (const token of line.slice(at + "/caveman".length).split(/[^A-Za-z-]+/)) {
      const level = token.toLowerCase();
      if (level && !allowed.has(level)) foreign.add(level);
    }
  }
  return [...foreign];
}

// The `read`, `compress`, `prune` and `threshold` knobs reach OMP's own settings only when
// `options.native.mode` is `auto`. While it is `off` — the default, and it stays the default because
// writing a user's config.yml has to be opt-in — a preset carrying real levels changes prompt text and
// the row and nothing else. One line, naming the one command that closes the gap; null when there is
// none to name.
const NATIVE_GAP_PRESETS = Object.freeze(["high", "max", "ultra"]);

export function nativeGapHint(preset, nativeMode) {
  return NATIVE_GAP_PRESETS.includes(preset) && nativeMode !== "auto"
    ? "knobs are prompt-level only — /ts native on also writes OMP's read/compress/prune/threshold keys"
    : null;
}

// The value to store for a string option, or null when it takes no such value.
export function normalizeOptionValue(group, key, value) {
  const allowed = owns(OPTION_VALUES, group) && owns(OPTION_VALUES[group], key) ? OPTION_VALUES[group][key] : null;
  if (!allowed) return null;
  const text = String(value ?? "").trim().toLowerCase();
  if ((text === "on" || text === "true") && allowed.includes("auto")) return "auto";
  return allowed.includes(text) ? text : null;
}

// Knob names are camelCase (`autoRtk`), but users type them in any case. Resolve the name once here
// so every command parser accepts `/ts set autortk=off` and `/ts set autoRtk=off` alike.
export function canonicalKnob(name) {
  const raw = String(name ?? "").trim();
  if (owns(KNOBS, raw)) return raw;
  const lowered = raw.toLowerCase();
  return MODE_KNOBS.find((knob) => knob.toLowerCase() === lowered) || null;
}

export function normalizePreset(value) {
  const name = String(value ?? "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PRESETS, name) ? name : null;
}

// Whole-state comparison: a state that matches a preset reports that preset, anything else is custom.
// `status` is display-only — it costs no model tokens and changes no behaviour — so it is left out of
// the comparison: picking a row shape must not demote the session to `custom` (which would also drop
// the preset's native tier dials) on a session whose compression knobs still are a preset.
function derivePreset(modes) {
  for (const name of PRESET_NAMES) {
    const preset = PRESETS[name];
    if (BEHAVIOUR_KNOBS.every((knob) => preset[knob] === modes[knob])) return name;
  }
  return "custom";
}

export function presetModes(name) {
  const preset = normalizePreset(name);
  return preset ? { ...PRESETS[preset] } : null;
}

// `modes` wins over the preset for the keys it sets, so a partial config stays a partial override.
function resolveModes({ preset = DEFAULT_PRESET, modes } = {}) {
  const base = presetModes(preset) || presetModes(DEFAULT_PRESET);
  const resolved = { status: DEFAULT_STATUS, ...base };
  for (const knob of MODE_KNOBS) {
    const mode = normalizeMode(knob, modes?.[knob]);
    if (mode) resolved[knob] = mode;
  }
  return resolved;
}

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// A missing config file is the normal first run: fall back to the built-in preset, then to the
// pre-2.0 per-app file, which stored bare `{caveman, rtk, ponytail}` keys.
function readStored() {
  const stored = readJson(CONFIG_FILE);
  if (stored) return stored;
  const legacy = readJson(LEGACY_DEFAULTS_FILE);
  if (!legacy) return {};
  const modes = {};
  for (const knob of MODE_KNOBS) {
    const mode = normalizeMode(knob, legacy[knob]);
    if (mode) modes[knob] = mode;
  }
  return { modes };
}

// A stored value must keep the shape of its default. `typeof` alone is enough for scalars but calls
// both an array and a plain object "object", which let `{"git log": true}` in where a list of
// strings belongs — and the consumer then called `.some` on an object.
function matchesShape(expected, value) {
  if (Array.isArray(expected)) return Array.isArray(value);
  return !Array.isArray(value) && typeof value === typeof expected;
}

export function readOptions(stored = readStored()) {
  const options = {};
  for (const group of Object.keys(DEFAULT_OPTIONS)) {
    const merged = { ...DEFAULT_OPTIONS[group] };
    for (const [key, value] of Object.entries((stored.options || {})[group] || {})) {
      if (!owns(merged, key)) continue;
      if (!matchesShape(merged[key], value)) continue;
      // A value no verb would accept must not be obeyed either: `native.mode: "yes"` would read as
      // "not auto" to the gate while `/ts status` printed `yes` as if it were the setting.
      const allowed = OPTION_VALUES[group]?.[key];
      if (allowed && !allowed.includes(value)) continue;
      merged[key] = value;
    }
    options[group] = Object.freeze(merged);
  }
  return Object.freeze(options);
}

// Effective config: what a session with no overrides of its own runs.
export function readConfig() {
  const stored = readStored();
  const preset = normalizePreset(stored.preset) || DEFAULT_PRESET;
  const modes = resolveModes({ preset, modes: stored.modes });
  return Object.freeze({
    // Report what the stored state derives, not the stored name: per-knob defaults that spell out a
    // whole preset leave the old name behind, and `/ts default` must not print a preset a fresh
    // session would not render. Whole-state derivation already answers `custom` when nothing matches.
    preset: derivePreset(modes),
    modes: Object.freeze(modes),
    options: readOptions(stored),
  });
}

export function readDefaultModes() {
  return readConfig().modes;
}

// The context window a session's model reports, or `0` when there is none to read (an unresolved
// model). Both the native writer and the row need the same number to compare a share against a fixed
// cap, so the read lives here rather than in each caller.
export function sessionContextWindow(ctx) {
  const window = ctx?.models?.current?.()?.contextWindow;
  return typeof window === "number" && window > 0 ? window : 0;
}

// Which of the two compaction limits a session actually gets, as the pair of host keys the caller
// writes. `percent` falls back to the level's own share, `tokens` to "no cap"; the `auto` pick keeps
// the fixed cap only when it fires no later than the share does for this session's context window,
// because the host hands the cap priority the moment it is positive. With no window to compare
// against, the cap is the only limit left that can be evaluated, so it stands.
export function resolveThreshold(options, levelPercent, contextWindow) {
  const percent = options?.percent > 0 ? options.percent : levelPercent;
  const tokens = options?.tokens > 0 ? options.tokens : -1;
  if (options?.pick === "percent") return { percent, tokens: -1 };
  if (options?.pick === "auto" && tokens > 0) {
    const shareTokens = percent > 0 && contextWindow > 0 ? (percent / 100) * contextWindow : Infinity;
    if (tokens > shareTokens) return { percent, tokens: -1 };
  }
  return { percent, tokens };
}

// Patch keys: `preset` (replaces every mode), `modes` (per-knob override), `options` (global
// behaviour). Ponytail keeps its own default upstream, so the caller syncs it separately.
export function writeConfig(patch = {}) {
  // A file that exists but does not parse (a hand-edit typo, a truncated write) reads back as the
  // built-in defaults, so writing on top of it would silently replace everything it held. Refusing is
  // the only outcome that does not lose data the user can still fix by hand.
  if (fs.existsSync(CONFIG_FILE) && !readJson(CONFIG_FILE)) {
    return { config: readConfig(), error: `${CONFIG_FILE} is not valid JSON — not overwritten` };
  }
  const stored = readStored();
  const next = { version: 2 };

  const preset = normalizePreset(patch.preset) ?? normalizePreset(stored.preset) ?? DEFAULT_PRESET;
  const modes = { ...(stored.modes || {}) };
  for (const knob of MODE_KNOBS) {
    const mode = normalizeMode(knob, patch.modes?.[knob] ?? patch[knob]);
    if (mode) modes[knob] = mode;
  }

  // A preset patch is a whole-state statement about *behaviour*: dropping those overrides is what makes
  // the preset stick. The row's shape is not behaviour, so a stored preference survives it.
  if (patch.preset) {
    for (const knob of BEHAVIOUR_KNOBS) delete modes[knob];
  }
  next.preset = preset;
  if (Object.keys(modes).length) next.modes = modes;

  const options = { ...(isPlainObject(stored.options) ? stored.options : {}) };
  for (const [group, values] of Object.entries(patch.options || {})) {
    // Own-property lookup: a group named `constructor` is not one of ours, and `Object.prototype`
    // must not put a group into the file just because the name resolves to something.
    if (!owns(DEFAULT_OPTIONS, group)) continue;
    options[group] = { ...(isPlainObject(options[group]) ? options[group] : {}), ...values };
  }
  if (Object.keys(options).length) next.options = options;

  let error = null;
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    writeAtomic(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`);
    fs.rmSync(LEGACY_DEFAULTS_FILE, { force: true });
  } catch (caught) {
    error = shortError(caught);
  }
  return { config: readConfig(), error };
}

export function clearConfig() {
  let error = null;
  try {
    fs.rmSync(CONFIG_FILE, { force: true });
    fs.rmSync(LEGACY_DEFAULTS_FILE, { force: true });
  } catch (caught) {
    error = shortError(caught);
  }
  return { config: readConfig(), error };
}

// Syscall, not stack: the caller names the file it could not write, and the message stays one line.
function shortError(error) {
  return String(error?.message || error).split(",")[0];
}

// A direct `writeFileSync` onto the config truncates the user's file before it knows the write will
// fail, and a directory or read-only path throws out of the command handler. Write a sibling temp
// file and rename it over the target instead: the rename is the only step that can leave the old
// file in place, and every failure reaches the caller as a message.
function writeAtomic(file, text) {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, text, "utf8");
    fs.renameSync(temp, file);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // The half-written temp file is the lesser problem; report the write failure itself.
    }
    throw error;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Location of the ponytail plugin's own modules. OMP_PONYTAIL_PACKAGE_DIR overrides it (tests,
// non-standard plugin locations).
function ponytailPackageFile(file) {
  const dir = process.env.OMP_PONYTAIL_PACKAGE_DIR ||
    path.join(os.homedir(), ".omp", "plugins", "node_modules", "@dietrichgebert", "ponytail");
  return path.join(dir, file);
}

// The ponytail plugin owns the ponytail default (its config.json / PONYTAIL_DEFAULT_MODE), so read
// it back rather than trusting a second copy: a fresh session must never claim a ponytail level the
// plugin is not running.
function readPonytailPluginDefault() {
  try {
    return normalizeMode("ponytail", requireFromDir(ponytailPackageFile("hooks/ponytail-config.js")).getDefaultMode?.());
  } catch {
    return null;
  }
}

export function syncPonytailDefault(mode) {
  const value = normalizeMode("ponytail", mode);
  if (!value) return false;
  try {
    requireFromDir(ponytailPackageFile("hooks/ponytail-config.js")).writeDefaultMode(value);
    return true;
  } catch {
    return false;
  }
}

// --- Session state ------------------------------------------------------------------------
// One process-wide bridge, keyed by a stable Symbol so every add-on module shares one object even
// though the OMP loader imports each extension file separately.

function bridge() {
  const existing = globalThis[BRIDGE_KEY];
  if (existing?.state) return existing;
  return (globalThis[BRIDGE_KEY] = { state: defaultState(), listener: null, owner: null });
}

function defaultState() {
  const modes = readDefaultModes();
  return freezeState(modes, derivePreset(modes));
}

function freezeState(modes, preset) {
  const state = {};
  for (const knob of MODE_KNOBS) state[knob] = modes[knob];
  return Object.freeze({ preset: preset === "custom" || !preset ? derivePreset(state) : preset, ...state });
}

function publish(patch) {
  const shared = bridge();
  const next = { ...shared.state, ...patch };
  const modes = {};
  for (const knob of MODE_KNOBS) {
    modes[knob] = normalizeMode(knob, next[knob]) || shared.state[knob];
  }
  shared.state = freezeState(modes, patch?.preset);
  shared.listener?.(shared.state);
  return shared.state;
}

export function isOmpSubagentPrompt(systemPrompt) {
  const prompts = Array.isArray(systemPrompt) ? systemPrompt : [systemPrompt];
  return prompts.some((prompt) => typeof prompt === "string" && prompt.includes(OMP_SUBAGENT_MARKER));
}

export function getSharedState() {
  return bridge().state;
}

export function setSharedPreset(name) {
  const modes = presetModes(name);
  return modes ? publish({ ...modes, preset: normalizePreset(name) }) : getSharedState();
}

export function setSharedMode(name, value) {
  const mode = normalizeMode(name, value);
  return mode ? publish({ [name]: mode }) : getSharedState();
}

// The custom types that carry a statement about the level to run at; anything else in a branch
// (messages, other add-ons' entries) says nothing about this state.
const STATE_ENTRY_TYPES = Object.freeze([
  "ts-preset", "combo-level", "ts-mode", "caveman-mode", "rtk-mode", "ponytail-mode",
]);

// Fold persisted session entries back into the shared state. Legacy custom types from pre-2.0
// sessions are still honoured so an existing branch reopens at the level it was left at.
// A branch with no state entry of its own makes no claim about the level: a second session in this
// process (a subagent runner, per the docs) would otherwise re-apply the stored defaults over the
// first session's live override. Once a session owns the state, only that same id may republish —
// a caller passing no id (rtk-session, caveman-session) folds in the stored defaults and nothing of
// its own, so it is not the owner either. The session that owns entries, or the first one in, wins.
// ponytail: one live state per process; key the bridge by session id if OMP ever runs two
// interactive sessions in one process.
export function reconcileSharedEntries(entries, sessionId) {
  const list = Array.isArray(entries) ? entries : [];
  const shared = bridge();
  const ownsState = list.some((entry) => entry?.type === "custom" && STATE_ENTRY_TYPES.includes(entry.customType));
  if (!ownsState && shared.owner && shared.owner !== sessionId) return shared.state;
  // Ownership is recorded only when the caller can be named: an id-less caller (rtk-session,
  // caveman-session) folding in the same entries must not hand the live state back to no one.
  if (sessionId && (ownsState || !shared.owner)) shared.owner = sessionId;

  const config = readConfig();
  const modes = { ...config.modes };
  // The ponytail plugin's own default outranks our stored mirror; explicit entries below win over both.
  const pluginDefault = readPonytailPluginDefault();
  if (pluginDefault) modes.ponytail = pluginDefault;
  let preset = null;
  if (list.length) {
    for (const entry of list) {
      if (entry?.type !== "custom") continue;
      if (entry.customType === "ts-preset" || entry.customType === "combo-level") {
        const named = presetModes(entry?.data?.preset ?? entry?.data?.level);
        if (named) {
          Object.assign(modes, named);
          preset = derivePreset(modes);
        }
        continue;
      }
      const name = entry.customType === "ts-mode"
        ? entry?.data?.name
        : entry.customType === "caveman-mode"
          ? "caveman"
          : entry.customType === "rtk-mode"
            ? "rtk"
            : entry.customType === "ponytail-mode"
              ? "ponytail"
              : null;
      if (!owns(KNOBS, name)) continue;
      const raw = entry.customType === "ts-mode" ? entry?.data?.value : entry?.data?.mode ?? entry?.data?.enabled;
      const mode = normalizeMode(name, raw);
      if (!mode) continue;
      modes[name] = mode;
      preset = null;
    }
  }
  return publish({ ...modes, preset });
}

export function setSharedListener(listener) {
  const shared = bridge();
  shared.listener = typeof listener === "function" ? listener : null;
  return () => {
    if (shared.listener === listener) shared.listener = null;
  };
}
