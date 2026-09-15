// One status key => one TUI row for all three mode add-ons:
//   🧩 MAX · 🦴 caveman: ULTRA · 🦀 rtk: ON · 🐴 ponytail: ULTRA
// Every add-on publishes into the shared combo state; this module is the only
// writer of extension status, so the symbol per app never depends on whether the
// mode came from /combo, a per-app command, or the session default.

const STATUS_KEY = "modes";

export const MODE_MARKERS = Object.freeze({
  caveman: "🦴",
  rtk: "🦀",
  ponytail: "🐴",
});

const LEVEL_MARKER = "🧩";
const MODE_NAMES = ["caveman", "rtk", "ponytail"];

export function modeValue(name, mode) {
  if (name === "rtk") return mode === "on" ? "ON" : "OFF";
  return String(mode || "off").toUpperCase();
}

export function statusText(state) {
  if (!state || state.level === "off") return "";
  const parts = [`${LEVEL_MARKER} ${String(state.level).toUpperCase()}`];
  for (const name of MODE_NAMES) {
    parts.push(`${MODE_MARKERS[name]} ${name}: ${modeValue(name, state[name])}`);
  }
  return parts.join(" · ");
}

export function renderModes(state, ctx) {
  const ui = ctx?.ui;
  if (!ui?.setStatus) return "";
  const text = statusText(state);
  // An empty string is still a status: omp renders one row per status, so `""` leaves a blank
  // footer row where the combo row used to be. `undefined` deletes the key and the row with it.
  ui.setStatus(STATUS_KEY, text || undefined);
  return text;
}
