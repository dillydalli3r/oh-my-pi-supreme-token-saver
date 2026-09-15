import { MODE_KNOBS, getSharedState, isOmpSubagentPrompt, reconcileSharedEntries } from "./session-state.js";

const MARKER = "SUPREME TOKEN SAVER MODES ACTIVE";

// `status` only picks the footer row's shape, `headroom` is provider plumbing, and `threshold` is a
// host-side compaction timing setting — none of the three changes what the model is told to do, so
// including them would keep the line alive with nothing to act on.
const REINFORCED_KNOBS = Object.freeze(
  MODE_KNOBS.filter((name) => name !== "status" && name !== "headroom" && name !== "threshold")
);

const PHRASES = Object.freeze({
  caveman: "concise Caveman prose",
  rtk: "RTK for eligible noisy shell output",
  ponytail: "the smallest correct Ponytail solution",
  read: "outline-first reads",
  compress: "compressed tool output",
  prune: "pruned stale tool output",
  autoRtk: "automatic RTK wrapping",
});

function entriesFrom(ctx) {
  return ctx?.sessionManager?.getBranch?.() || ctx?.sessionManager?.getEntries?.() || [];
}

// Folding the branch back in reads two config files synchronously, and this handler runs before every
// agent start. The pack's state only changes when an entry lands, so an unchanged branch cannot have
// anything new to fold: reconcile when the branch grew, and let the bridge (which every add-on writes
// directly) carry everything else.
let lastBranchKey = "";

function branchKey(entries) {
  return `${entries.length}:${entries[entries.length - 1]?.id || ""}`;
}

function instruction(state, subagent) {
  const active = REINFORCED_KNOBS.filter((name) => state[name] && state[name] !== "off");
  if (!active.length) return null;

  const header = [`preset=${String(state.preset || "custom").toUpperCase()}`];
  for (const name of active) header.push(`${name}=${state[name]}`);

  const phrases = active.map((name) => PHRASES[name]);
  const listed = phrases.length > 1 ? `${phrases.slice(0, -1).join(", ")}, and ${phrases.at(-1)}` : phrases[0];
  const tail = subagent
    ? "Do not weaken or disable a mode unless the main agent asks for it."
    : "Do not weaken or disable a mode unless the user explicitly asks.";

  return `${MARKER}: ${header.join(" · ")}. Keep these active for the entire response: ${listed}. ${tail}`;
}

export default function modeReinforcementExtension(pi) {
  pi.setLabel?.("Supreme Token Saver mode reinforcement");

  pi.on("before_agent_start", async (event, ctx) => {
    // No `ctx.hasUI` guard: this handler only appends to the model-facing prompt and never touches
    // the UI, and headless/print/subagent runs report hasUI === false — exactly the runs that most
    // need the modes restated after a compaction.
    const base = [].concat(event.systemPrompt ?? []);
    if (base.some((prompt) => typeof prompt === "string" && prompt.includes(MARKER))) return;

    const entries = entriesFrom(ctx);
    const key = branchKey(entries);
    if (key !== lastBranchKey) {
      lastBranchKey = key;
      reconcileSharedEntries(entries, ctx?.sessionManager?.getSessionId?.());
    }
    // One line per mode set, byte-stable for a given set: re-asserting it after a compaction (or on
    // any later turn) appends the same bytes, so it never invalidates the cached prompt prefix.
    const text = instruction(getSharedState(), isOmpSubagentPrompt(base));
    if (!text) return;
    return { systemPrompt: [...base, text] };
  });
}
