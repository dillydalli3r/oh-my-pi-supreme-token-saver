import os from "node:os";
import path from "node:path";
import {
  getSharedState,
  isOmpSubagentPrompt,
  readConfig,
  reconcileSharedEntries,
  setSharedMode,
} from "../shared/session-state.js";

const IS_WINDOWS = process.platform === "win32";
const HOME = os.homedir();
const RTK_BINARY = path.join(HOME, ".bun", "bin", IS_WINDOWS ? "rtk.exe" : "rtk");

const ON_VALUES = new Set(["on", "enable", "enabled", "true"]);
const OFF_VALUES = new Set(["off", "disable", "disabled", "false"]);

// RTK refuses shell pipelines and substitutions anyway; skipping them here saves a subprocess.
const SHELL_SYNTAX = /[|;`]|\$\(|&&/;
const ALREADY_RTK = /^rtk\s/;

const REWRITE_CACHE_MAX = 200;
const REWRITE_CACHE = new Map();

const RTK_EVIDENCE = "RTK's savings numbers are self-reported by the CLI and not independently verified.";

const RTK_PROMPT = `RTK mode active for this session.
Use Rust Token Killer for shell output that would otherwise be noisy. Prefer explicit RTK commands in bash: \`rtk git status\`, \`rtk git log\`, \`rtk git diff\`, \`rtk read <file>\` (\`rtk read -l aggressive <file>\` for signatures only), \`rtk smart <file>\`, \`rtk grep <pattern> <path>\` or \`rtk rg\`, \`rtk find <glob> <path>\`, \`rtk test <cmd...>\`, \`rtk err <cmd...>\`, \`rtk tsc\`, \`rtk lint\`, \`rtk json --keys-only\`, and \`rtk gain\` for RTK's own counters.
Do not use RTK when the exact raw output matters, when a specialized OMP tool is required by system policy, or when the command changes state — those keep their raw form and their confirmation output. Specialized OMP tools still win: read/glob/grep/edit/lsp stay preferred over shell equivalents.`;

function branchEntries(ctx) {
  return ctx?.sessionManager?.getBranch?.() || [];
}

function cacheSet(command, value) {
  if (REWRITE_CACHE.size >= REWRITE_CACHE_MAX) {
    REWRITE_CACHE.delete(REWRITE_CACHE.keys().next().value);
  }
  REWRITE_CACHE.set(command, value);
}

export default function rtkSessionExtension(pi) {
  const { z } = pi.zod;
  const initial = readConfig();
  let rtk = initial.modes.rtk === "on";
  let autoRtk = initial.modes.autoRtk === "on";
  let options = initial.options;

  pi.setLabel?.("RTK session toggle");

  function setRtk(next, ctx) {
    rtk = Boolean(next);
    // The pre-2.0 entry stays in sync so a session reopened by an older build still sees the toggle.
    pi.appendEntry("ts-mode", { name: "rtk", value: rtk ? "on" : "off" });
    pi.appendEntry("rtk-mode", { enabled: rtk });
    setSharedMode("rtk", rtk ? "on" : "off");
    ctx?.ui?.notify?.(`RTK mode ${rtk ? "on" : "off"}.`, "info");
  }

  function setAutoRtk(next, ctx) {
    autoRtk = Boolean(next);
    pi.appendEntry("ts-mode", { name: "autoRtk", value: autoRtk ? "on" : "off" });
    setSharedMode("autoRtk", autoRtk ? "on" : "off");
    ctx?.ui?.notify?.(`RTK auto-rewrite ${autoRtk ? "on" : "off"}.`, "info");
  }

  // Every candidate goes through here, including the ones we refuse; a refused command is cached so
  // a retry costs a Map lookup instead of a second subprocess.
  function isRewriteCandidate(command, trimmed) {
    if (!trimmed || ALREADY_RTK.test(trimmed)) return false;
    if (SHELL_SYNTAX.test(command)) return false;
    const exclude = options.autoRtk.exclude || [];
    return !exclude.some((entry) => typeof entry === "string" && entry && command.includes(entry));
  }

  async function rewrite(command) {
    if (!isRewriteCandidate(command, command.trim())) return null;
    if (REWRITE_CACHE.has(command)) return REWRITE_CACHE.get(command);
    let rewritten = null;
    try {
      const result = await pi.exec(RTK_BINARY, ["rewrite", command], { timeout: options.autoRtk.timeoutMs });
      const text = String(result?.stdout || "").trim();
      // Exit 3 is RTK's "rewrote, but not cleanly" code; both mean the rewrite is usable.
      if ((result?.code === 0 || result?.code === 3) && text && text !== command) rewritten = text;
    } catch {
      // Missing binary, timeout, or a non-zero spawn: leave the command exactly as written.
      rewritten = null;
    }
    cacheSet(command, rewritten);
    return rewritten;
  }

  async function runGain(ctx) {
    let result;
    try {
      result = await pi.exec(RTK_BINARY, ["gain"], { cwd: ctx?.cwd || pi.cwd });
    } catch (error) {
      ctx?.ui?.notify?.(`rtk gain failed: ${error?.message || error}`, "warning");
      return;
    }
    const text = String(result?.stdout || "").trim().slice(0, 2000);
    if (!text) {
      ctx?.ui?.notify?.(`rtk gain exited ${result?.code} with no output.`, "warning");
      return;
    }
    ctx?.ui?.notify?.(`RTK gain — RTK's own self-reported counters, not independently verified:\n${text}`, "info");
  }

  pi.registerCommand("rtk", {
    description: "Toggle RTK compact shell-output guidance and automatic command rewriting",
    handler: async (args, ctx) => {
      const parts = String(args || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
      const head = parts[0];
      const rest = parts.slice(1).join(" ");
      if (head === "auto") {
        if (!rest || rest === "status") {
          ctx?.ui?.notify?.(`RTK auto-rewrite: ${autoRtk ? "on" : "off"}`, "info");
          return;
        }
        if (ON_VALUES.has(rest)) {
          setAutoRtk(true, ctx);
          return;
        }
        if (OFF_VALUES.has(rest)) {
          setAutoRtk(false, ctx);
          return;
        }
        ctx?.ui?.notify?.("Usage: /rtk auto [on|off|status]", "warning");
        return;
      }
      if (!head || head === "status") {
        ctx?.ui?.notify?.(`RTK: ${rtk ? "on" : "off"} · auto-rewrite: ${autoRtk ? "on" : "off"}`, "info");
        return;
      }
      if (head === "gain") {
        await runGain(ctx);
        return;
      }
      if (ON_VALUES.has(head)) {
        setRtk(true, ctx);
        return;
      }
      if (OFF_VALUES.has(head)) {
        setRtk(false, ctx);
        return;
      }
      ctx?.ui?.notify?.("Usage: /rtk [on|off|status|gain] or /rtk auto [on|off|status]", "warning");
    },
  });

  pi.registerTool({
    name: "rtk_run",
    label: "RTK Run",
    description: `Run the installed \`rtk\` binary for compact command output when the rtk knob is on. ${RTK_EVIDENCE}`,
    parameters: z.object({
      args: z.array(z.string()).min(1).describe("Arguments passed to rtk, e.g. ['git','status'] or ['read','src/index.ts']"),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!rtk) {
        return {
          isError: true,
          content: [{ type: "text", text: "RTK mode is off. Run /rtk on for this session, or use bash explicitly." }],
          details: { rtk },
        };
      }
      onUpdate?.({ content: [{ type: "text", text: `rtk ${params.args.join(" ")}` }], details: { phase: "start" } });
      const result = await pi.exec(RTK_BINARY, params.args, { signal, cwd: ctx?.cwd || pi.cwd });
      const text = [result.stdout, result.stderr].filter(Boolean).join(result.stdout && result.stderr ? "\n" : "");
      return {
        isError: result.code !== 0,
        content: [{ type: "text", text: text || `rtk exited ${result.code}` }],
        details: { code: result.code, killed: result.killed, rtk },
      };
    },
  });

  pi.on("tool_call", async (event) => {
    if (!autoRtk) return;
    if (event?.toolName !== "bash") return;
    const command = event?.input?.command;
    if (typeof command !== "string" || !command.trim()) return;
    const rewritten = await rewrite(command);
    if (!rewritten || rewritten === command) return;
    // Never mutate the caller's object: the session records the original input.
    return { input: { ...event.input, command: rewritten } };
  });

  function restore(ctx) {
    const state = reconcileSharedEntries(branchEntries(ctx));
    rtk = state.rtk === "on";
    autoRtk = state.autoRtk === "on";
    options = readConfig().options;
  }

  // No startup notify: the modes status row already reports the knobs.
  pi.on("session_start", async (_event, ctx) => {
    restore(ctx);
  });

  pi.on("session_branch", async (_event, ctx) => {
    restore(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    restore(ctx);
  });

  pi.on("before_agent_start", async (event) => {
    const active = isOmpSubagentPrompt(event.systemPrompt) ? getSharedState().rtk === "on" : rtk;
    if (!active) return;
    const base = Array.isArray(event.systemPrompt) ? event.systemPrompt : [event.systemPrompt];
    return { systemPrompt: [...base, RTK_PROMPT] };
  });
}
