// One status key => one footer row for every Supreme Token Saver add-on:
//   🧩 MAX · 🦴 caveman: ULTRA · 🦀 rtk: ON · 🐴 ponytail: ULTRA · 📖 read: FULL · 🗜️ compress: FULL · 🧹 prune: FULL · ⏱️ threshold: FULL · 🔁 auto: ON
//
// Every add-on publishes into the shared state in ./session-state.js; this module is the only writer
// of extension status, so a knob's symbol never depends on how the value was set (/ts, a per-app
// command, or the session default). Rendering is display-only: nothing here changes a mode.

import { MODE_KNOBS } from "./session-state.js";

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

const PRESET_MARKER = "🧩";
// The row's knob set comes from the knob table, not from this file's marker map: a knob added there
// must appear on the row (with its name, at worst) rather than be silently missing from every shape.
// `status` is the knob that picks the shape, so it is the one entry the row cannot contain.
const KNOB_ORDER = Object.freeze(MODE_KNOBS.filter((name) => name !== "status"));

// `on`/`off` stay words; a mode name shortens to its first letter in the compact row.
function knobValue(value) {
  return String(value || "off").toUpperCase();
}

// A knob whose values are `on`/`off` keeps the word even in the compact row: both start with "O", so a
// single letter would not say which one is set.
function compactValue(name, value) {
  const text = knobValue(value);
  return name === "rtk" || name === "autoRtk" || name === "headroom" ? text : text.slice(0, 1);
}

// `autoRtk` is the knob's name; `auto` is the word for it on the row.
function label(name) {
  return name === "autoRtk" ? "auto" : name;
}

// A knob's marker, or nothing when the table grew and this map has not: the name still renders, so a
// missing glyph degrades the row instead of dropping a knob from it.
function marker(name) {
  return KNOB_MARKERS[name] || "";
}

// The `status` knob picks the row's shape, and the four shapes exist because a footer can be too
// narrow for the eight segments: `full` names every tool beside its icon, `names` drops the icons and
// spells the tools out, `compact` keeps the icons and shortens each value to a letter, and `preset`
// drops the tools entirely for one word — the preset is what determines all eight anyway.
function statusText(state) {
  if (!state || state.status === "off") return "";
  const style = state.status;
  const preset = `${PRESET_MARKER} ${String(state.preset || "custom").toUpperCase()}`;
  if (style === "preset") return preset;

  const parts = [preset];
  for (const name of KNOB_ORDER) {
    const value = knobValue(state[name]);
    const glyph = marker(name);
    if (style === "compact") parts.push(`${glyph}${compactValue(name, state[name])}`);
    else if (style === "names") parts.push(`${label(name)}: ${value}`);
    else parts.push(`${glyph ? `${glyph} ` : ""}${label(name)}: ${value}`);
  }
  return parts.join(" · ");
}

// What each `status` level renders, for the menu that offers them: a bare level name does not say
// what the row will look like, and this is the only knob whose values are shapes rather than levels.
export const STATUS_LEVELS = Object.freeze({
  off: "no row at all",
  preset: "one word — just the preset",
  compact: "icons and one letter per knob",
  names: "every tool spelled out, no icons",
  full: "icon, tool name and value for each knob",
});

// What the row *would* say under a given shape, for the menu that offers the shapes: the preview runs
// the real renderer over a copy of the state, so it can never drift from what gets written.
export function previewRow(state, style) {
  return statusText({ ...state, status: style });
}

export function renderModes(state, ctx) {
  const ui = ctx?.ui;
  if (!ui?.setStatus) return "";
  const text = statusText(state);
  // An empty string is still a status: omp renders one row per status, so `""` would leave a blank
  // footer row where the combo row used to be. `undefined` deletes the key and the row with it.
  ui.setStatus(STATUS_KEY, text || undefined);
  return text;
}
