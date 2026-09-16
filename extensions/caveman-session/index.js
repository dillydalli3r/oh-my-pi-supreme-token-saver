import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  foreignLevels,
  getSharedState,
  isOmpSubagentPrompt,
  normalizeMode,
  readDefaultModes,
  reconcileSharedEntries,
  setSharedMode,
} from "../shared/session-state.js";

const CAVERN_DIR = dirname(fileURLToPath(import.meta.url));

// The rule this pack injects for `full`, byte-identical to the rule.md it ships. The installer may
// overwrite rule.md with the upstream caveman text on the way in (install-omp-addons.js fetches it
// from raw.githubusercontent.com), so this copy is the one text no install can change.
const BUNDLED_RULE = `Respond terse like smart caveman. All technical substance stay. Only fluff die.

Rules:
- Drop: articles (a/an/the), filler (just/really/basically), pleasantries, hedging
- Fragments OK. Short synonyms. Technical terms exact. Code unchanged.
- Pattern: [thing] [action] [reason]. [next step].
- Not: "Sure! I'd be happy to help you with that."
- Yes: "Bug in auth middleware. Fix:"

Switch level: /caveman off|lite|full|ultra|wenyan
Stop: "stop caveman" or "normal mode"

Auto-Clarity: drop caveman for security warnings, irreversible actions, user confused. Resume after.

Boundaries: code/commits/PRs written normal.
`;

// Invariant: the injected rule may only name levels `/caveman` accepts (`KNOBS.caveman`, checked by the
// shared `foreignLevels`). The text the installer fetches upstream advertises
// `wenyan-lite|wenyan-full|wenyan-ultra` — three values this pack rejects — so which text a session got
// used to depend on whether that install had network. A rule.md that names a foreign level is therefore
// not served: the bundled copy is, which makes the online and offline installs inject identical text.
// (`OMP_CAVEMAN_RULE` points the read elsewhere.)
function rulePath() {
  return process.env.OMP_CAVEMAN_RULE || join(CAVERN_DIR, "rule.md");
}

// ponytail: read plus token scan over a ~600-byte file on each full-mode injection; upgrade path — cache
// the text and its verdict, invalidate on mtime.
function readFullRule() {
  let text = null;
  try { text = readFileSync(rulePath(), "utf8"); } catch { text = null; }
  return text && foreignLevels(text).length === 0 ? text : BUNDLED_RULE;
}

const INSTRUCTIONS = {
  lite: `Caveman lite active for this session.
Respond concise. Drop pleasantries, filler, and hedging. Keep complete technical substance. Code, commands, paths, errors, commits, and PR text stay normal/exact.`,
  full: () => `Caveman full active for this session.\n${readFullRule()}`,
  ultra: `Caveman ultra active for this session.
Maximum terse prose. Fragments preferred. No pleasantries, no tour, no recap unless needed. Keep all technical substance exact. Code, commands, commits, PR text, paths, and errors stay normal/exact. Drop caveman for security warnings, irreversible actions, or user confusion.`,
  wenyan: `Caveman wenyan active for this session.
Use ultra-terse classical-Chinese-style prose only where it preserves clarity for the user. Keep technical terms, code, commands, commits, PR text, paths, and errors exact. If clarity would suffer, use caveman full instead.`,
};

function normalize(value) {
  return normalizeMode("caveman", value);
}

function defaultMode() {
  return normalize(readDefaultModes().caveman) || "off";
}

function instructionFor(mode) {
  const block = INSTRUCTIONS[mode];
  return typeof block === "function" ? block() : block;
}

function isOffCommand(text) {
  const t = String(text || "").trim().toLowerCase().replace(/[.!?\s]+$/, "");
  return t === "stop caveman" || t === "normal mode" || t === "caveman off";
}

export default function cavemanSessionExtension(pi) {
  let currentMode = defaultMode();

  function setMode(mode, ctx) {
    const normalized = normalize(mode);
    if (!normalized) return false;
    currentMode = normalized;
    pi.appendEntry("caveman-mode", { mode: normalized });
    setSharedMode("caveman", normalized);
    ctx?.ui?.notify?.(`Caveman mode ${normalized === "off" ? "off" : `set to ${normalized}`}.`, "info");
    return true;
  }

  pi.setLabel?.("Caveman session toggle");

  pi.registerCommand("caveman", {
    description: "Toggle terse caveman replies for this session",
    handler: async (args, ctx) => {
      const arg = String(args || "").trim().toLowerCase();
      if (!arg || arg === "on") {
        setMode("full", ctx);
        return;
      }
      if (arg === "status") {
        const fallback = defaultMode();
        const suffix = fallback === currentMode ? "" : ` · default ${fallback}`;
        ctx?.ui?.notify?.(`Caveman: ${currentMode}${suffix}`, "info");
        return;
      }
      if (!setMode(arg, ctx)) {
        ctx?.ui?.notify?.("Usage: /caveman [lite|full|ultra|wenyan|off|status]", "warning");
      }
    },
  });

  pi.on("input", async (event) => {
    if (event?.source === "extension") return;
    if (currentMode !== "off" && isOffCommand(event?.text)) setMode("off");
  });

  // No startup notify: the footer row reports caveman:<MODE>.
  function restoreMode(ctx) {
    const entries = ctx?.sessionManager?.getBranch?.() || ctx?.sessionManager?.getEntries?.() || [];
    currentMode = normalize(reconcileSharedEntries(entries).caveman) || defaultMode();
  }

  pi.on("session_start", async (_event, ctx) => {
    restoreMode(ctx);
  });

  pi.on("session_branch", async (_event, ctx) => {
    restoreMode(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    restoreMode(ctx);
  });

  pi.on("agent_start", async () => {
    // token-saver's own `agent_start` handler publishes the same state; only speak up when this
    // add-on's knob would actually change, so one turn does not freeze and redraw the row twice.
    if (getSharedState().caveman !== currentMode) setSharedMode("caveman", currentMode);
  });

  pi.on("before_agent_start", async (event) => {
    const mode = isOmpSubagentPrompt(event.systemPrompt) ? getSharedState().caveman : currentMode;
    if (!mode || mode === "off") return;
    const instruction = instructionFor(mode);
    const base = Array.isArray(event.systemPrompt) ? event.systemPrompt : [event.systemPrompt];
    if (base.some((prompt) => typeof prompt === "string" && prompt.includes(instruction))) return;
    return { systemPrompt: [...base, instruction] };
  });
}
