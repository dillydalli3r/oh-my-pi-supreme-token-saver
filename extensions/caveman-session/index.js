import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  getSharedState,
  isOmpSubagentPrompt,
  normalizeMode,
  readDefaultModes,
  reconcileSharedEntries,
  setSharedMode,
} from "../shared/session-state.js";

const CAVERN_DIR = dirname(fileURLToPath(import.meta.url));
const RULE_PATH = join(CAVERN_DIR, "rule.md");

const FALLBACK_FULL_RULE = `Respond terse like smart caveman. All technical substance stay. Only fluff die.

Rules:
- Drop articles (a/an/the), filler (just/really/basically), pleasantries, hedging.
- Fragments OK. Short synonyms. Technical terms exact. Code unchanged.
- Pattern: [thing] [action] [reason]. [next step].
- Not: "Sure! I'd be happy to help you with that."
- Yes: "Bug in auth middleware. Fix:"

Auto-clarity: drop caveman for security warnings, irreversible actions, or when user seems confused. Resume after.`;

// ponytail: synchronous read each full-mode injection; ceiling = small file, cold session start. Upgrade path: cache file contents + mtime, invalidate on change.
function readFullRule() {
  try { return readFileSync(RULE_PATH, "utf8"); } catch { return FALLBACK_FULL_RULE; }
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
    setSharedMode("caveman", currentMode);
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
