// /combo session toggle — set all three (caveman, rtk, ponytail) at once.
// Modes: off | medium | max

import { createRequire } from "node:module";
import {
  COMBO_DEFAULTS_FILE,
  COMBO_LEVELS,
  clearComboDefaults,
  getSharedComboState,
  isOmpSubagentPrompt,
  normalizeComboLevel,
  ponytailPackageFile,
  readComboDefaults,
  reconcileSharedComboEntries,
  setSharedComboLevel,
  setSharedComboListener,
  writeComboDefaults,
} from "../shared/session-state.js";
import { renderModes } from "../shared/status-line.js";

const require = createRequire(import.meta.url);

function ponytailFallback(mode) {
  const intensity = mode === "lite"
    ? "Prefer the simplest correct solution."
    : mode === "review"
      ? "Review only for avoidable complexity; recommend the smallest correct replacement."
      : "Use the minimum correct solution. Delete or reuse before adding.";
  return `PONYTAIL MODE ACTIVE — level: ${mode}\n${intensity} Understand the path first and fix root causes, not symptoms. Prefer the standard library and YAGNI. Avoid speculative abstractions and dependencies. Preserve correctness. Verify changed behavior.`;
}

function entriesFrom(ctx) {
  return ctx?.sessionManager?.getBranch?.() || ctx?.sessionManager?.getEntries?.() || [];
}

function levelSummary(state) {
  return `caveman=${state.caveman} rtk=${state.rtk} ponytail=${state.ponytail}`;
}

// `/combo default` accepts a preset or per-app pairs. `review` is not a ponytail default upstream
// (#377), so it is rejected here too.
const DEFAULT_APP_MODES = {
  caveman: new Set(["off", "lite", "full", "ultra", "wenyan"]),
  rtk: new Set(["off", "on"]),
  ponytail: new Set(["off", "lite", "full", "ultra"]),
};

function parseDefaultModes(text) {
  const modes = {};
  for (const token of String(text).split(/[\s,]+/).filter(Boolean)) {
    const [rawName, rawMode] = token.split("=");
    const app = String(rawName || "").trim().toLowerCase();
    const mode = String(rawMode || "").trim().toLowerCase();
    if (!DEFAULT_APP_MODES[app]?.has(mode)) return null;
    modes[app] = mode;
  }
  return Object.keys(modes).length ? modes : null;
}

const DEFAULT_USAGE = [
  "Usage: /combo default [off|medium|max | app=mode ... | reset]",
  "  /combo default                     show what new sessions start from",
  "  /combo default medium              new sessions start at medium",
  "  /combo default caveman=lite rtk=off ponytail=full",
  "  /combo default reset               drop the override (back to max)",
].join("\n");

function hasPonytailInstructions(systemPrompt) {
  const prompts = Array.isArray(systemPrompt) ? systemPrompt : [systemPrompt];
  return prompts.some((prompt) => typeof prompt === "string" && prompt.includes("PONYTAIL MODE ACTIVE"));
}

function loadPonytailInstructions(mode) {
  try {
    const { getPonytailInstructions } = require(ponytailPackageFile("hooks/ponytail-instructions.js"));
    if (typeof getPonytailInstructions === "function") return getPonytailInstructions(mode);
  } catch {}
  return ponytailFallback(mode);
}

// Ponytail's plugin owns the ponytail default, so `/combo default` writes through its own API
// instead of a second config file. Returns false when the plugin is missing (skill-only install).
function syncPonytailDefault(mode) {
  try {
    require(ponytailPackageFile("hooks/ponytail-config.js")).writeDefaultMode(mode);
    return true;
  } catch {
    return false;
  }
}

