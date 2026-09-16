// Supreme Token Saver — the one entry point for the pack: presets, the unified status row, and the
// driver that mirrors the running state onto OMP's own native settings.
//
// The three behaviours this pack used to reimplement in JS — structural read summaries, shell-output
// compression, and cache-aware pruning of stale tool results — ship inside OMP itself and are
// configured through `config.yml`. Duplicating them as hooks would drift from the host and cost a
// round trip per call, so the `read` / `compress` / `prune` knobs *select* native settings instead
// of running code, and the preset supplies the tier dials those behaviours do not cover. `omp
// config` is the only writer of the host's settings (it validates each key against the host's
// schema).

import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CONFIG_FILE,
  DEFAULT_OPTIONS,
  DEFAULT_PRESET,
  KNOBS,
  MODE_KNOBS,
  OPTION_VALUES,
  PRESET_NAMES,
  THRESHOLD_PERCENT,
  clearConfig,
  canonicalKnob,
  getSharedState,
  nativeGapHint,
  normalizeMode,
  normalizeOptionValue,
  normalizePreset,
  presetModes,
  readConfig,
  readOptions,
  reconcileSharedEntries,
  resolveThreshold,
  sessionContextWindow,
  setSharedListener,
  setSharedMode,
  setSharedPreset,
  syncPonytailDefault,
  writeConfig,
} from "../shared/session-state.js";
import { STATUS_LEVELS, previewRow, renderModes } from "../shared/status-line.js";

const IS_WINDOWS = process.platform === "win32";
const OMP_TIMEOUT_MS = 15000;
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".omp", "agent");

// Knob level -> native OMP settings. Every key below exists in the host's settings schema
// (pi-coding-agent src/config/settings-schema.ts), and `omp config set` rejects anything that is
// not in it, which is what keeps these tables honest as OMP moves.
//   read.summarize.*                       structural summaries for selector-less reads (the `read` knob)
//   read.defaultLimit                      the size dial that behaviour reads
//   shellMinimizer.* / tools.artifact*     compress verbose shell output (the `compress` knob)
//   compaction.*                           cache-aware elision of stale results (the `prune` knob)
//   compaction.threshold*, compaction.idle*  when compaction fires (the `threshold` knob)
// One table per knob, keyed by level, because the knobs are independent: a user who sets
// compress=ultra and leaves `read` alone must get the ultra compress keys and the default read
// keys, which a single preset-keyed column cannot express. Every key is spelled exactly as the
// host's schema spells it — `tools.artifactSpillThreshold` and the `tools.artifactTail*` keys are
// scalar dotted keys, not a `tools.artifact.*` group.
const KNOB_NATIVE = Object.freeze({
  read: Object.freeze({
    off: Object.freeze({
      "read.summarize.enabled": false,
      "read.summarize.prose": false,
      "read.summarize.minTotalLines": 100,
      "read.summarize.unfoldLimit": 100,
      "read.defaultLimit": 300,
    }),
    lite: Object.freeze({
      "read.summarize.enabled": true,
      "read.summarize.prose": false,
      "read.summarize.minTotalLines": 100,
      "read.summarize.unfoldLimit": 100,
      "read.defaultLimit": 300,
    }),
    full: Object.freeze({
      "read.summarize.enabled": true,
      "read.summarize.prose": true,
      "read.summarize.minTotalLines": 60,
      "read.summarize.unfoldLimit": 60,
      "read.defaultLimit": 200,
    }),
  }),
  compress: Object.freeze({
    off: Object.freeze({
      "shellMinimizer.enabled": false,
      "shellMinimizer.sourceOutlineLevel": "default",
      "tools.artifactSpillThreshold": 50,
      "tools.artifactTailBytes": 20,
      "tools.artifactHeadBytes": 20,
      "tools.artifactTailLines": 500,
    }),
    lite: Object.freeze({
      "shellMinimizer.enabled": true,
      "shellMinimizer.sourceOutlineLevel": "default",
      "tools.artifactSpillThreshold": 50,
      "tools.artifactTailBytes": 20,
      "tools.artifactHeadBytes": 20,
      "tools.artifactTailLines": 500,
    }),
    full: Object.freeze({
      "shellMinimizer.enabled": true,
      "shellMinimizer.sourceOutlineLevel": "default",
      "tools.artifactSpillThreshold": 20,
      "tools.artifactTailBytes": 12,
      "tools.artifactHeadBytes": 12,
      "tools.artifactTailLines": 300,
    }),
    ultra: Object.freeze({
      "shellMinimizer.enabled": true,
      "shellMinimizer.sourceOutlineLevel": "aggressive",
      "tools.artifactSpillThreshold": 10,
      "tools.artifactTailBytes": 8,
      "tools.artifactHeadBytes": 0,
      "tools.artifactTailLines": 200,
    }),
  }),
  prune: Object.freeze({
    off: Object.freeze({
      "compaction.supersedeReads": false,
      "compaction.dropUseless": false,
      "compaction.keepRecentTokens": 20000,
    }),
    lite: Object.freeze({
      "compaction.supersedeReads": true,
      "compaction.dropUseless": false,
      "compaction.keepRecentTokens": 20000,
    }),
    full: Object.freeze({
      "compaction.supersedeReads": true,
      "compaction.dropUseless": true,
      "compaction.keepRecentTokens": 12000,
    }),
    ultra: Object.freeze({
      "compaction.supersedeReads": true,
      "compaction.dropUseless": true,
      "compaction.keepRecentTokens": 8000,
    }),
  }),
  // The trigger family. `compaction.thresholdPercent` is the share of the context window at which
  // automatic compaction runs after a turn; `-1` is the host's own "no fixed limit" value, where the
  // reserve-based threshold (a 16384-token floor and at least 15% of the window) applies instead, so
  // `off` pins stock behaviour rather than disabling compaction. Percent, not
  // `compaction.thresholdTokens`, is what a *level* stands for: an absolute cap is wrong the moment
  // the session changes model, and a positive absolute value silently outranks the percent. Both keys
  // are still written — the pair the level and `options.threshold` resolve to (see nativeMapping).
  // `compaction.idleThresholdTokens` is absolute because the host key is — the levels are tuned for a
  // ~200k window and want scaling down on a model with a much smaller one. Idle compaction used to be
  // switched on by `prune=ultra` while this token trigger stayed at its 200000 default, which is at or
  // above the whole window of many models, so the setting could never fire: the trigger lives here now.
  threshold: Object.freeze({
    off: Object.freeze({
      "compaction.thresholdPercent": THRESHOLD_PERCENT.off,
      "compaction.thresholdTokens": -1,
      "compaction.idleEnabled": false,
      "compaction.idleThresholdTokens": 200000,
    }),
    lite: Object.freeze({
      "compaction.thresholdPercent": THRESHOLD_PERCENT.lite,
      "compaction.thresholdTokens": -1,
      "compaction.idleEnabled": false,
      "compaction.idleThresholdTokens": 200000,
    }),
    full: Object.freeze({
      "compaction.thresholdPercent": THRESHOLD_PERCENT.full,
      "compaction.thresholdTokens": -1,
      "compaction.idleEnabled": true,
      "compaction.idleThresholdTokens": 120000,
    }),
    ultra: Object.freeze({
      "compaction.thresholdPercent": THRESHOLD_PERCENT.ultra,
      "compaction.thresholdTokens": -1,
      "compaction.idleEnabled": true,
      "compaction.idleThresholdTokens": 80000,
    }),
  }),
});

