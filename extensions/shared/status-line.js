// One status key => one footer row for every Supreme Token Saver add-on:
//   🧩 MAX · caveman ultra · rtk on · … · threshold full (70%) · headroom off
//
// Every add-on publishes into the shared state in ./session-state.js; this module is the only writer
// of extension status, so a knob's symbol never depends on how the value was set (/ts, a per-app
// command, or the session default). Rendering is display-only: nothing here changes a mode.
//
// The row is a footer, so it has two shapes for two footers. `names` (the default) spells every knob
// out — its real name and its level, the words `/ts set` takes — and `full` pays one icon and one
// letter per knob instead, grouping by the layer each knob configures (the prompt add-ons, the four
// OMP settings, the extras) with those groups as what the ` · ` separators divide. `/ts status` prints
// every knob in full whichever shape the row is on.

import { MODE_KNOBS, THRESHOLD_PERCENT, readOptions, resolveThreshold, sessionContextWindow } from "./session-state.js";

const STATUS_KEY = "modes";

const KNOB_MARKERS = Object.freeze({
  caveman: "🦴",
  rtk: "🦀",
  ponytail: "🐴",
  read: "📖",
  compress: "🗜️",
  prune: "🧹",
  threshold: "⏱️",
  autoRtk: "🔁",
  headroom: "🔀",
});

// Which layer a knob configures, so the row can group by layer instead of running nine segments
// together: 0 = the prompt-level add-ons, 1 = the OMP settings the knobs select, 2 = the extras.
const KNOB_FAMILY = Object.freeze({
  caveman: 0,
  rtk: 0,
  autoRtk: 0,
  ponytail: 0,
  read: 1,
  compress: 1,
  prune: 1,
  threshold: 1,
  headroom: 2,
});

const PRESET_MARKER = "🧩";
// The row's knob set comes from the knob table, not from this file's marker map: a knob added there
// must appear on the row (by name, at worst) rather than be silently missing from every shape.
// `status` is the knob that picks the shape, so it is the one entry the row cannot contain.
const KNOB_ORDER = Object.freeze(MODE_KNOBS.filter((name) => name !== "status"));

// A knob whose family this map has not learned (the table grew) gets a group of its own at the end
// rather than being dropped: a missing group is a layout regression, a missing knob is a lie.
const KNOB_GROUPS = Object.freeze(buildGroups());

function buildGroups() {
  const groups = [];
  const unplaced = [];
  for (const name of KNOB_ORDER) {
    const family = KNOB_FAMILY[name];
    if (family === undefined) unplaced.push(name);
    else (groups[family] ||= []).push(name);
  }
  return [...groups.filter(Boolean), unplaced].filter((group) => group.length);
}

// A knob whose values are `on`/`off` keeps the word: both start with "O", so one letter would not say
// which one is set.
const ON_OFF = Object.freeze(["rtk", "autoRtk", "headroom"]);

// The number in a `threshold` token's place: the limit the pack actually writes, resolved by the
// same function the native writer uses, so the row can never claim a limit the `compaction.*` keys
// disagree with. The level's share lives in session-state.js (one copy, two readers); a pinned share
// or cap (`options.threshold`) outranks it, and `auto` shows whichever one fires first. `off` leaves
// the host's reserve — `res` says so rather than inventing a number for it.
function thresholdNote(level, ctx, spelled = false) {
  const limits = resolveThreshold(readOptions().threshold, THRESHOLD_PERCENT[level] ?? -1, sessionContextWindow(ctx));
  if (limits.tokens > 0) return limits.tokens >= 1000 ? `${Math.round(limits.tokens / 1000)}k` : String(limits.tokens);
  return limits.percent > 0 ? `${limits.percent}%` : spelled ? "reserve" : "res";
}

function knobValue(value) {
  return String(value || "off").toUpperCase();
}

// A knob's marker, or nothing when the marker map has not learned it: the token falls back to the
// knob's name, so a missing glyph degrades the row instead of dropping a knob from it.
function marker(name) {
  return KNOB_MARKERS[name] || "";
}

// One knob, one token. An `on`/`off` knob spells the word; a level knob shortens to its first letter
// (the levels are listed in KNOBS and in `/ts status`); `threshold` shows the number instead of the
// letter, because the letter is only a stand-in for that number and the footer has room for exactly
// one of them.
function shortToken(name, value, ctx) {
  const body = ON_OFF.includes(name)
    ? knobValue(value)
    : name === "threshold"
      ? thresholdNote(value, ctx)
      : knobValue(value).slice(0, 1);
  const glyph = marker(name);
  return glyph ? `${glyph}${body}` : `${name} ${body}`;
}

// The spelled shape: the knob's real name (`autoRtk`, the name `/ts set` takes — not a second word
// for it) and its level in the lowercase the commands use, so the row and the vocabulary are one
// vocabulary. `threshold` carries the share too: the level word does not say the number, and this is
// the shape with room for both.
function longToken(name, value, ctx) {
  const share = name === "threshold" ? thresholdNote(value, ctx, true) : "";
  return `${name} ${String(value || "off")}${share ? ` (${share})` : ""}`;
}

// The `status` knob picks the row's shape, and the shapes exist because a footer can be too narrow
// for nine knobs: `full` gives each knob one icon and one value and groups them by layer, `names`
// spells the same nine out for when a letter would not be clear, and `preset` drops the knobs for one
// word — the preset is what determines all nine anyway.
function statusText(state, ctx) {
  if (!state || state.status === "off") return "";
  const style = state.status;
  const preset = `${PRESET_MARKER} ${String(state.preset || "custom").toUpperCase()}`;
  if (style === "preset") return preset;
  if (style === "names") {
    return [preset, ...KNOB_ORDER.map((name) => longToken(name, state[name], ctx))].join(" · ");
  }
  const groups = KNOB_GROUPS.map((group) => group.map((name) => shortToken(name, state[name], ctx)).join(" "));
  return [preset, ...groups].join(" · ");
}

// What each `status` level renders, for the menu that offers them: a bare level name does not say
// what the row will look like, and this is the only knob whose values are shapes rather than levels.
export const STATUS_LEVELS = Object.freeze({
  off: "no row at all",
  preset: "one word — just the preset",
  names: "every knob spelled out: its name and its level, no icons",
  full: "one icon and one short value per knob, grouped by layer",
});

// What the row *would* say under a given shape, for the menu that offers the shapes: the preview runs
// the real renderer over a copy of the state, so it can never drift from what gets written.
export function previewRow(state, style, ctx) {
  return statusText({ ...state, status: style }, ctx);
}

export function renderModes(state, ctx) {
  const ui = ctx?.ui;
  if (!ui?.setStatus) return "";
  const text = statusText(state, ctx);
  // An empty string is still a status: omp renders one row per status, so `""` would leave a blank
  // footer row where the combo row used to be. `undefined` deletes the key and the row with it.
  ui.setStatus(STATUS_KEY, text || undefined);
  return text;
}