export default function comboToggleExtension(pi) {
  pi.setLabel?.("Combo session toggle (all 3 add-ons)");

  let currentState = getSharedComboState();
  let lastCtx = null;
  let watchTimer = null;

  function syncStatus(ctx) {
    if (ctx) lastCtx = ctx;
    const c = ctx || lastCtx;
    // One row for all three add-ons; the per-app symbols come from shared state, not from the invocation path.
    renderModes(currentState, c);
  }

  // The ponytail plugin is a separate dependency: it appends `ponytail-mode` entries from its own
  // commands without telling us. Watch the branch so the unified row tracks it.
  // ponytail: 1s poll, fine for an interactive session; switch to an event if omp ever emits a command-completed hook.
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

  function branchKey(ctx) {
    const entries = entriesFrom(ctx);
    return `${entries.length}:${entries.at(-1)?.id || ""}`;
  }

  function useState(state, ctx) {
    currentState = state;
    syncStatus(ctx);
    return state;
  }

  function reconcile(ctx) {
    if (!ctx?.hasUI) return currentState;
    return useState(reconcileSharedComboEntries(entriesFrom(ctx)), ctx);
  }
  function listen(ctx) {
    if (ctx?.hasUI) setSharedComboListener((state) => useState(state));
  }

  // Persisted defaults only steer sessions that start without combo entries; the running session is
  // left alone so a user can keep an exception session without losing their default.
  function applyDefault(arg, ctx) {
    if (!arg) {
      const defaults = readComboDefaults();
      ctx?.ui?.notify?.(
        `Combo default for new sessions: ${defaults.level.toUpperCase()} (${levelSummary(defaults)})\n` +
        `File: ${COMBO_DEFAULTS_FILE}\n${DEFAULT_USAGE}`,
        "info"
      );
      return;
    }

    if (arg === "reset") {
      clearComboDefaults();
      syncPonytailDefault(COMBO_LEVELS.max.ponytail);
      const defaults = readComboDefaults();
      ctx?.ui?.notify?.(
        `Combo default reset to ${defaults.level.toUpperCase()} (${levelSummary(defaults)}) for new sessions.`,
        "info"
      );
      return;
    }

    const level = normalizeComboLevel(arg);
    const modes = level ? COMBO_LEVELS[level] : parseDefaultModes(arg);
    if (!modes) {
      ctx?.ui?.notify?.(DEFAULT_USAGE, "warning");
      return;
    }

    writeComboDefaults(modes);
    // Push ponytail only when this call set it: a caveman/rtk-only default must not overwrite a
    // ponytail default the user chose with /ponytail default.
    const synced = modes.ponytail === undefined || syncPonytailDefault(modes.ponytail);
    const defaults = readComboDefaults();
    ctx?.ui?.notify?.(
      `Combo default for new sessions: ${defaults.level.toUpperCase()} (${levelSummary(defaults)})` +
      `${synced ? "" : "\n[pending] Ponytail plugin not found — its own default was not synced."}\n` +
      "Current session unchanged; /combo off|medium|max applies a level now.",
      "info"
    );
  }


  pi.registerCommand("combo", {
    description: "Toggle all 3 OMP add-ons at once. Usage: /combo <off|medium|max|status|default>",
    handler: async (args, ctx) => {
      listen(ctx);
      const arg = String(args || "").trim().toLowerCase();

      if (!arg || arg === "status") {
        const state = reconcile(ctx);
        ctx?.ui?.notify?.(
          `Combo: ${state.level.toUpperCase()} (${levelSummary(state)})` +
          ` · default for new sessions: ${readComboDefaults().level.toUpperCase()}`,
          "info"
        );
        return;
      }

      if (arg === "help") {
        ctx?.ui?.notify?.(
          "/combo off      — disables all 3 (caveman, rtk, ponytail)\n" +
          "/combo medium   — light: caveman=lite, rtk=on, ponytail=lite\n" +
          "/combo max      — aggressive: caveman=ultra, rtk=on, ponytail=ultra\n" +
          "/combo default  — change the level new sessions start from\n" +
          "/combo status   — show the current level and the default",
          "info"
        );
        return;
      }

      if (arg === "default" || arg.startsWith("default ")) {
        applyDefault(arg.slice("default".length).trim(), ctx);
        return;
      }

      const level = normalizeComboLevel(arg);
      if (!level) {
        ctx?.ui?.notify?.(
          `Unknown combo level: ${arg}. Use: off | medium | max, or /combo default ...`,
          "warning"
        );
        return;
      }

      const modes = COMBO_LEVELS[level];

      // Persist per-extension state so they restore on session_start
      pi.appendEntry("caveman-mode", { mode: modes.caveman });
      pi.appendEntry("rtk-mode", { enabled: modes.rtk === "on" });
      pi.appendEntry("ponytail-mode", { mode: modes.ponytail });
      pi.appendEntry("combo-level", { level });

      useState(setSharedComboLevel(level), ctx);

      ctx?.ui?.notify?.(
        `Combo ${level} applied: ${levelSummary(currentState)}`,
        "info"
      );

      if (ctx?.reload) await ctx.reload();
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    listen(ctx);
    watchBranch(ctx);
    if (ctx?.hasUI) reconcile(ctx);
    else syncStatus(ctx);
  });

  pi.on("session_branch", async (_event, ctx) => {
    listen(ctx);
    watchBranch(ctx);
    if (ctx?.hasUI) reconcile(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    listen(ctx);
    watchBranch(ctx);
    if (ctx?.hasUI) reconcile(ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    listen(ctx);
    if (ctx?.hasUI) reconcile(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (ctx?.hasUI) reconcile(ctx);
    if (!isOmpSubagentPrompt(event.systemPrompt)) return;

    const mode = getSharedComboState().ponytail;
    if (mode === "off" || hasPonytailInstructions(event.systemPrompt)) return;
    const base = Array.isArray(event.systemPrompt) ? event.systemPrompt : [event.systemPrompt];
    return { systemPrompt: [...base, loadPonytailInstructions(mode)] };
  });

  // Slash commands only; natural-language input caused accidental toggles and has no reload context.
}