// The tier dials — prompt-level behaviour that no single knob owns, so they stay keyed by preset.
//   tools.intentTracing defaults to TRUE and adds an intent string to every tool call; it is the one
//   key whose token-saving value is `false`, so only `high` and above switch it off.
//   skillful=false removes the skill inventory from the system prompt — a real tradeoff, so `ultra`.
//   tools.artifactHeadBytes=0 (in `compress`) means tail-only spill.
//   compaction.keepRecentTokens is the verbatim-history floor left after a compaction: the main dial
//   on post-compaction context size.
// Left deliberately alone: provider.appendOnlyContext (already cache-friendly), memory.backend,
// advisor/autolearn/prewalk (off by default), snapcompact (experimental), and every
// display/statusLine/tui key — display-only, zero model tokens.
const PRESET_NATIVE = Object.freeze({
  lite: Object.freeze({
    "tools.intentTracing": true,
    "task.maxEffort": "max",
    "task.softRequestBudget": 200,
    skillful: true,
  }),
  medium: Object.freeze({
    "tools.intentTracing": true,
    "task.maxEffort": "max",
    "task.softRequestBudget": 200,
    skillful: true,
  }),
  high: Object.freeze({
    "tools.intentTracing": false,
    "task.maxEffort": "high",
    "task.softRequestBudget": 200,
    skillful: true,
  }),
  max: Object.freeze({
    "tools.intentTracing": false,
    "task.maxEffort": "high",
    "task.softRequestBudget": 150,
    skillful: true,
  }),
  ultra: Object.freeze({
    "tools.intentTracing": false,
    "task.maxEffort": "medium",
    "task.softRequestBudget": 90,
    skillful: false,
  }),
});

// Every key any table can write, computed once at load: `off` resets exactly this set, and the
// status table walks it so it can never drift from the mapping above.
const NATIVE_KEYS = Object.freeze([
  ...new Set([
    ...Object.values(KNOB_NATIVE).flatMap((levels) => Object.values(levels).flatMap((level) => Object.keys(level))),
    ...Object.values(PRESET_NATIVE).flatMap((tier) => Object.keys(tier)),
  ]),
]);

// `off` writes no anti-defaults: it resets this exact key set to the host's defaults, because a
// pinned `false` would outlive the release it was written for, while a reset returns to whatever the
// host then considers sane.
const NATIVE_OFF = "off";

// The tier dials come from the state's preset. A hand-mixed knob set has no tier of its own, so the
// dials fall back to the built-in default tier rather than inventing one from whichever knobs happen
// to be set.
function tierOf(state) {
  return PRESET_NATIVE[state.preset] ? state.preset : DEFAULT_PRESET;
}

// What the running state wants written: the four knobs' keys plus the tier's dials. The two
// compaction limits are the exception to "a level maps to its keys": the level's share and
// `options.threshold` resolve to a pair, and `auto` decides between a share and a fixed cap by
// weighing the cap against this session's context window, which no level table can do.
function nativeMapping(state, contextWindow) {
  const limits = resolveThreshold(readOptions().threshold, THRESHOLD_PERCENT[state.threshold], contextWindow);
  return {
    ...KNOB_NATIVE.read[state.read],
    ...KNOB_NATIVE.compress[state.compress],
    ...KNOB_NATIVE.prune[state.prune],
    ...KNOB_NATIVE.threshold[state.threshold],
    ...PRESET_NATIVE[tierOf(state)],
    "compaction.thresholdPercent": limits.percent,
    "compaction.thresholdTokens": limits.tokens,
  };
}

// What a write or a status report is based on: a preset state names itself, a hand-mixed one says so
// and names the tier whose dials it fell back to.
function nativeTier(state) {
  return PRESET_NAMES.includes(state.preset) ? state.preset : `${tierOf(state)} (state is custom)`;
}

function nativeText(value) {
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

// A value starting with `-` is read as a flag by the CLI: `omp config set compaction.thresholdPercent
// -1` exits 1 with "Unknown option '-1'" and writes nothing, and `thresholdPercent = -1` is the host's
// own "no fixed limit" default, so the `threshold=off` level legitimately writes it. The `--`
// separator is the only accepted form — `key=-1` prints usage instead of setting anything.
function setArgs(key, value) {
  const text = nativeText(value);
  return ["config", "set", key, ...(text.startsWith("-") ? ["--"] : []), text];
}

// Windows resolves `omp` to an .exe/.cmd shim that Node refuses to spawn without a shell; the repo
// installer's execCli does the same thing for the same reason.
function ompCommand(args) {
  return IS_WINDOWS ? ["cmd.exe", ["/c", "omp", ...args]] : ["omp", args];
}

// Headroom integration. The proxy is provider-agnostic: it picks the upstream from the request's
// protocol (anthropic auth vs everything else) and each family's real endpoint comes from a
// `--*api-url` flag, so ANY provider can be routed — not just anthropic, which is all `headroom wrap
// omp` does (it hardcodes a `providers.anthropic.baseUrl` override in models.yml).
//
// We route the *session* instead of editing files: `pi.registerProvider(id, {baseUrl})` writes a
// runtime transport override that outranks both models.yml and the bundled catalog for that provider
// id, keeps its bundled models and stored credentials, and takes effect immediately — no restart, no
// YAML surgery, and unwrapping is `pi.unregisterProvider`. The cost of that choice is scope: it
// routes this process (subagents included) and is gone when the session ends, where `headroom wrap
// omp` survives into new processes but only ever covers anthropic.
const HEADROOM_TIMEOUT_MS = 10000;
const HEADROOM_INSTALL = 'uv tool install --python 3.13 "headroom-ai[all]"';
const HEADROOM_PORT_DEFAULT = 8787;
const HEADROOM_HEALTH_TIMEOUT_MS = 45000;
const HEADROOM_STATE_FILE = process.env.OMP_HEADROOM_STATE || path.join(AGENT_DIR, "headroom.json");
const HEADROOM_LOG_FILE = path.join(AGENT_DIR, "headroom.log");

// api family -> [headroom's upstream flag, health key, path omp appends after the base URL].
// The suffix is what the client adds on top of the base: openai-completions posts to `<base>/v1/...`,
// so the proxy root needs its own `/v1`; the anthropic and google SDKs append their own versioned
// path and take the bare root.
const HEADROOM_FAMILIES = Object.freeze({
  "openai-completions": Object.freeze({ flag: "--openai-api-url", health: "openai_api_url", suffix: "v1" }),
  "openai-responses": Object.freeze({ flag: "--openai-api-url", health: "openai_api_url", suffix: "v1" }),
  "openai-codex-responses": Object.freeze({ flag: "--openai-api-url", health: "openai_api_url", suffix: "v1" }),
  "azure-openai-responses": Object.freeze({ flag: "--openai-api-url", health: "openai_api_url", suffix: "v1" }),
  "anthropic-messages": Object.freeze({ flag: "--anthropic-api-url", health: "anthropic_api_url", suffix: "" }),
  "google-generative-ai": Object.freeze({ flag: "--gemini-api-url", health: "gemini_api_url", suffix: "" }),
  "google-gemini-cli": Object.freeze({ flag: "--gemini-api-url", health: "gemini_api_url", suffix: "" }),
  "google-vertex": Object.freeze({ flag: "--vertex-api-url", health: "vertex_api_url", suffix: "" }),
});

// Same Windows shim as ompCommand: a bare `headroom` does not resolve to the .exe without a shell.
function headroomCommand(args) {
  return IS_WINDOWS
    ? [process.env.ComSpec || "cmd.exe", ["/c", "headroom", ...args]]
    : ["headroom", args];
}

async function execHeadroom(pi, args) {
  if (typeof pi?.exec !== "function") throw new Error("this session exposes no exec");
  const [command, argv] = headroomCommand(args);
  const result = await pi.exec(command, argv, { timeout: HEADROOM_TIMEOUT_MS });
  if (result?.code !== 0) {
    const stderr = String(result?.stderr || result?.stdout || "").trim().split("\n").filter(Boolean).pop();
    throw new Error(stderr || `headroom exited ${result?.code}`);
  }
  return clip(result?.stdout || result?.stderr, 600);
}

// Syscall, not stack: one line naming what failed, the way the config writer reports it too.
function shortError(error) {
  return String(error?.message || error).split(",")[0];
}

// A status report is a notification, not a file dump.
function clip(text, max) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// The proxy's own config block, for loopback callers: which upstreams it will forward to. That is the
// only authority on where traffic goes — ours is a request, this is what the running proxy does.
async function headroomHealth(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return { up: false, reason: `HTTP ${response.status}` };
    const body = await response.json();
    return {
      up: Boolean(body?.ready),
      status: clip(body?.status, 40),
      version: clip(body?.version, 40),
      rustCore: clip(body?.rust_core, 40),
      config: body?.config && typeof body.config === "object" ? body.config : {},
      reason: body?.ready ? "" : `proxy reports ${clip(body?.status, 40)}`,
    };
  } catch (error) {
    return { up: false, reason: shortError(error) };
  }
}

