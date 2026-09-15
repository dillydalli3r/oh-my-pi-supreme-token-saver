// One status key => one footer row for every Supreme Token Saver add-on:
//   🧩 MAX · 🦴 caveman: ULTRA · 🦀 rtk: ON · 🐴 ponytail: ULTRA · 📖 read: FULL · 🗜️ compress: FULL · 🧹 prune: FULL · 🔁 auto: ON · 👁 42% ctx
//
// Every add-on publishes into the shared state in ./session-state.js; this module is the only writer
// of extension status, so a knob's symbol never depends on how the value was set (/ts, a per-app
// command, or the session default). Rendering is display-only: nothing here changes a mode.

import { getSharedUsage } from "./session-state.js";

const STATUS_KEY = "modes";

const KNOB_MARKERS = Object.freeze({
  caveman: "🦴",
  rtk: "🦀",
  ponytail: "🐴",
  read: "📖",
  compress: "🗜️",
  prune: "🧹",
  autoRtk: "🔁",
});

const PRESET_MARKER = "🧩";
const METER_MARKER = "👁";
const KNOB_ORDER = Object.freeze(Object.keys(KNOB_MARKERS));

// `on`/`off` stay words; a mode name shortens to its first letter in the compact row.
function knobValue(_name, value) {
  return String(value || "off").toUpperCase();
}

function compactValue(name, value) {
  const text = knobValue(name, value);
  return name === "rtk" || name === "autoRtk" ? text : text.slice(0, 1);
}

function statusText(state, usage) {
  if (!state || state.status === "off") return "";
  const compact = state.status === "compact";
  const parts = [`${PRESET_MARKER} ${String(state.preset || "custom").toUpperCase()}`];
  for (const name of KNOB_ORDER) {
    const value = compact ? compactValue(name, state[name]) : knobValue(name, state[name]);
    parts.push(compact ? `${KNOB_MARKERS[name]}${value}` : `${KNOB_MARKERS[name]} ${name === "autoRtk" ? "auto" : name}: ${value}`);
  }
  if (usage && typeof usage.percent === "number") {
    parts.push(compact ? `${METER_MARKER}${usage.percent}%` : `${METER_MARKER} ${usage.percent}% ctx`);
  }
  return parts.join(" · ");
}

export function renderModes(state, ctx, usage = getSharedUsage()) {
  const ui = ctx?.ui;
  if (!ui?.setStatus) return "";
  const text = statusText(state, usage);
  // An empty string is still a status: omp renders one row per status, so `""` would leave a blank
  // footer row where the combo row used to be. `undefined` deletes the key and the row with it.
  ui.setStatus(STATUS_KEY, text || undefined);
  return text;
}