function readHeadroomState() {
  try {
    const parsed = JSON.parse(readFileSync(HEADROOM_STATE_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeHeadroomState(state) {
  try {
    mkdirSync(path.dirname(HEADROOM_STATE_FILE), { recursive: true });
    writeFileSync(HEADROOM_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
    return "";
  } catch (error) {
    return shortError(error);
  }
}

function clearHeadroomState() {
  try {
    rmSync(HEADROOM_STATE_FILE, { force: true });
  } catch {
    // A state file we cannot remove is not a reason to fail an unwrap that already worked.
  }
}

// Which port to talk to: the proxy this pack started wins (that is the one to report and later stop),
// then `headroom.port` — 8787 is headroom's own default, so a proxy you run yourself owns that port and
// this option is how the pack runs beside it.
function headroomPort() {
  return readHeadroomState()?.port || readOptions().headroom.port || HEADROOM_PORT_DEFAULT;
}

// `headroom proxy` runs in the foreground; the pack owns it as a detached process so it outlives the
// command that started it. It is spawned *directly*, never through a shell: a shell would be the
// process we recorded, and stopping that would leave the proxy holding the port.
async function startHeadroomProxy(port, flag, upstream) {
  const { spawn } = await import("node:child_process");
  const log = openSync(HEADROOM_LOG_FILE, "a");
  const child = spawn(IS_WINDOWS ? "headroom.exe" : "headroom", [
    "proxy",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    flag,
    upstream,
  ], { detached: true, stdio: ["ignore", log, log], windowsHide: true });
  child.unref();

  // A missing binary reports through this event, not through the health probe: without a listener an
  // ENOENT here would be an unhandled 'error' and take the session down.
  let spawnError = "";
  child.on("error", (error) => {
    spawnError = shortError(error);
  });

  const deadline = Date.now() + HEADROOM_HEALTH_TIMEOUT_MS;
  let health = await headroomHealth(port);
  while (!health.up && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    health = await headroomHealth(port);
  }
  if (!health.up && spawnError) health.reason = spawnError;
  return { pid: child.pid, health };
}

// What this session's active model says about its own endpoint: the provider id to override, the api
// family that selects headroom's flag, and the real base URL that becomes headroom's upstream.
function sessionRoute(ctx) {
  const model = ctx?.models?.current?.();
  if (!model?.provider) return null;
  const family = HEADROOM_FAMILIES[model.api];
  return {
    provider: String(model.provider),
    api: String(model.api || ""),
    baseUrl: String(model.baseUrl || ""),
    family: family || null,
    modelId: String(model.id || ""),
  };
}

function proxyBaseUrl(port, family) {
  return `http://127.0.0.1:${port}${family.suffix ? `/${family.suffix}` : ""}`;
}

// `headroom wrap omp` fenced-injects a providers.anthropic.baseUrl override into the agent dir's
// models.yml. That is a *different* mechanism from ours, and it outlives the session, so status has to
// say whether it is in place: it applies to every new process, ours to this one.
function headroomWrapState() {
  const file = path.join(AGENT_DIR, "models.yml");
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { file, state: "models.yml missing", line: "" };
  }
  const line = text.split(/\r?\n/).find((row) => /headroom/i.test(row));
  return { file, state: line ? "wrapped" : "not wrapped", line: clip(line, 120) };
}

async function headroomStatusText(pi, ctx) {
  let version = "";
  try {
    version = await execHeadroom(pi, ["--version"]);
  } catch {
    version = "";
  }

  const state = readHeadroomState();
  const port = headroomPort();
  const health = version ? await headroomHealth(port) : { up: false, reason: "headroom not installed" };
  const route = sessionRoute(ctx);
  const wrap = headroomWrapState();

  const lines = [
    version ? `Headroom: ${version}` : `Headroom: not installed\nInstall: ${HEADROOM_INSTALL}`,
    `Proxy on ${port}: ${
      health.up
        ? `up (${health.status || "healthy"}, rust core ${health.rustCore || "unknown"})`
        : `down (${health.reason || "no proxy"})`
    }`,
  ];

  if (health.up) {
    const upstreams = Object.entries(HEADROOM_FAMILIES)
      .filter(([, family], index, all) => all.findIndex(([, other]) => other.health === family.health) === index)
      .map(([, family]) => `    ${family.health}=${health.config?.[family.health] ?? "(unset, headroom default)"}`);
    lines.push("Proxy upstreams:", ...upstreams);
  }

  if (!route) {
    lines.push("This session: no model resolved yet, so nothing to route.");
  } else if (!route.family) {
    lines.push(
      `This session: ${route.provider} (api ${route.api || "unknown"}) — headroom has no upstream flag for this family, so it cannot be routed.`
    );
  } else {
    const proxyBase = proxyBaseUrl(port, route.family);
    const live = route.baseUrl === proxyBase;
    lines.push(
      `This session: ${route.provider} (api ${route.api}, upstream ${route.baseUrl || "unknown"})`,
      `Routed through the proxy: ${live ? `yes — ${route.baseUrl}` : "no — /ts headroom wrap routes it"}`,
      `Traffic goes: omp → ${proxyBase} → ${live ? "the upstream above" : route.baseUrl || "?"}`
    );
  }

  lines.push(
    `Durable wrap (\`headroom wrap omp\`, anthropic only): ${wrap.state}${wrap.line ? ` — ${wrap.line}` : ""}`,
    "You run these; the pack never installs or starts a proxy you did not ask for:",
    "  /ts headroom wrap     route this session's provider through a local proxy",
    "  /ts headroom unwrap   unroute it (stops a proxy the pack started)"
  );
  return lines.join("\n");
}

async function execOmp(pi, args) {
  if (typeof pi?.exec !== "function") throw new Error("this session exposes no exec");
  // `--json` goes in front of the `--` separator, never after it: everything past `--` is positional,
  // so an appended flag is parsed as part of the value and the write dies as
  // `Invalid number: -1 --json`. That is the path `threshold=off` takes, whose value is `-1`.
  const separator = args.indexOf("--");
  const withFlag = separator === -1 ? [...args, "--json"] : [...args.slice(0, separator), "--json", ...args.slice(separator)];
  const [command, argv] = ompCommand(withFlag);
  const result = await pi.exec(command, argv, { timeout: OMP_TIMEOUT_MS });
  if (result?.code !== 0) {
    const stderr = String(result?.stderr || result?.stdout || "").trim().split("\n").filter(Boolean).pop();
    throw new Error(stderr || `omp config exited ${result?.code}`);
  }
  return String(result?.stdout || "");
}

// `omp config get|set|reset|list --json` all print a JSON object (list prints a path -> entry map).
function firstJsonObject(raw) {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function readNativeValues(pi) {
  const parsed = firstJsonObject(await execOmp(pi, ["config", "list"]));
  if (!parsed || typeof parsed !== "object") throw new Error("unexpected `omp config list --json` output");
  const values = new Map();
  for (const [key, entry] of Object.entries(parsed)) {
    values.set(key, entry && typeof entry === "object" && "value" in entry ? entry.value : entry);
  }
  return values;
}

async function runNativeCommand(pi, args) {
  const parsed = firstJsonObject(await execOmp(pi, args));
  return parsed?.value;
}

function showValue(value) {
  if (value === undefined || value === null) return "(unset)";
  return String(value);
}

function knobsText(modes) {
  return MODE_KNOBS.map((name) => `${name}=${modes[name]}`).join(" ");
}

function optionsText() {
  return Object.entries(DEFAULT_OPTIONS)
    .map(([group, keys]) => `${group}.{${Object.keys(keys).join(",")}}`)
    .join(", ");
}

function pairs(text, separator) {
  return String(text || "").trim().split(separator).filter(Boolean);
}

function usageText() {
  return [
    "/token-saver or /ts          — settings menu (status text if the session has no selector)",
    "/ts status                   — preset, knobs, config path, native gate, stored default",
    "/ts config                   — the menu, explicitly (alias /ts settings)",
    `/ts preset <${PRESET_NAMES.join("|")}>   — apply now (also /ts <preset>, /combo <preset>)`,
    "/ts set <knob>=<value> ...   — one knob for this session",
    "/ts default [<preset> | <knob>=<value> ... | reset]  — what new sessions start from",
    "/ts option <group>.<key>=<value>  — behaviour of our own add-ons",
    "/ts native [status|on|off|apply|reset]  — OMP's own read/shell/compaction settings",
    "/ts headroom [status|wrap|unwrap]  — route this session's provider (any family headroom supports) through a local proxy",
    "/ts help                     — this list",
    "",
    `Knobs: ${MODE_KNOBS.map((name) => `${name} (${KNOBS[name].join("|")})`).join(", ")}`,
    `Options: ${optionsText()}`,
  ].join("\n");
}

function statusText() {
  const state = getSharedState();
  const defaults = readConfig();
  const native = readOptions().native.mode;
  // One line, only while the gap is real: the four native knobs write nothing into config.yml at the
  // default gate, so a preset that carries levels is prompt text plus a row until `/ts native on`.
  const gap = nativeGapHint(state.preset, native);
  return [
    `Token Saver: ${String(state.preset).toUpperCase()}`,
    knobsText(state),
    `Config: ${CONFIG_FILE}`,
    `Native config.yml: ${native}${native === "auto" ? " (follows the knobs and preset)" : " (/ts native apply writes it)"}`,
    ...(gap ? [`Native knobs: ${gap}`] : []),
    `Default for new sessions: ${String(defaults.preset).toUpperCase()} (${knobsText(defaults.modes)})`,
    "Run /ts help for the command list.",
  ].join("\n");
}

function defaultSummary(ctx) {
  const defaults = readConfig();
  return [
    `Default for new sessions: ${String(defaults.preset).toUpperCase()}`,
    knobsText(defaults.modes),
    `Config: ${CONFIG_FILE}`,
  ].join("\n");
}

export default function tokenSaverExtension(pi) {
  let activeCtx = null;
  let watchTimer = null;
  let listenerInstalled = false;
  let nativeConfigPath = null;

  pi.setLabel?.("Supreme Token Saver");

  function notify(ctx, text, type) {
    ctx?.ui?.notify?.(text, type || "info");
  }

  function entriesFrom(ctx) {
    return ctx?.sessionManager?.getBranch?.() || ctx?.sessionManager?.getEntries?.() || [];
  }

  function render(ctx) {
    return renderModes(getSharedState(), ctx);
  }

  // A config path that cannot be written (a directory, a read-only install) must degrade to a
  // warning like the native and headroom layers do, never throw out of the command handler.
  function reportWrite(ctx, result) {
    if (!result.error) return true;
    notify(ctx, `Config not written: ${result.error}\nFile: ${CONFIG_FILE}`, "warning");
    return false;
  }

  function reconcile(ctx) {
    // The session id keeps a second runner in this process (a subagent gets its own) from
    // republishing its empty branch over this session's live state.
    const state = reconcileSharedEntries(entriesFrom(ctx), ctx?.sessionManager?.getSessionId?.());
    render(ctx);
    return state;
  }

  // The ponytail plugin appends `ponytail-mode` entries from its own commands without telling us,
  // and a sibling add-on can change a knob the same way. Watch the branch so the unified row tracks
  // it. // ponytail: 1s poll; switch to an event if omp emits a command-completed hook.
  function branchKey(ctx) {
    const entries = entriesFrom(ctx);
    return `${entries.length}:${entries.at(-1)?.id || ""}`;
  }

  // Armed once per session: `onSession` also runs on every `agent_start`, and tearing the timer down
  // and rebuilding it there meant one clear + one arm per turn for a poll that was already running.
  function watchBranch(ctx) {
    if (!ctx?.setInterval || !ctx?.clearTimer || watchTimer) return;
    let lastKey = branchKey(ctx);
    watchTimer = ctx.setInterval(() => {
      const key = branchKey(ctx);
      if (key === lastKey) return;
      lastKey = key;
      reconcile(ctx);
    }, 1000);
  }

  function listen(ctx) {
    if (ctx) activeCtx = ctx;
    if (listenerInstalled) return;
    setSharedListener((state) => renderModes(state, activeCtx));
    listenerInstalled = true;
  }

  function onSession(_event, ctx) {
    listen(ctx);
    if (ctx) activeCtx = ctx;
    reconcile(ctx);
    watchBranch(ctx);
    // A resumed session whose entries say `headroom=on` was left unrouted by the process that ended:
    // the knob is session state, the wiring is not. `void` because this handler is sync and the wrap
    // reports every outcome itself. Quiet: a start that silently re-established the routing the row
    // already shows needs no banner — only a refusal (wrong upstream, proxy down) is worth a line.
    void syncHeadroom(ctx, undefined, { quiet: true });
  }

  // --- native settings ---------------------------------------------------------------------

  async function nativePathOf() {
    if (nativeConfigPath) return nativeConfigPath;
    if (typeof pi?.exec === "function") {
      try {
        const [command, argv] = ompCommand(["config", "path"]);
        const result = await pi.exec(command, argv, { timeout: OMP_TIMEOUT_MS });
        const printed = String(result?.stdout || "").trim().split("\n").filter(Boolean).pop();
        if (result?.code === 0 && printed) {
          nativeConfigPath = path.join(printed, "config.yml");
          return nativeConfigPath;
        }
      } catch {
        // Fall through to the default location.
      }
    }
    nativeConfigPath = path.join(AGENT_DIR, "config.yml");
    return nativeConfigPath;
  }

  // `off` restores the host's defaults for exactly the mapped keys and reports which ones it reset.
  // `omp config reset` leaves each key pinned at its default rather than deleting the line, so a
  // reset leaves the mapped keys visible in config.yml at host defaults — inert, and one hand edit
  // away from gone.
  // ponytail: one `omp` process per key (19); a batch verb would make this ~20x faster if the CLI
  // ever grows one.
  async function resetNative(ctx, label) {
    const reset = [];
    const failed = [];
    for (const key of NATIVE_KEYS) {
      try {
        await runNativeCommand(pi, ["config", "reset", key]);
        reset.push(key);
      } catch (error) {
        failed.push(`${key} (${error?.message || error})`);
      }
    }
    notify(
      ctx,
      `Native OMP settings ${label}: ${reset.length}/${NATIVE_KEYS.length} key(s) reset to OMP defaults` +
        `${failed.length ? `; failed — ${failed.join("; ")}` : ""}\n${reset.join(" ")}` +
        `\nFile: ${await nativePathOf()}`,
      failed.length ? "warning" : "info"
    );
  }

  async function applyNative(ctx, force) {
    const state = getSharedState();
    if (state.preset === NATIVE_OFF) {
      await resetNative(ctx, "for preset OFF");
      return;
    }

    const mapping = nativeMapping(state, sessionContextWindow(ctx));
    const tier = nativeTier(state);

    let current;
    try {
      current = await readNativeValues(pi);
    } catch (error) {
      notify(ctx, `Native settings unavailable: ${error?.message || error}. config.yml untouched.`, "warning");
      return;
    }

    // Read once, write only the keys that differ: a state change costs one `omp` call plus a handful
    // of writes instead of one call per key.
    const pending = Object.entries(mapping).filter(([key, value]) => current.get(key) !== value);
    if (!pending.length) {
      if (force) notify(ctx, `Native settings already match tier ${tier}.`, "info");
      return;
    }

    const written = [];
    const failed = [];
    for (const [key, value] of pending) {
      try {
        await runNativeCommand(pi, setArgs(key, value));
        written.push(`${key}=${nativeText(value)}`);
      } catch (error) {
        failed.push(`${key} (${error?.message || error})`);
      }
    }

    notify(
      ctx,
      `Native OMP settings for tier ${tier}: ${written.length} key(s) written` +
        `${failed.length ? `, ${failed.length} failed — ${failed.join("; ")}` : ""}\n` +
        `${written.join(" ")}\nFile: ${await nativePathOf()}`,
      failed.length ? "warning" : "info"
    );
  }

  async function nativeStatus(ctx) {
    const gate = readOptions().native.mode;
    const state = getSharedState();
    const off = state.preset === NATIVE_OFF;
    const mapping = nativeMapping(state, sessionContextWindow(ctx));

    let current;
    try {
      current = await readNativeValues(pi);
    } catch (error) {
      notify(
        ctx,
        `Native OMP settings: ${gate} (${gate === "auto" ? "follows" : "never writes"} config.yml)\n` +
          `Unavailable: ${error?.message || error}`,
        "warning"
      );
      return;
    }

    const lines = NATIVE_KEYS.map((key) => {
      const have = showValue(current.get(key));
      const want = off ? "OMP default" : nativeText(mapping[key]);
      return `${have === want ? "=" : "→"} ${key}: ${have} → ${want}`;
    });
    notify(
      ctx,
      `Native OMP settings: ${gate} (${gate === "auto" ? "follows" : "never writes"} config.yml)` +
        ` · tier: ${off ? `${NATIVE_OFF} — every key resets to the OMP default` : nativeTier(state)}` +
        `\n${lines.join("\n")}\nFile: ${await nativePathOf()}\n/ts native apply | reset | on | off`,
      "info"
    );
  }

  // --- in-session settings menu --------------------------------------------------------------

  // The menu is a front end for the verbs above, not a second implementation of them: `/ts set`
  // needs the knob spelling and its accepted values, which is exactly what someone who has not
  // read the README does not know. Selectors exist only in the interactive TUI — a subagent, print
  // run or RPC client reports `hasUI: false` and gets the usage text instead of a dead menu.
  function menuUi(ctx) {
    return ctx?.hasUI === true && typeof ctx?.ui?.select === "function" ? ctx.ui : null;
  }

  async function menuPreset(ui, ctx) {
    const preset = await ui.select(
      "Token Saver · preset (this session)",
      PRESET_NAMES.map((name) => ({ label: name, description: knobsText(presetModes(name)) }))
    );
    if (preset) await applyPreset(preset, ctx);
  }

  // One knob flow serves both scopes: pick the level, then say whether it is this session or what
  // new sessions start from. Both writes go through the same verbs the typed forms use.
  async function menuSet(ui, ctx) {
    const state = getSharedState();
    const knob = await ui.select(
      "Token Saver · knob",
      MODE_KNOBS.map((name) => ({
        label: name,
        description: `now ${state[name]} — ${KNOBS[name].join("|")}`,
      }))
    );
    if (!knob) return;

    const value = await ui.select(
      `${knob} · level`,
      KNOBS[knob].map((level) =>
        knob === "status" && STATUS_LEVELS[level] ? { label: level, description: STATUS_LEVELS[level] } : level
      )
    );
    if (!value) return;

    const scope = await pickScope(ui, `${knob}=${value}`);
    if (!scope) return;

    if (scope === "This session") await applySet(`${knob}=${value}`, ctx);
    else applyDefault(`${knob}=${value}`, ctx);
  }

  // Where a pick goes. Every knob has both destinations — `/ts set` for the session, `/ts default`
  // for the file — so the menu asks once, in one vocabulary, instead of one entry that writes and
  // another that forgets.
  function pickScope(ui, label) {
    return ui.select(label, [
      { label: "This session", description: "applies now, reloads the session" },
      { label: "New sessions", description: "stored default; this session is unchanged" },
    ]);
  }

  // The row is the only UI this pack prints, so it gets its own entry instead of hiding one level
  // deeper under `Knob`; every option carries the row it would actually produce. Then the same
  // session-or-default choice every other knob gets: a shape picked here used to live only until the
  // session ended, which is exactly what `/ts default status=<shape>` exists to fix.
  async function menuRow(ui, ctx) {
    const state = getSharedState();
    const shape = await ui.select(
      "Token Saver · the footer row",
      KNOBS.status.map((level) => ({
        label: level,
        description: `${STATUS_LEVELS[level]} — ${previewRow(state, level, ctx) || "(no row)"}`,
      }))
    );
    if (!shape) return;

    const scope = await pickScope(ui, `status=${shape}`);
    if (!scope) return;

    if (scope === "This session") await applySet(`status=${shape}`, ctx);
    else applyDefault(`status=${shape}`, ctx);
  }

  async function menuDefault(ui, ctx) {
    const choice = await ui.select("Token Saver · default for new sessions", [
      ...PRESET_NAMES.map((name) => ({ label: name, description: knobsText(presetModes(name)) })),
      { label: "reset", description: "delete the config file; back to the built-in max" },
    ]);
    if (choice) applyDefault(choice, ctx);
  }

  async function menuOption(ui, ctx) {
    const options = readOptions();
    const paths = Object.entries(DEFAULT_OPTIONS).flatMap(([group, keys]) =>
      Object.keys(keys).map((key) => `${group}.${key}`)
    );
    const valueOf = (dotted) => {
      const [group, key] = dotted.split(".");
      return options?.[group]?.[key];
    };

    const pick = await ui.select(
      "Token Saver · behaviour option (new sessions)",
      paths.map((dotted) => ({ label: dotted, description: `now ${JSON.stringify(valueOf(dotted))}` }))
    );
    if (!pick) return;

    const [group, key] = pick.split(".");
    const allowed = OPTION_VALUES[group]?.[key];
    const expected = DEFAULT_OPTIONS[group][key];
    let value;

    if (allowed) {
      value = await ui.select(`${pick} · value`, [...allowed]);
    } else if (typeof expected === "number") {
      value = await ui.input(`${pick} · number`, String(valueOf(pick)));
    } else {
      // A list option keeps the JSON syntax the typed verb takes: one spelling for the value in the
      // file, no second parser behind the menu.
      value = await ui.input(`${pick} · JSON array`, JSON.stringify(valueOf(pick) || []));
    }
    if (value === undefined || value === "") return;

    applyOption(`${pick}=${value}`, ctx);
  }

  async function menuNative(ui, ctx) {
    const verb = await ui.select("Token Saver · OMP's own settings (config.yml)", [
      { label: "status", description: "our keys versus what OMP currently has" },
      { label: "apply", description: "write this session's levels into config.yml now" },
      { label: "auto", description: "presets and knob changes write config.yml too" },
      { label: "off", description: "never write config.yml on its own (apply still does)" },
      { label: "reset", description: "every mapped key back to the OMP default" },
    ]);
    if (verb) await applyNativeVerb(verb, ctx);
  }

  async function menuHeadroom(ui, ctx) {
    const route = sessionRoute(ctx);
    const verb = await ui.select("Token Saver · Headroom proxy", [
      { label: "status", description: "proxy health, its upstreams, and whether this session is routed" },
      {
        label: "wrap",
        description: route?.family
          ? `route ${route.provider} through a local proxy — omp → 127.0.0.1 → ${route.baseUrl || "?"}`
          : `no upstream flag for api "${route?.api || "unknown"}" — status explains`,
      },
      { label: "unwrap", description: "unroute this session and stop a proxy the pack started" },
      { label: "unwrap-models", description: "restore a models.yml a durable `headroom wrap omp` wrote" },
    ]);
    if (verb) await headroomVerb(verb, ctx);
  }

  async function settingsMenu(ctx) {
    const ui = menuUi(ctx);
    if (!ui) {
      notify(ctx, `No selector in this session — use the typed verbs.\n${usageText()}`, "warning");
      return;
    }

    const choice = await ui.select("Supreme Token Saver", [
      { label: "Preset", description: "every knob at once, for this session" },
      { label: "Knob", description: "one knob's level, this session or the stored default" },
      { label: "Footer row", description: `what the pack prints — now ${getSharedState().status}` },
      { label: "Default for new sessions", description: knobsText(readConfig().modes) },
      { label: "Behaviour options", description: `${optionsText()} — new sessions` },
      { label: "OMP's own settings", description: "status, apply, reset the native keys" },
      { label: "Headroom", description: "optional compression proxy — route this session's provider through it" },
      { label: "Status", description: "the text /ts prints" },
    ]);
    if (!choice) return;

    if (choice === "Preset") await menuPreset(ui, ctx);
    else if (choice === "Knob") await menuSet(ui, ctx);
    else if (choice === "Footer row") await menuRow(ui, ctx);
    else if (choice === "Default for new sessions") await menuDefault(ui, ctx);
    else if (choice === "Behaviour options") await menuOption(ui, ctx);
    else if (choice === "OMP's own settings") await menuNative(ui, ctx);
    else if (choice === "Headroom") await menuHeadroom(ui, ctx);
    else notify(ctx, statusText(), "info");
  }

  // --- commands ----------------------------------------------------------------------------

  async function applyPreset(name, ctx) {
    const preset = normalizePreset(name);
    if (!preset) {
      notify(ctx, `Unknown preset: ${name}. Use: ${PRESET_NAMES.join(" | ")}`, "warning");
      return;
    }

    const state = setSharedPreset(preset);
    const modes = presetModes(preset);
    pi.appendEntry("ts-preset", { preset });
    // Pre-2.0 builds and the upstream ponytail plugin read these three, so a preset keeps writing
    // them: a session reopened by an older install (or by the plugin) still shows the same state.
    pi.appendEntry("caveman-mode", { mode: modes.caveman });
    pi.appendEntry("rtk-mode", { enabled: modes.rtk === "on" });
    pi.appendEntry("ponytail-mode", { mode: modes.ponytail });
    renderModes(state, ctx);
    // Report the resulting state, not the preset literal: a preset says nothing about the row's shape,
    // so the line has to show the shape the session keeps.
    notify(ctx, `Preset ${preset.toUpperCase()} applied: ${knobsText(state)}`);

    if (readOptions().native.mode === "auto") await applyNative(ctx, false);
    // A preset carries `headroom` like any other behaviour knob — `ultra` turns it on, the rest off —
    // so applying one starts or stops the routing to match.
    await syncHeadroom(ctx, modes.headroom, { force: true });
    await ctx?.reload?.();
  }

  // The knob's *intent* arrives through session entries; the wiring it describes is process state that
  // does not survive a resume, and the shared state holds the *effective* value — wrap/unwrap publish
  // what actually happened, so the row never claims a routing that failed. One attempt per intent
  // value: a failed wrap publishes `off` and is not retried until the knob changes.
  let headroomAttempted = "";

  async function syncHeadroom(ctx, intent = getSharedState().headroom, options = {}) {
    try {
      const route = sessionRoute(ctx);
      if (!route?.family) return;
      const port = headroomPort();
      const routed = route.baseUrl === proxyBaseUrl(port, route.family);
      if (!options.force && headroomAttempted === intent) return;
      headroomAttempted = intent;
      if (intent === "on" && !routed) await headroomWrap(ctx, options);
      else if (intent === "off" && routed) await headroomUnwrap(ctx);
    } catch (error) {
      notify(ctx, `Headroom: ${shortError(error)}`, "warning");
    }
  }

  async function applySet(arg, ctx) {
    const items = pairs(arg, /[\s,]+/);
    if (!items.length) {
      notify(ctx, `Usage: /ts set <knob>=<value> ...\nKnobs: ${MODE_KNOBS.join(", ")}`, "warning");
      return;
    }

    // Validate every pair before writing any: one typo must not half-apply a line of them.
    const changes = [];
    for (const item of items) {
      const split = item.indexOf("=");
      const name = canonicalKnob(split > 0 ? item.slice(0, split) : "");
      const raw = split > 0 ? item.slice(split + 1).trim() : "";
      // `canonicalKnob` is the guard: a name it cannot resolve is not a knob, and testing
      // `KNOBS[name]` instead would accept `constructor` and then index a function.
      if (!name) {
        notify(ctx, `Unknown knob: ${item}. Knobs: ${MODE_KNOBS.join(", ")}`, "warning");
        return;
      }
      const mode = normalizeMode(name, raw);
      if (!mode) {
        notify(ctx, `Invalid value for ${name}: ${raw}. Use: ${KNOBS[name].join(" | ")}`, "warning");
        return;
      }
      changes.push([name, mode]);
    }

    for (const [name, mode] of changes) {
      pi.appendEntry("ts-mode", { name, value: mode });
      // The upstream ponytail plugin reads its own `ponytail-mode` entries for session state, so the
      // knob needs the same entry a preset writes — a `ts-mode` entry alone is display-only.
      if (name === "ponytail") pi.appendEntry("ponytail-mode", { mode });
      setSharedMode(name, mode);
    }
    render(ctx);
    notify(ctx, `Set ${changes.map(([name, mode]) => `${name}=${mode}`).join(" ")}`);
    // A knob is a level of a native behaviour, so opting into auto means /ts set writes too, not just
    // /ts preset: the shared state is already published, so applyNative sees the new levels.
    if (readOptions().native.mode === "auto") await applyNative(ctx, false);
    // `headroom` is the one knob whose value is a wiring decision, so setting it acts: `on` starts or
    // reuses a proxy and routes this session, `off` unroutes. The wrap reports what it actually did.
    if (changes.some(([name]) => name === "headroom")) {
      await syncHeadroom(ctx, getSharedState().headroom, { force: true });
    }
    await ctx?.reload?.();
  }

  function applyDefault(arg, ctx) {
    const text = String(arg || "").trim();
    if (!text) {
      notify(ctx, `${defaultSummary(ctx)}\nRunning sessions are unchanged.`, "info");
      return;
    }

    let synced = true;
    let ponytail = null;

    if (text === "reset") {
      if (!reportWrite(ctx, clearConfig())) return;
      ponytail = readConfig().modes.ponytail;
    } else {
      const preset = normalizePreset(text);
      if (preset) {
        if (!reportWrite(ctx, writeConfig({ preset }))) return;
        ponytail = presetModes(preset).ponytail;
      } else {
        const items = pairs(text, /[\s,]+/);
        const modes = {};
        for (const item of items) {
          const split = item.indexOf("=");
          const name = canonicalKnob(split > 0 ? item.slice(0, split) : "");
          const raw = split > 0 ? item.slice(split + 1).trim() : "";
          // `canonicalKnob` already answered "is this a knob"; `KNOBS[name]` would answer for
          // `constructor` too and then index a function.
          if (!name) {
            notify(ctx, `Unknown knob: ${item}. Knobs: ${MODE_KNOBS.join(", ")}`, "warning");
            return;
          }
          const mode = normalizeMode(name, raw);
          if (!mode) {
            notify(ctx, `Invalid value for ${name}: ${raw}. Use: ${KNOBS[name].join(" | ")}`, "warning");
            return;
          }
          modes[name] = mode;
        }
        if (!reportWrite(ctx, writeConfig({ modes }))) return;
        ponytail = modes.ponytail ?? null;
      }
    }

    // The ponytail plugin owns its own default, so push it only when this write chose one.
    if (ponytail) synced = syncPonytailDefault(ponytail);
    notify(
      ctx,
      `${defaultSummary(ctx)}` +
        `${synced ? "" : "\n[pending] Ponytail plugin not found — its own default was not synced."}\n` +
        "Running session unchanged; /ts preset <name> applies a preset now.",
      synced ? "info" : "warning"
    );
  }

  function applyOption(arg, ctx) {
    const text = String(arg || "").trim();
    const split = text.indexOf("=");
    const [group, key] = (split > 0 ? text.slice(0, split) : text).split(".");
    const raw = split > 0 ? text.slice(split + 1).trim() : "";

    // Own-property lookups on both halves: `DEFAULT_OPTIONS.constructor` and a bare `key in group`
    // both resolve through Object.prototype, which is how a junk group reached the config file.
    const keys = Object.prototype.hasOwnProperty.call(DEFAULT_OPTIONS, group) ? DEFAULT_OPTIONS[group] : null;
    if (!key || !keys || !Object.prototype.hasOwnProperty.call(keys, key)) {
      notify(
        ctx,
        `Unknown option: ${text || "(none)"}\nOptions: ${Object.entries(DEFAULT_OPTIONS)
          .map(([name, groupKeys]) => `${name}.{${Object.keys(groupKeys).join("|")}}`)
          .join(", ")}`,
        "warning"
      );
      return;
    }

    const current = keys[key];
    let value;
    if (typeof current === "boolean") {
      if (raw !== "true" && raw !== "false") {
        notify(ctx, `${group}.${key} takes true or false.`, "warning");
        return;
      }
      value = raw === "true";
    } else if (typeof current === "number") {
      value = Number(raw);
      if (!Number.isFinite(value)) {
        notify(ctx, `${group}.${key} takes a number.`, "warning");
        return;
      }
    } else if (Array.isArray(current)) {
      try {
        value = JSON.parse(raw);
      } catch {
        value = null;
      }
      if (!Array.isArray(value)) {
        notify(ctx, `${group}.${key} takes a JSON array, e.g. [".git", "node_modules"].`, "warning");
        return;
      }
    } else {
      // A string option is an enum: `/ts native on` writes "auto", so `native.mode=on` means the
      // same thing rather than a second word for one setting.
      value = normalizeOptionValue(group, key, raw);
      if (!value) {
        const allowed = OPTION_VALUES[group]?.[key] ?? [];
        notify(ctx, `${group}.${key} takes ${allowed.join(" | ")} (on and true mean auto).`, "warning");
        return;
      }
    }

    const result = writeConfig({ options: { [group]: { [key]: value } } });
    if (!reportWrite(ctx, result)) return;
    // An option is read live, so one that changes what a knob means changes the row too: the
    // threshold limits are the pair the `threshold` token reports, and the row would otherwise keep
    // describing the previous setting until something else republished the state.
    if (group === "threshold") render(ctx);
    notify(
      ctx,
      `${group}.${key} = ${JSON.stringify(result.config.options[group][key])} · Config: ${CONFIG_FILE}\n` +
        "Applies to new sessions (options describe behaviour, not intensity).",
      "info"
    );
  }

  async function applyNativeVerb(arg, ctx) {
    const text = String(arg || "").trim().toLowerCase();
    if (!text || text === "status") {
      await nativeStatus(ctx);
      return;
    }
    if (text === "on" || text === "auto") {
      if (!reportWrite(ctx, writeConfig({ options: { native: { mode: "auto" } } }))) return;
      notify(ctx, "Native OMP settings: auto — a preset or a knob change now also writes its config.yml keys.", "info");
      return;
    }
    if (text === "off") {
      if (!reportWrite(ctx, writeConfig({ options: { native: { mode: "off" } } }))) return;
      notify(ctx, "Native OMP settings: off — presets no longer touch config.yml (/ts native apply still does).", "info");
      return;
    }
    if (text === "apply") {
      await applyNative(ctx, true);
      return;
    }
    if (text === "reset") {
      await resetNative(ctx, "reset");
      return;
    }
    notify(ctx, "Usage: /ts native [on|off|apply|reset|status]", "warning");
  }

  // Wrap routes the *session's* provider at a proxy the pack starts, and unwrap puts it back. Neither
  // touches a file: `pi.registerProvider(id, {baseUrl})` is a runtime override that outranks models.yml
  // and the bundled catalog for that provider, so the switch is instant and reversible, and it works
  // for whichever provider/family this session is on.
  // Wraps and reports the outcome as a boolean, so the caller owns the one place that publishes the
  // knob's effective value: every failure path here ends unrouted, and the row has to say so.
  // `quiet` suppresses only the success banner — a session that re-wraps itself on start needs no
  // narration (the row carries the state), while every refusal still has to be visible.
  async function performWrap(ctx, options = {}) {
    const route = sessionRoute(ctx);
    if (!route) {
      notify(ctx, "No model is resolved for this session yet, so there is nothing to route.", "warning");
      return false;
    }
    if (!route.family) {
      notify(
        ctx,
        `Headroom has no upstream flag for api "${route.api || "unknown"}" (provider ${route.provider}), so this ` +
          "session cannot be routed through the proxy. Routable families: " +
          `${Object.keys(HEADROOM_FAMILIES).join(", ")}.`,
        "warning"
      );
      return;
    }
    if (!route.baseUrl) {
      notify(ctx, `Provider ${route.provider} reports no baseUrl, so headroom has no upstream to forward to.`, "warning");
      return false;
    }

    const state = readHeadroomState();
    const port = headroomPort();
    const proxyBase = proxyBaseUrl(port, route.family);

    let health = await headroomHealth(port);
    let started = false;
    let pid = state?.pid ?? null;
    if (health.up) {
      // A proxy is already running. It may belong to another session (or to `headroom wrap omp`) with
      // its own upstream, so check before sending this session's traffic — and its credentials — there.
      const configured = health.config?.[route.family.health];
      if (configured && configured !== route.baseUrl) {
        notify(
          ctx,
          `A proxy is already up on ${port} forwarding ${route.family.health} to ${configured}, not ${route.baseUrl}.\n` +
            "Refusing to route this session through the wrong upstream. Stop that proxy, or route this provider " +
            `by hand: /ts option headroom.port=<free port>.`,
          "warning"
        );
        return false;
      }
    } else {
      const launched = await startHeadroomProxy(port, route.family.flag, route.baseUrl);
      health = launched.health;
      started = true;
      pid = launched.pid ?? null;
      if (!health.up) {
        notify(
          ctx,
          `Headroom proxy did not come up on ${port} (${health.reason || "no health"}).\n` +
            `Log: ${HEADROOM_LOG_FILE}\nNothing was rerouted, so this session is unchanged.`,
          "warning"
        );
        return false;
      }
    }

    pi.registerProvider(route.provider, { baseUrl: proxyBase });
    // Registering changes the *registry's* model list; the session already holds a resolved Model, so
    // it has to be handed the re-resolved one — the same step `/model` takes, and the only one that
    // makes the next request use the new endpoint. Reading it back afterwards is the difference
    // between "the override is in place" and "this session is actually routed".
    const selector = `${route.provider}/${route.modelId}`;
    const resolved = ctx?.models?.resolve?.(selector);
    const level = pi.getThinkingLevel?.();
    const switched = resolved ? await pi.setModel?.(resolved) : false;
    if (pi.setThinkingLevel && level && pi.getThinkingLevel?.() !== level) pi.setThinkingLevel(level);

    const live = sessionRoute(ctx);
    const routed = live?.baseUrl === proxyBase;
    writeHeadroomState({
      port,
      provider: route.provider,
      api: route.api,
      upstream: route.baseUrl,
      proxyBase,
      startedByPack: started,
      pid,
      at: new Date().toISOString(),
    });

    if (!options.quiet || !routed) {
      notify(
        ctx,
        `Headroom: ${route.provider} now routes through the proxy.\n` +
          `omp → ${proxyBase} → ${route.baseUrl}\n` +
          `Registry override: written · session model switched: ${switched ? "yes" : "no"}` +
          `\nRouting read back from the registry: ${routed ? `yes (${live.baseUrl})` : `NO — still ${live?.baseUrl || "unset"}`}` +
          `\nProxy: ${started ? "started by the pack" : `reused the one already on ${port}`}` +
          `\nUndo: /ts headroom unwrap`,
        routed ? "info" : "warning"
      );
    }
    return routed;
  }

  // The knob's effective value is published in exactly one place: whatever the wrap managed to do.
  async function headroomWrap(ctx, options) {
    const routed = await performWrap(ctx, options);
    setSharedMode("headroom", routed ? "on" : "off");
    return routed;
  }

  async function headroomUnwrap(ctx) {
    const state = readHeadroomState();
    const route = sessionRoute(ctx);
    const port = headroomPort();
    // Read the routing off the session rather than off our own bookkeeping: a state file deleted by
    // hand must not leave a provider pointed at a dead proxy, and a provider that was never routed
    // must not be "unrouted" either.
    const proxyBase = route?.family ? proxyBaseUrl(port, route.family) : "";
    const routed = Boolean(route && proxyBase && route.baseUrl === proxyBase);
    const lines = [];

    if (routed) {
      try {
        pi.unregisterProvider?.(route.provider);
        // Mirror of wrap: drop the registry override, then hand the session the re-resolved model so
        // the next request leaves the proxy.
        const resolved = ctx?.models?.resolve?.(`${route.provider}/${route.modelId}`);
        const level = pi.getThinkingLevel?.();
        const switched = resolved ? await pi.setModel?.(resolved) : false;
        if (pi.setThinkingLevel && level && pi.getThinkingLevel?.() !== level) pi.setThinkingLevel(level);
        const after = sessionRoute(ctx)?.baseUrl;
        lines.push(
          `Routing removed for ${route.provider}${switched ? "" : " (session model not re-resolved)"}: ${
            after && after !== proxyBase ? `back to ${after}` : `back to ${state?.upstream || "its own endpoint"}`
          }`
        );
      } catch (error) {
        lines.push(`Routing not removed: ${shortError(error)}`);
      }
    } else {
      lines.push(
        route
          ? `Nothing to unroute: ${route.provider} is not pointed at a proxy (${route.baseUrl || "no baseUrl"}).`
          : "Nothing to unroute: no model resolved for this session."
      );
    }

    if (state?.startedByPack && state?.pid) {
      try {
        process.kill(state.pid);
        // A killed pid is not a stopped proxy: report what the port says, since a proxy that survived
        // would keep carrying (or blocking) this machine's traffic.
        let down = false;
        for (let attempt = 0; attempt < 5 && !down; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          down = !(await headroomHealth(state.port)).up;
        }
        lines.push(
          down
            ? `Proxy stopped (pid ${state.pid}) — the pack only stops a proxy it started.`
            : `Proxy pid ${state.pid} was signalled but port ${state.port} still answers — check \`headroom doctor\`.`
        );
      } catch (error) {
        lines.push(`Proxy not stopped (pid ${state.pid}): ${shortError(error)}`);
      }
    } else if (state?.port) {
      lines.push(`Proxy on ${state.port} left running — it was not started by the pack.`);
    }
    clearHeadroomState();
    setSharedMode("headroom", "off");
    notify(ctx, lines.join("\n"), "info");
  }

  async function headroomVerb(arg, ctx) {
    const verb = String(arg || "").trim().split(/\s+/)[0].toLowerCase();

    if (!verb || verb === "status") {
      notify(ctx, await headroomStatusText(pi, ctx), "info");
      return;
    }
    if (verb === "wrap") {
      await headroomWrap(ctx);
      return;
    }
    if (verb === "unwrap") {
      await headroomUnwrap(ctx);
      return;
    }
    // `headroom unwrap omp` restores the models.yml a *durable* wrap wrote — a different mechanism from
    // ours, and the only piece of it we may safely touch in-session.
    if (verb === "unwrap-models") {
      try {
        const printed = await execHeadroom(pi, ["unwrap", "omp"]);
        notify(ctx, `headroom unwrap omp: ${printed || "done (no output)"}\nmodels.yml: ${headroomWrapState().file}`, "info");
      } catch (error) {
        notify(ctx, `headroom unwrap omp failed: ${clip(error?.message || error, 600)}`, "warning");
      }
      return;
    }
    if (verb === "install") {
      notify(
        ctx,
        "Refusing to run an installer here: Headroom is a Python package (its Rust core is a CPython " +
          "extension) and installing it needs a Python toolchain and an interactive shell.\n" +
          `uv: ${HEADROOM_INSTALL} (canonical)\n` +
          'pip: pip install "headroom-ai[all]"\n' +
          "Docker: docker pull ghcr.io/headroomlabs-ai/headroom:latest\n" +
          "Windows: the prebuilt wheel works as-is; a source build needs MSVC + Rust.",
        "info"
      );
      return;
    }
    notify(ctx, "Usage: /ts headroom [status|wrap|unwrap|unwrap-models|install]", "warning");
  }

  async function dispatch(arg, ctx, presetOnly) {
    const text = String(arg || "").trim();
    const head = text.split(/\s+/)[0].toLowerCase();
    const rest = text.slice(head.length).trim();

    // A bare `/ts` / `/token-saver` is "configure this", so it opens the menu; `status` is the verb
    // that prints the text. `/combo` keeps its pre-2.0 preset-only surface, and a session with no
    // selector (subagent, print, RPC) keeps getting the status text an agent can read.
    if (!head) {
      if (presetOnly || !menuUi(ctx)) notify(ctx, statusText(), "info");
      else await settingsMenu(ctx);
      return;
    }
    if (head === "status") {
      notify(ctx, statusText(), "info");
      return;
    }
    if (head === "help") {
      notify(ctx, usageText(), "info");
      return;
    }

    const preset = normalizePreset(head);
    if (preset) {
      await applyPreset(preset, ctx);
      return;
    }

    // `/combo` predates the knob set and only ever spoke presets (`/combo max`, `/combo default lite`),
    // so it keeps accepting presets and `default` — the pre-2.0 command surface — and refuses the
    // newer knobs rather than half-supporting them.
    if (head === "preset") {
      await applyPreset(rest, ctx);
      return;
    }
    if (head === "default") {
      applyDefault(rest, ctx);
      return;
    }

    if (presetOnly) {
      notify(ctx, `Unknown preset: ${head}. Use: ${PRESET_NAMES.join(" | ")}, or /ts help.`, "warning");
      return;
    }

    if (head === "set") {
      await applySet(rest, ctx);
      return;
    }
    // The menu is not a `/combo` verb — it sits past the preset-only gate above, so `/combo config`
    // still reports an unknown preset instead of opening a surface that command never had.
    if (head === "config" || head === "settings") {
      await settingsMenu(ctx);
      return;
    }
    if (head === "option") {
      applyOption(rest, ctx);
      return;
    }
    if (head === "native") {
      await applyNativeVerb(rest, ctx);
      return;
    }
    if (head === "headroom") {
      await headroomVerb(rest, ctx);
      return;
    }
    notify(ctx, `Unknown command: ${head}. ${usageText()}`, "warning");
  }

  // `/token-saver` and `/ts` are the same surface; `/combo` stays as a preset-only alias so an
  // existing muscle memory (and the pre-2.0 help text) keeps working.
  const handler = async (args, ctx) => {
    if (ctx) activeCtx = ctx;
    await dispatch(args, ctx, false);
  };

  pi.registerCommand("token-saver", {
    description: "Supreme Token Saver: open the settings menu (presets, knobs, native OMP settings)",
    handler,
  });

  pi.registerCommand("ts", {
    description: "Alias for /token-saver",
    handler,
  });

  pi.registerCommand("combo", {
    description: `Set every token-saving knob at once. Usage: /combo <${PRESET_NAMES.join("|")}|status>`,
    handler: async (args, ctx) => {
      if (ctx) activeCtx = ctx;
      await dispatch(args, ctx, true);
    },
  });

  pi.on("session_start", onSession);
  pi.on("session_branch", onSession);
  pi.on("session_tree", onSession);
  pi.on("agent_start", onSession);
}
