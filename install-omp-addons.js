#!/usr/bin/env node
// install-omp-addons.js — Install the Supreme Token Saver add-ons on any OMP device.
// Usage: node install-omp-addons.js [install|update|reinstall|doctor|uninstall|plugin|version|help] [options]
// Requires: node/npm and omp CLI

import https from "node:https";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import readline from "node:readline";

const IS_WINDOWS = process.platform === "win32";
const HOME = process.env.HOME || process.env.USERPROFILE || "";

// Scope codes for the user/project/both choices, shared by the install, reinstall, and uninstall
// paths so all three agree on what a scope name means.
const SCOPE_CODES = { user: "1", project: "2", both: "3" };

const PACKAGE_NAME = "@dillydalli3r/oh-my-pi-supreme-token-saver";
const PACKAGE_BIN = "oh-my-pi-supreme-token-saver";
// Fallback source for `update` while the fork is not published under PACKAGE_NAME yet.
const GIT_SOURCE = "github:dillydalli3r/oh-my-pi-supreme-token-saver";
// Ponytail session default: ultra keeps a fresh session identical to `/token-saver preset max`.
const PONYTAIL_DEFAULT_MODE = "ultra";
const { version: PACKAGE_VERSION } = createRequire(import.meta.url)("./package.json");

// --- CLI flags ---

const args = process.argv.slice(2);
// Flags that consume the next argv entry: without this the value ("user", "max") reads as a command.
const VALUE_FLAGS = new Set(["--scope", "--preset"]);
const COMMANDS = new Set(["install", "update", "reinstall", "doctor", "uninstall", "plugin", "version", "help"]);
const commandArg = args.find((arg, index) => !arg.startsWith("-") && !VALUE_FLAGS.has(args[index - 1]));
const command = commandArg?.toLowerCase() || null;
const unknownCommand = command !== null && !COMMANDS.has(command);
const install = command === "install";
const update = command === "update";
const reinstall = command === "reinstall";
const showVersion = command === "version" || args.includes("--version") || args.includes("-v");
const showHelp = command === "help" || args.includes("--help") || args.includes("-h");
const applyUpdate = args.includes("--apply-update");
const dryRun = args.includes("--dry-run");
const yes = args.includes("--yes") || args.includes("-y") || install || update || reinstall || applyUpdate;
const verbose = args.includes("--verbose");
const doctor = command === "doctor" || args.includes("--doctor");
const uninstall = command === "uninstall" || args.includes("--uninstall");
const pluginInstall = command === "plugin";
const removePonytail = args.includes("--remove-ponytail");
const removeRtk = args.includes("--remove-rtk");
// Covers two refusals: a scope that would register the same extensions twice (D6) and the plugin
// verb when a legacy tree is still installed.
const force = args.includes("--force");
// Uninstall cutover mode: legacy tree and its config.yml entries only, never ~/.omp/plugins or rtk.
const legacyOnly = args.includes("--legacy-only");

const forcePreset = args.includes("--force-preset");

// `--preset max` and `--preset=max` both work, matching how --scope is read.
const presetFlag = (() => {
  const inline = args.find((arg) => arg.startsWith("--preset="));
  if (inline) return inline.slice("--preset=".length).trim() || null;
  const i = args.indexOf("--preset");
  if (i === -1) return null;
  return args[i + 1]?.trim() || null;
})();

const scopeFlag = (() => {
  // Accept both `--scope user` and `--scope=user`; the inline form used to be ignored silently,
  // which installed user-scope when the caller asked for project-scope.
  const inline = args.find((arg) => arg.startsWith("--scope="));
  if (inline) return inline.slice("--scope=".length).toLowerCase() || null;
  const i = args.indexOf("--scope");
  if (i === -1) return null;
  return args[i + 1]?.toLowerCase() || null;
})();

function printHelp() {
  console.log(`Usage: ${PACKAGE_BIN} [command] [options]

Commands:
  install      Install the add-ons (user scope by default)
  update       Run the latest installer (npm package, else the GitHub source)
  reinstall    Clean and reinstall the user-scope add-ons
  doctor       Check the current installation
  uninstall    Remove the managed extensions
  plugin       Plugin layout: install only the runtime dependencies
               (the Ponytail plugin and the rtk binary). No extension
               copying and no config.yml edits — the marketplace
               provides those. Refuses while a legacy tree is installed.
  version      Print the package version
  help         Show this help

Options:
  --scope user|project|both    Install scope (default user). A scope that would
                               leave the same extensions in both the CWD tree
                               and the user tree is refused (omp discovers
                               both, so /caveman and /rtk register twice)
  --force                      Proceed despite that refusal, or install the
                               plugin layout over a legacy tree
  --legacy-only                Uninstall: cutover mode. Remove the legacy
                               extensions tree and its config.yml entries only,
                               and never touch ~/.omp/plugins or the rtk binary.
                               This is the safe step before the plugin verb.
  --preset <off|lite|medium|high|max|ultra>
                               Default preset for new sessions; written to
                               ~/.omp/agent/token-saver.json only when that file
                               does not exist yet (add --force-preset to overwrite)
  --force-preset               Let --preset overwrite an existing token-saver.json
  --remove-ponytail            Uninstall: also drop the Ponytail plugin entry
  --remove-rtk                 Uninstall: also delete the rtk binary
  --yes, -y
  --dry-run
  --verbose
  --version, -v
  --help, -h

Legacy aliases:
  --doctor, --uninstall        Same as the doctor / uninstall commands

Internal (set by \`update\`, not a user flag):
  --apply-update               Marks the re-exec of the latest installer

The extension ships one command surface: /token-saver (alias /ts), with /combo kept
as a preset-only alias. The presets (off, lite, medium, high, max, ultra) drive all
nine knobs — caveman, rtk, ponytail, read, compress, prune, threshold, autoRtk, status.`);
}

function debug(...a) {
  if (verbose) console.log("  [debug]", ...a);
}

const RL = readline.createInterface({ input: process.stdin, output: process.stdout });
let rlOpen = true;
function ask(q) {
  return new Promise((res) => RL.question(q, (a) => { RL.close(); rlOpen = false; res(a); }));
}
function closeRL() { if (rlOpen) { RL.close(); rlOpen = false; } }

// Paths to extension source files (relative to this script)
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.join(SCRIPT_DIR, "extensions");
const SHARED_SESSION_STATE = path.join(EXT_DIR, "shared", "session-state.js");
const SHARED_STATUS_LINE = path.join(EXT_DIR, "shared", "status-line.js");
const CAVEMAN_INDEX = path.join(EXT_DIR, "caveman-session", "index.js");
const RTK_SESSION_INDEX = path.join(EXT_DIR, "rtk-session", "index.js");
const UPDATER_INDEX = path.join(EXT_DIR, "ai-addons-updater", "index.js");
const TOKEN_SAVER_DIR = path.join(EXT_DIR, "token-saver");
const TOKEN_SAVER_INDEX = path.join(TOKEN_SAVER_DIR, "index.js");
const AMANAI_REWARD_INDEX = path.join(EXT_DIR, "amanai-reward", "index.js");
// Second entry point of the same package, declared in package.json `pi.extensions`.
const AMANAI_REWARD_PI = path.join(EXT_DIR, "amanai-reward", "pi.js");
// Pre-2.0 shipped a separate combo extension directory that registered a duplicate /combo command;
// 2.0 folds that surface into token-saver. The stale directory name is spelled out once, here, so
// no other line hardcodes it.
const STALE_COMBO_DIRNAME = "combo-toggle";
const MODE_REINFORCEMENT_INDEX = path.join(EXT_DIR, "shared", "mode-reinforcement.js");
const CAVEMAN_REMOTE_RULE = "https://raw.githubusercontent.com/JuliusBrussee/caveman/main/src/rules/caveman-activate.md";
const RTK_RELEASE_API = "https://api.github.com/repos/rtk-ai/rtk/releases/latest";

// The runtime's version stamp lives in the extensions dir it sits in; the installed marketplace copy
// sits at ~/.omp/plugins/node_modules/<PLUGIN_DIRNAME>. Both halves of the rename are matched by slug
// while the published name settles.
const STAMP_FILE = ".omp-token-saver-version";
const PLUGIN_DIRNAME = "@dillydalli3r/omp-supreme-token-saver";
const SUPREME_TOKEN_SAVER_SLUG = /supreme-token-saver$/;

// Mirrors PRESET_NAMES / DEFAULT_PRESET in extensions/shared/session-state.js. Duplicated instead of
// imported so `--version`, `help`, and a dry run never depend on the extension tree loading.
const PRESET_NAMES = ["off", "lite", "medium", "high", "max", "ultra"];
const DEFAULT_PRESET = "max";

// --- Helpers ---

async function sha256File(filePath) {
  // Streamed: the RTK archives are tens of MB and hashing used to hold the whole file in memory.
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function readIfExists(p) {
  try { return await fs.readFile(p, "utf8"); } catch { return null; }
}

// readIfExists reads files only — an existing directory makes it throw and report "missing".
async function dirExists(p) {
  try { return (await fs.stat(p)).isDirectory(); } catch { return false; }
}

function parseChecksum(checksumsText, assetName) {
  for (const line of checksumsText.split(/\r?\n/)) {
    const match = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (match && path.basename(match[2]) === assetName) {
      return match[1].toLowerCase();
    }
  }
  return null;
}

// Every request here is one-shot, so keep-alive is off: Node's global agent pools the finished
// socket and the process then sits alive after the last line prints (measured ~29s on Windows
// before the shell prompt returns). A stalled connection also has to fail, not hang the install.
const HTTP_AGENT = new https.Agent({ keepAlive: false });
const HTTP_TIMEOUT_MS = 30000;
// Redirects are followed by hand, so the hop count must be bounded: a redirect loop would otherwise
// recurse until the stack or the network gives up.
const MAX_REDIRECTS = 5;

function httpsRequest(url, onResponse) {
  const req = https.get(
    url,
    { headers: { "User-Agent": "omp-supreme-token-saver" }, agent: HTTP_AGENT },
    onResponse
  );
  req.setTimeout(HTTP_TIMEOUT_MS, () => req.destroy(new Error(`timed out after ${HTTP_TIMEOUT_MS}ms: ${url}`)));
  return req;
}

async function httpsGet(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) {
          return reject(new Error(`too many redirects (${MAX_REDIRECTS}): ${url}`));
        }
        httpsGet(new URL(res.headers.location, url).href, redirects + 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", reject);
  });
}

async function httpsDownload(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) {
          return reject(new Error(`too many redirects (${MAX_REDIRECTS}): ${url}`));
        }
        httpsDownload(new URL(res.headers.location, url).href, dest, redirects + 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const file = createWriteStream(dest);
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
      file.on("error", reject);
    });
    req.on("error", reject);
  });
}

function execP(cmd, args, opts = {}) {
  return promisify(execFile)(cmd, args, {
    timeout: opts.timeout || 120000,
    encoding: "utf8",
    ...opts,
  });
}

// Windows resolves `omp`/`npm` to .exe/.cmd/.bat shims through PATHEXT, which execFile does not do,
// and Node rejects .cmd/.bat outright without a shell. Build the command line instead of passing an
// args array so a shell run does not hit Node's DEP0190 warning.
function quoteArg(arg) {
  const value = String(arg);
  return /[\s"&|<>^()%]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function execCli(command, args, opts = {}) {
  if (!IS_WINDOWS) return execP(command, args, opts);
  return execP([command, ...args].map(quoteArg).join(" "), [], { ...opts, shell: true });
}

async function writeIfChanged(dest, content, options = {}) {
  const existing = await readIfExists(dest);
  if (existing === content) {
    debug(`${dest} already up to date`);
    return false;
  }
  if (options.dryRun) {
    console.log(`  [dry-run] would write ${dest}`);
    return true;
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  if (existing !== null) {
    await fs.copyFile(dest, `${dest}.bak`);
    debug(`${path.basename(dest)} → ${path.basename(dest)}.bak`);
  }
  await fs.writeFile(dest, content, "utf8");
  console.log(`  [write] ${dest}`);
  return true;
}

// A config.yml that was written on Windows and edited elsewhere keeps CRLF. Splitting on \r?\n and
// joining on the file's own dominant EOL keeps every untouched line byte-identical (D4): the old
// code joined on \n, so one install turned a CRLF config into a mixed-ending file.
function dominantEol(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(^|[^\r])\n/g) || []).length;
  return crlf > lf ? "\r\n" : "\n";
}

// The one shape this installer needs to read back: a top-level `extensions:` sequence. Everything
// else in config.yml (providers, modelRoles, theme) is none of its business. A missing key is fine.
function extensionsSectionIsLoadable(text) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/^extensions\s*:/i.test(line)) continue;
    const inline = line.replace(/^extensions\s*:/i, "").trim();
    if (inline !== "" && !/^\[.*\]$/.test(inline)) return false;
    // A block item under a flow value (`extensions: [a]` + `  - b`) is the D3 damage: invalid YAML,
    // zero extensions loaded, and nothing on screen says so.
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j];
      if (next.trim() === "" || next.trimStart().startsWith("#")) continue;
      if (!/^\s/.test(next)) break;
      if (inline !== "") return false;
      if (!/^\s+- /.test(next)) return false;
    }
  }
  return true;
}

// `[a, "b, c"]` → ["a", '"b, c"']. Only the shapes omp writes are supported: plain scalars and
// quoted strings, split on commas outside quotes. Anything else returns null and the caller leaves
// the line alone rather than guessing at it.
function parseFlowItems(inline) {
  const trimmed = inline.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  const body = trimmed.slice(1, -1).trim();
  if (body === "") return [];
  const items = [];
  let current = "";
  let quote = null;
  for (const char of body) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    if (char === ",") { items.push(current.trim()); current = ""; continue; }
    current += char;
  }
  items.push(current.trim());
  return items.some((item) => item === "") ? null : items;
}

// D3: `extensions: [a]` is one line, so splicing `  - <path>` after it produces invalid YAML that
// silently loads zero extensions. The flow form is expanded into a block sequence first — only ever
// on a path that was already about to change the file, so a config needing no edit is never
// reformatted.
function expandFlowExtensionLines(lines) {
  const index = lines.findIndex((line) => /^extensions\s*:/i.test(line));
  if (index === -1) return;
  const inline = lines[index].replace(/^extensions\s*:/i, "").trim();
  if (inline === "" || inline === "[]") return;
  const items = parseFlowItems(inline);
  if (!items) return;
  lines.splice(index, 1, "extensions:", ...items.map((item) => `  - ${item}`));
}

// Every config.yml edit is the same three steps — read, rewrite the lines, write back — with a dry
// run reporting the same outcome instead of touching the file. `transform` returns the new lines, or
// null when there is nothing to change.
async function rewriteConfigLines(configPath, transform, options = {}) {
  const raw = await readIfExists(configPath);
  const eol = dominantEol(raw || "");
  const lines = (raw ?? "").split(/\r?\n/);
  const updated = transform(lines);

  if (!updated) {
    if (options.noChangeDebug) debug(options.noChangeDebug);
    return false;
  }

  // Message text is the caller's: "removed 2 entries" and "added the extension" differ in wording
  // and only the caller knows which one it means. A flow list expanded into a block sequence makes
  // the line delta meaningless, so it is clamped rather than handed out negative.
  const removed = Math.max(0, lines.length - updated.length);
  if (options.dryRun) {
    console.log(`  [dry-run] ${options.dryRunMessage(removed)}`);
    return true;
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true });

  // D2: config.yml is not ours alone — it holds providers, modelRoles and theme — so a crash
  // mid-write used to truncate it with no way back. Same shape as shared/session-state.js: a sibling
  // temp file renamed over the target (the rename is the only step that can leave the old file in
  // place) plus a one-time .bak that is never overwritten, so the backup always holds the state
  // before this tool's first edit.
  const backupPath = `${configPath}.bak`;
  const hadFile = raw !== null;
  if (hadFile && (await readIfExists(backupPath)) === null) await fs.copyFile(configPath, backupPath);

  const tempPath = `${configPath}.${process.pid}.tmp`;
  let text = updated.join(eol);
  try {
    await fs.writeFile(tempPath, text, "utf8");
    await fs.rename(tempPath, configPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }

  // Re-parsed after the write because that is the state omp will actually load. A file that no
  // longer reads back as an extensions sequence loads zero extensions, which is worse than not
  // having written at all, so the backup goes back.
  if (!extensionsSectionIsLoadable(text)) {
    if (hadFile) await fs.copyFile(backupPath, configPath);
    else await fs.rm(configPath, { force: true });
    console.error(`  [fail] Rewriting ${configPath} would leave an unreadable extensions section — restored the previous file.`);
    console.error("  [hint] Fix the `extensions:` block in config.yml (it must be a list of paths) and re-run.");
    process.exitCode = 1;
    return false;
  }

  console.log(`  [write] ${options.writeMessage(removed)}`);
  return true;
}

// Only a real `- <path>` entry counts as registered. A substring test also matched a commented-out
// line, which then counted as registered and the extension was silently never added.
function isRegisteredEntry(line, normalizedPath) {
  return line.trim().replace(/^-\s*/, "") === normalizedPath;
}

async function ensureExtensionInConfig(configPath, extensionPath, label, options = {}) {
  const normalizedPath = extensionPath.replace(/\\/g, "/");
  const line = `  - ${normalizedPath}`;

  return rewriteConfigLines(configPath, (lines) => {
    if (lines.some((l) => isRegisteredEntry(l, normalizedPath))) return null;

    // Flow list → block sequence before anything is spliced in, or the added line lands under a
    // flow scalar and the file stops being loadable (D3).
    expandFlowExtensionLines(lines);

    // Handle "extensions: []" (empty YAML array)
    const emptyArrayIdx = lines.findIndex((l) => /^\s*extensions\s*:\s*\[\s*\]\s*$/i.test(l));
    const extLineIdx = lines.findIndex((l) => /^\s*extensions\s*:/i.test(l));
    if (emptyArrayIdx !== -1) {
      lines[emptyArrayIdx] = "extensions:";
      lines.splice(emptyArrayIdx + 1, 0, line, "");
    } else if (extLineIdx === -1) {
      lines.push("extensions:");
      lines.push(line);
      lines.push("");
    } else {
      lines.splice(extLineIdx + 1, 0, line);
    }
    return lines;
  }, {
    dryRun: options.dryRun,
    noChangeDebug: `${label} already in config.yml`,
    dryRunMessage: () => `would add ${label} to config.yml: ${normalizedPath}`,
    writeMessage: () => `Added ${label} to config.yml`,
  });
}

async function ensureExtensionAfterConfigEntry(configPath, extensionPath, afterPath, label, options = {}) {
  const normalizedPath = extensionPath.replace(/\\/g, "/");
  const normalizedAfterPath = afterPath.replace(/\\/g, "/");
  const line = `  - ${normalizedPath}`;

  return rewriteConfigLines(configPath, (lines) => {
    const existingIndex = lines.findIndex((entry) => isRegisteredEntry(entry, normalizedPath));
    const afterIndex = lines.findIndex((entry) => isRegisteredEntry(entry, normalizedAfterPath));

    if (existingIndex !== -1 && afterIndex !== -1 && existingIndex === afterIndex + 1) return null;

    expandFlowExtensionLines(lines);

    const currentIndex = lines.findIndex((entry) => isRegisteredEntry(entry, normalizedPath));
    if (currentIndex !== -1) lines.splice(currentIndex, 1);
    const refreshedAfterIndex = lines.findIndex((entry) => isRegisteredEntry(entry, normalizedAfterPath));
    if (refreshedAfterIndex !== -1) {
      lines.splice(refreshedAfterIndex + 1, 0, line);
    } else {
      const extensionsIndex = lines.findIndex((entry) => /^\s*extensions\s*:/i.test(entry));
      if (extensionsIndex === -1) {
        lines.push("extensions:", line, "");
      } else {
        lines.splice(extensionsIndex + 1, 0, line);
      }
    }
    return lines;
  }, {
    dryRun: options.dryRun,
    dryRunMessage: () => `would place ${label} after Ponytail in config.yml: ${normalizedPath}`,
    writeMessage: () => `Placed ${label} after Ponytail in config.yml`,
  });
}

// The plugin resolves its config as $XDG_CONFIG_HOME, then %APPDATA% on Windows, then ~/.config.
// hideStatus keeps the plugin's own status row hidden: the unified one-line row from
// shared/status-line.js is the single place a mode is displayed, so the ponytail marker no longer
// depends on how the mode was set. quietStartup drops the "Ponytail loaded: <mode>" toast the
// plugin raises on session_start, which duplicated the status row on every new session.
function ponytailConfigDir() {
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, "ponytail");
  if (IS_WINDOWS) return path.join(process.env.APPDATA || path.join(HOME, "AppData", "Roaming"), "ponytail");
  return path.join(HOME, ".config", "ponytail");
}

async function ensurePonytailConfig(options = {}) {
  const configDir = ponytailConfigDir();
  const configPath = path.join(configDir, "config.json");

  if (options.dryRun) {
    console.log(`  [dry-run] would set Ponytail hideStatus=true, quietStartup=true in ${configPath} (defaultMode=${PONYTAIL_DEFAULT_MODE} only when unset)`);
    return;
  }

  let config = {};
  const existing = await readIfExists(configPath);

  if (existing) {
    try {
      config = JSON.parse(existing.replace(/^\uFEFF/, ""));
      if (!config || typeof config !== "object" || Array.isArray(config)) {
        config = {};
      }
    } catch {
      config = {};
    }
  }

  // A default chosen in-session (`/ponytail default`, `/token-saver default`) outranks the install
  // default, so only fill defaultMode in when nothing has set one.
  const seedMode = config.defaultMode === undefined ? PONYTAIL_DEFAULT_MODE : null;

  if (seedMode === null && config.hideStatus === true && config.quietStartup === true) {
    debug("Ponytail config already set");
    return;
  }

  await fs.mkdir(configDir, { recursive: true });
  if (seedMode !== null) config.defaultMode = seedMode;
  config.hideStatus = true;
  config.quietStartup = true;
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");

  console.log(`  [write] Set Ponytail defaultMode=${config.defaultMode}, hideStatus=true, quietStartup=true in ${configPath}`);
}

// --- Steps ---

// Labels are numbered at runtime because the same step function runs again for `--scope both`, so
// hardcoded "[n/7]" text goes stale the moment the install sequence changes. stepTotal is set in
// main() from the blocks that will actually run.
let stepIndex = 0;
let stepTotal = 0;
function stepHeader(label) {
  console.log(`\n[${++stepIndex}/${stepTotal}] ${label}`);
}

async function stepPonytail(pluginsDir, userDir, options = {}) {
  stepHeader("Installing Ponytail plugin...");
  // Nothing on disk during a dry run — an empty ~/.omp/plugins would still be a change.
  if (!options.dryRun) await fs.mkdir(pluginsDir, { recursive: true });
  const pkgPath = path.join(pluginsDir, "package.json");
  let pkg = {};
  const existing = await readIfExists(pkgPath);
  if (existing) {
    try {
      pkg = JSON.parse(existing);
      if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) pkg = {};
    } catch {
      console.log(`  [warn] ${pkgPath} is not valid JSON — rewriting it`);
      pkg = {};
    }
  }

  pkg.name = pkg.name || "omp-plugins";
  pkg.private = true;
  pkg.dependencies = pkg.dependencies || {};
  pkg.dependencies["@dietrichgebert/ponytail"] = "github:DietrichGebert/ponytail";

  // Through writeIfChanged: the same pkg object is rebuilt on every install, so an unchanged
  // package.json used to be rewritten and re-logged on each run.
  await writeIfChanged(pkgPath, JSON.stringify(pkg, null, 2) + "\n", options);

  if (options.dryRun) {
    console.log("  [dry-run] would run: omp plugin install github:DietrichGebert/ponytail");
    if (options.reinstall) {
      console.log("  [dry-run] would run: npm install @dietrichgebert/ponytail@latest --save --no-audit --no-fund");
    }

    const ponytailExtPath = path.join(
      pluginsDir,
      "node_modules",
      "@dietrichgebert",
      "ponytail",
      "pi-extension",
      "index.js"
    );

    // Plugin layout: the marketplace registers the pack's extension modules, so this verb must not
    // write into config.yml at all — and there is no userDir to derive one from.
    if (!options.pluginLayout) {
      await ensureExtensionInConfig(path.join(userDir, "config.yml"), ponytailExtPath, "ponytail", options);
    }
    await ensurePonytailConfig(options);
    return;
  }

  // Try omp plugin install first
  try {
    await execCli("omp", ["plugin", "install", "github:DietrichGebert/ponytail"], { cwd: pluginsDir });
    console.log("  [ok] omp plugin install ran");
  } catch (e) {
    console.log(`  [warn] omp plugin install failed: ${e.message}`);
  }

  if (options.reinstall) {
    try {
      await execCli("npm", [
        "install",
        "@dietrichgebert/ponytail@latest",
        "--save",
        "--no-audit",
        "--no-fund",
      ], { cwd: pluginsDir, timeout: 120000 });
      console.log("  [ok] Ponytail refreshed");
    } catch (e) {
      console.log(`  [fail] Could not refresh ponytail: ${e.message}`);
      console.log(`  [hint] Manual: cd ~/.omp/plugins && npm install @dietrichgebert/ponytail@latest --save --no-audit --no-fund`);
    }
  }

  // Verify the pi-extension/index.js actually exists
  const ponytailExtPath = path.join(pluginsDir, "node_modules", "@dietrichgebert", "ponytail", "pi-extension", "index.js");
  let ponytailExtExists = await readIfExists(ponytailExtPath);

  // Fallback: try bun install or npm install
  if (!ponytailExtExists) {
    console.log("  [info] pi-extension/index.js not found after omp plugin install — trying npm/bun install...");
    try {
      await execCli("npm", ["install"], { cwd: pluginsDir, timeout: 120000 });
      console.log("  [ok] npm install completed");
    } catch {
      try {
        await execP("bun", ["install"], { cwd: pluginsDir, timeout: 120000 });
        console.log("  [ok] bun install completed");
      } catch (e2) {
        console.log(`  [fail] Could not install ponytail: ${e2.message}`);
        console.log(`  [hint] Manual: cd ~/.omp/plugins && npm install`);
      }
    }
    ponytailExtExists = await readIfExists(ponytailExtPath);
  }

  // Last-resort fallback: git clone the repo into node_modules
  if (!ponytailExtExists) {
    console.log("  [info] npm/bun did not produce pi-extension — trying git clone...");
    try {
      const dest = path.join(pluginsDir, "node_modules", "@dietrichgebert", "ponytail");
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await execP("git", ["clone", "--depth", "1", "https://github.com/DietrichGebert/ponytail.git", dest],
        { timeout: 180000 });
      console.log("  [ok] git clone completed");
      ponytailExtExists = await readIfExists(ponytailExtPath);
    } catch (e3) {
      console.log(`  [fail] git clone failed: ${e3.message}`);
      console.log(`  [hint] Install git or check network: https://github.com/DietrichGebert/ponytail`);
    }
  }

  if (!ponytailExtExists) {
    console.log("  [skip] Ponytail pi-extension/index.js still not found — skill-only mode");
    console.log("  [hint] The /ponytail command won't work, but ponytail skills will still load");
    // Still set Ponytail config defaultMode=off even without the extension command
    await ensurePonytailConfig(options);
    return;
  }

  // Wire extension into config.yml so /ponytail command loads — legacy layout only: in the plugin
  // layout the marketplace owns registration.
  console.log("  [ok] Ponytail pi-extension found");
  if (!options.pluginLayout) {
    await ensureExtensionInConfig(path.join(userDir, "config.yml"), ponytailExtPath, "ponytail", options);
  }
  await ensurePonytailConfig(options);
}

async function stepRtk(binDir, options = {}) {
  stepHeader("Installing RTK binary...");

  // Map (platform, arch) → Rust triple stem.
  const PLATFORM = process.platform;
  const ARCH = process.arch;
  let assetTriple;
  if (PLATFORM === "win32" && ARCH === "x64") {
    assetTriple = "x86_64-pc-windows-msvc";
  } else if (PLATFORM === "linux" && ARCH === "x64") {
    assetTriple = "x86_64-unknown-linux-musl";
  } else if (PLATFORM === "linux" && ARCH === "arm64") {
    assetTriple = "aarch64-unknown-linux-gnu";
  } else if (PLATFORM === "darwin" && ARCH === "x64") {
    assetTriple = "x86_64-apple-darwin";
  } else if (PLATFORM === "darwin" && ARCH === "arm64") {
    assetTriple = "aarch64-apple-darwin";
  } else {
    console.log(`  [fail] Unsupported platform: ${PLATFORM}/${ARCH}`);
    console.log(`  [hint] Manual: https://github.com/rtk-ai/rtk/releases`);
    return;
  }

  const binDest = path.join(binDir, IS_WINDOWS ? "rtk.exe" : "rtk");

  // A dry run stays offline: the asset name is derivable from the platform, so the release lookup
  // (and the download it would trigger) is skipped entirely.
  if (options.dryRun) {
    console.log(`  [dry-run] would download rtk-${assetTriple}.<zip|tar.gz> from the latest GitHub release`);
    console.log(`  [dry-run] would verify checksum against checksums.txt`);
    console.log(`  [dry-run] would extract and install to ${binDest}`);
    return;
  }

  // The temp dir holds a partial download and the extracted tree; any exit from here — including a
  // throw from the download or the extraction — has to take it with it, so the cleanup is in the
  // finally rather than on each return path.
  let tmpDir = null;
  try {
    const raw = await httpsGet(RTK_RELEASE_API);
    const release = JSON.parse(raw);
    const tag = release.tag_name;

    const asset = (release.assets || []).find((a) =>
      a.name === `rtk-${assetTriple}.zip` || a.name === `rtk-${assetTriple}.tar.gz`
    );
    if (!asset) {
      console.log(`  [fail] No rtk-${assetTriple}.<zip|tar.gz> in release ${tag}`);
      console.log(`  [hint] Available: ${(release.assets || []).map((a) => a.name).filter((n) => n.startsWith("rtk-")).join(", ")}`);
      return;
    }

    // Already on the published release: skip the archive download, checksum, and extraction.
    // Any doubt about the installed version re-downloads, so this only ever skips when certain.
    const installedTag = await execP(binDest, ["--version"], { timeout: 10000 })
      .then((r) => String(r.stdout).trim().split(/\s+/).pop())
      .catch(() => null);
    if (installedTag && tag && installedTag === String(tag).replace(/^v/, "")) {
      console.log(`  [ok] ${binDest} → rtk ${installedTag} (already the latest release, skipping download)`);
      return;
    }

    // Also download checksums.txt for verification
    const checksumsAsset = (release.assets || []).find((a) => a.name === "checksums.txt");
    let checksumsText = null;
    if (checksumsAsset) {
      try {
        checksumsText = await httpsGet(checksumsAsset.browser_download_url);
      } catch (e) {
        debug(`Could not download checksums.txt: ${e.message}`);
      }
    }

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rtk-"));
    const archivePath = path.join(tmpDir, asset.name);

    await httpsDownload(asset.browser_download_url, archivePath);

    // Verify checksum
    if (checksumsText) {
      const expected = parseChecksum(checksumsText, asset.name);
      const actual = await sha256File(archivePath);
      if (!expected) {
        console.log(`  [warn] checksums.txt missing entry for ${asset.name} — skipping verification`);
      } else if (actual !== expected) {
        console.log(`  [fail] Checksum mismatch for ${asset.name}`);
        console.log(`  [fail] Expected: ${expected}`);
        console.log(`  [fail] Got:      ${actual}`);
        return;
      } else {
        console.log(`  [ok] Checksum verified for ${asset.name}`);
      }
    } else {
      console.log(`  [warn] No checksums.txt available — skipping verification`);
    }

    // Extract by extension (not OS)
    const extractDir = path.join(tmpDir, "extracted");
    await fs.mkdir(extractDir, { recursive: true });

    if (asset.name.endsWith(".zip")) {
      if (IS_WINDOWS) {
        await execP("powershell", ["Expand-Archive", "-Path", archivePath, "-DestinationPath", extractDir, "-Force"],
          { timeout: 60000 });
      } else {
        await execP("unzip", [archivePath, "-d", extractDir], { timeout: 60000 });
      }
    } else if (asset.name.endsWith(".tar.gz") || asset.name.endsWith(".tgz")) {
      try {
        await execP("tar", ["xzf", archivePath, "-C", extractDir], { timeout: 60000 });
        debug("tar xzf ok");
      } catch (e) {
        debug(`tar xzf failed: ${(e.stderr||e.message||"").trim().slice(0,200)}`);
        try {
          await execP("sh", ["-c", `gunzip < "${archivePath}" | tar xf - -C "${extractDir}"`], { timeout: 60000 });
          debug("gunzip|tar fallback ok");
        } catch (e2) {
          debug(`gunzip|tar fallback failed: ${(e2.stderr||e2.message||"").trim().slice(0,200)}`);
        }
      }
    } else {
      console.log(`  [fail] Unknown archive format: ${asset.name}`);
      return;
    }

    // Find binary
    const binaryName = IS_WINDOWS ? "rtk.exe" : "rtk";
    const entries = await fs.readdir(extractDir, { recursive: true });
    debug(`extracted entries: ${entries.join(", ")}`);
    const found = entries.find((e) => path.basename(e) === binaryName);
    if (!found) {
      console.log(`  [fail] Could not find ${binaryName} in extracted archive`);
      return;
    }

    await fs.mkdir(path.dirname(binDest), { recursive: true });
    await fs.copyFile(path.join(extractDir, found), binDest);
    console.log(`  [write] ${binDest}`);

    // Set executable bit on Unix
    if (!IS_WINDOWS) {
      await fs.chmod(binDest, 0o755);
      debug(`chmod 755 ${binDest}`);
    }

    // Verify
    try {
      const v = (await execP(binDest, ["--version"], { timeout: 10000, shell: false })).stdout.trim();
      console.log(`  [ok] ${binDest} → ${v}`);
    } catch {
      console.log(`  [hint] Verify manually: ${binDest} --version`);
    }

  } catch (e) {
    console.log(`  [fail] RTK: ${e.message}`);
    console.log(`  [hint] Manual: https://github.com/rtk-ai/rtk/releases`);
  } finally {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// The step functions below take their file text from the caller: `--scope both` installs the same
// sources into two trees, and re-reading them per scope was pure duplicate work.
async function stepSharedSessionState(extDir, sources, options = {}) {
  stepHeader("Installing shared session state and status line...");
  if (!sources.sessionState) {
    console.log("  [skip] shared/session-state.js not found in repo");
  } else {
    await writeIfChanged(path.join(extDir, "shared", "session-state.js"), sources.sessionState, options);
  }

  if (!sources.statusLine) {
    console.log("  [skip] shared/status-line.js not found in repo");
    return;
  }
  await writeIfChanged(path.join(extDir, "shared", "status-line.js"), sources.statusLine, options);
}

async function stepModeReinforcement(extDir, ponytailExtPath, options = {}) {
  stepHeader("Installing mode reinforcement extension...");
  const src = await readIfExists(MODE_REINFORCEMENT_INDEX);
  if (!src) {
    console.log("  [skip] shared/mode-reinforcement.js not found in repo");
    return;
  }
  const dest = path.join(extDir, "shared", "mode-reinforcement.js");
  await writeIfChanged(dest, src, options);
  await ensureExtensionAfterConfigEntry(path.join(path.dirname(extDir), "config.yml"), dest, ponytailExtPath, "mode reinforcement", options);
}

async function stepRtkSession(extDir, sources, options = {}) {
  stepHeader("Installing RTK session extension...");
  if (!sources.rtkSession) {
    console.log("  [skip] rtk-session/index.js not found in repo");
    return;
  }
  const dest = path.join(extDir, "rtk-session", "index.js");
  await writeIfChanged(dest, sources.rtkSession, options);
}

async function stepCaveman(extDir, sources, options = {}) {
  stepHeader("Installing Caveman session extension...");
  const cavemanDir = path.join(extDir, "caveman-session");
  if (!options.dryRun) await fs.mkdir(cavemanDir, { recursive: true });

  // sources.cavemanRule is the bundled rule unless main() already replaced it with the remote copy.
  await writeIfChanged(path.join(cavemanDir, "rule.md"), sources.cavemanRule, options);

  // Write index.js
  if (!sources.cavemanIndex) {
    console.log("  [skip] caveman-session/index.js not found in repo");
    return;
  }
  await writeIfChanged(path.join(cavemanDir, "index.js"), sources.cavemanIndex, options);

  // Write updater
  if (sources.updater) {
    const updaterDest = path.join(extDir, "ai-addons-updater", "index.js");
    await writeIfChanged(updaterDest, sources.updater, options);
  } else {
    console.log("  [skip] ai-addons-updater/index.js not found in repo");
  }
}

// 2.0 install steps, in the order main() runs them for user scope: 1 shared session state,
// 2 Ponytail, 3 RTK binary, 4 RTK session, 5 Caveman, 6 Token Saver (session knobs + the
// /token-saver command surface), 7 mode reinforcement, 8 Amanai reward, 9 defaults file.
async function stepTokenSaver(extDir, options = {}) {
  stepHeader("Installing Token Saver extension...");
  const configPath = path.join(path.dirname(extDir), "config.yml");

  // Pre-2.0 installs left the old combo directory behind, which registers a second /combo command
  // next to the one token-saver now owns. Remove it rather than let OMP load both.
  const staleDir = path.join(extDir, STALE_COMBO_DIRNAME);
  if (await dirExists(staleDir)) {
    if (options.dryRun) {
      console.log(`  [dry-run] would remove ${staleDir}`);
    } else {
      await fs.rm(staleDir, { recursive: true, force: true });
      console.log(`  [remove] ${staleDir}`);
    }
  }

  // The same install also listed it in config.yml. A dangling entry there still gets loaded, so the
  // line goes even when the directory was already gone.
  await rewriteConfigLines(configPath, (lines) => {
    expandFlowExtensionLines(lines);
    const kept = lines.filter((l) => !l.includes(STALE_COMBO_DIRNAME));
    return kept.length === lines.length ? null : kept;
  }, {
    dryRun: options.dryRun,
    dryRunMessage: (removed) => `would remove ${removed} ${STALE_COMBO_DIRNAME} entries from config.yml`,
    writeMessage: (removed) => `Removed ${removed} ${STALE_COMBO_DIRNAME} entries from config.yml`,
  });

  const src = await readIfExists(TOKEN_SAVER_INDEX);
  if (!src) {
    console.log("  [skip] token-saver/index.js not found in repo");
    return;
  }
  const dest = path.join(extDir, "token-saver", "index.js");
  await writeIfChanged(dest, src, options);

  // Register the command surface explicitly so /token-saver works without a manual config.yml edit.
  await ensureExtensionInConfig(configPath, dest, "token-saver", options);
}

// The file a fresh session reads its defaults from. OMP_TOKEN_SAVER_CONFIG wins, matching
// CONFIG_FILE in extensions/shared/session-state.js.
function tokenSaverConfigPath() {
  return process.env.OMP_TOKEN_SAVER_CONFIG || path.join(HOME, ".omp", "agent", "token-saver.json");
}

// First run only: seed the default preset. An existing file is the user's choice and is left alone
// unless --preset came with --force-preset, so an update never resets a session preset.
async function stepTokenSaverConfig(options = {}) {
  stepHeader("Seeding the Token Saver defaults file...");
  const configPath = tokenSaverConfigPath();
  const preset = options.preset || DEFAULT_PRESET;
  const exists = (await readIfExists(configPath)) !== null;

  if (exists && !(options.preset && options.forcePreset)) {
    console.log(`  [info] ${configPath} already exists — left as-is (change it in-session with /token-saver preset <name>)`);
    return;
  }

  if (options.dryRun) {
    console.log(`  [dry-run] would write ${configPath} with preset "${preset}"`);
    return;
  }

  await writeIfChanged(configPath, `${JSON.stringify({ version: 2, preset }, null, 2)}\n`, options);
}

async function stepAmanaiReward(extDir, sources, options = {}) {
  stepHeader("Installing Amanai reward detector...");
  if (!sources.amanaiReward) {
    console.log("  [skip] amanai-reward/index.js not found in repo");
    return;
  }
  await writeIfChanged(path.join(extDir, "amanai-reward", "index.js"), sources.amanaiReward, options);

  // package.json declares pi.js as the package's second entry point; copying only index.js left that
  // declared entry pointing at a file the install never wrote.
  if (!sources.amanaiRewardPi) {
    console.log("  [skip] amanai-reward/pi.js not found in repo");
    return;
  }
  await writeIfChanged(path.join(extDir, "amanai-reward", "pi.js"), sources.amanaiRewardPi, options);
}

// --- Doctor ---

// Every file the installer owns, as [label, installed path, repo source]. Doctor hashes both sides:
// an existence probe passes while an installed copy has drifted from the repo (D7), which is exactly
// how a stale caveman-session/rule.md stayed invisible.
function managedFiles(extDir) {
  return [
    ["Shared session bridge", path.join(extDir, "shared", "session-state.js"), SHARED_SESSION_STATE],
    ["Unified status line", path.join(extDir, "shared", "status-line.js"), SHARED_STATUS_LINE],
    ["Mode reinforcement extension", path.join(extDir, "shared", "mode-reinforcement.js"), MODE_REINFORCEMENT_INDEX],
    ["Caveman extension", path.join(extDir, "caveman-session", "index.js"), CAVEMAN_INDEX],
    ["Caveman rule.md", path.join(extDir, "caveman-session", "rule.md"), path.join(path.dirname(CAVEMAN_INDEX), "rule.md")],
    ["RTK extension", path.join(extDir, "rtk-session", "index.js"), RTK_SESSION_INDEX],
    ["Token Saver extension", path.join(extDir, "token-saver", "index.js"), TOKEN_SAVER_INDEX],
    ["Updater extension", path.join(extDir, "ai-addons-updater", "index.js"), UPDATER_INDEX],
    ["Amanai reward detector", path.join(extDir, "amanai-reward", "index.js"), AMANAI_REWARD_INDEX],
    ["Amanai reward pi entry", path.join(extDir, "amanai-reward", "pi.js"), AMANAI_REWARD_PI],
  ];
}

async function sha256OrNull(filePath) {
  try { return await sha256File(filePath); } catch { return null; }
}

// The runtime reads the installed version in one order (stamp file → omp-plugins.lock.json); doctor
// agrees with it rather than reporting a second, different number. This installer never writes the
// stamp, so a missing one is "unknown", not a guess from a timestamp.
function parseVersionStamp(raw) {
  if (!raw) return null;
  const text = raw.replace(/^\uFEFF/, "").trim();
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "string") return parsed || null;
    if (parsed && typeof parsed.version === "string") return parsed.version;
    return null;
  } catch {
    // The other accepted form is a bare `2.1.0` line.
    return /^v?\d[^\s]*$/.test(text) ? text : null;
  }
}

async function installedVersion(pluginsDir) {
  const stamps = [
    [path.join(HOME, ".omp", "agent", "extensions", STAMP_FILE), "stamp"],
    [path.join(pluginsDir, "node_modules", PLUGIN_DIRNAME, "extensions", STAMP_FILE), "plugin stamp"],
  ];
  for (const [file, from] of stamps) {
    const version = parseVersionStamp(await readIfExists(file));
    if (version) return { version, from };
  }

  const lockRaw = await readIfExists(path.join(pluginsDir, "omp-plugins.lock.json"));
  if (lockRaw) {
    try {
      for (const [name, entry] of Object.entries(JSON.parse(lockRaw)?.plugins ?? {})) {
        if (SUPREME_TOKEN_SAVER_SLUG.test(name) && entry?.version) {
          return { version: entry.version, from: "omp-plugins.lock.json" };
        }
      }
    } catch {
      debug("omp-plugins.lock.json is not readable JSON");
    }
  }

  return { version: null, from: null };
}

async function runDoctor() {
  console.log("\n=== OMP Supreme Token Saver Doctor ===\n");

  // Doctor has to gate CI, so every row that is expected to be ok/installed and is not counts as a
  // failure. Informational rows (Home, versions, the optional Headroom tool) pass no flag.
  let failed = 0;
  const check = (text, ok = true) => {
    if (!ok) failed += 1;
    console.log(`  ${text}`);
  };

  // Node
  check(`Node: ok ${process.version}`);

  // OMP CLI
  try {
    const v = (await execCli("omp", ["--version"])).stdout.trim();
    check(`OMP CLI: ok ${v}`);
  } catch {
    check("OMP CLI: MISSING", false);
  }

  // Home
  check(`Home: ${HOME}`);

  // Directories
  const agentDir = path.join(HOME, ".omp", "agent");
  const extDir = path.join(agentDir, "extensions");
  const configPath = path.join(agentDir, "config.yml");
  const pluginsDir = path.join(HOME, ".omp", "plugins");
  const rtkBin = path.join(HOME, ".bun", "bin", IS_WINDOWS ? "rtk.exe" : "rtk");

  // readIfExists only reads files and throws on a directory, so readdir is the probe that works.
  const agentOk = (await fs.readdir(agentDir).catch(() => null)) !== null;
  check(`OMP agent dir: ${agentOk ? "ok" : "MISSING"} ${agentDir}`, agentOk);

  const extOk = (await fs.readdir(extDir).catch(() => null)) !== null;
  check(`OMP extensions dir: ${extOk ? "ok" : "MISSING"} ${extDir}`, extOk);

  // Every managed file, hashed against the repo copy sitting next to this installer. A missing repo
  // copy (running from an npm cache) degrades to the old existence probe instead of failing.
  for (const [label, dest, source] of managedFiles(extDir)) {
    const installedHash = await sha256OrNull(dest);
    const sourceHash = await sha256OrNull(source);
    if (installedHash === null) {
      check(`${label}: MISSING ${dest}`, false);
    } else if (sourceHash === null) {
      check(`${label}: installed (no repo copy to compare)`);
    } else if (installedHash === sourceHash) {
      check(`${label}: ok`);
    } else {
      check(`${label}: drift — differs from the repo copy (re-run install --yes) ${dest}`, false);
    }
  }

  // D6: omp discovers <cwd>/.omp/extensions as well as the user tree, so a copy in both trees is the
  // same /caveman and /rtk registering twice. Doctor runs from the user's project, so it can see it.
  const projectExtDir = path.join(process.cwd(), ".omp", "extensions");
  const projectInstalled = await dirExists(path.join(projectExtDir, "caveman-session"));
  check(`Project-scope tree: ${projectInstalled ? `DUPLICATE ${projectExtDir} — /caveman and /rtk register twice` : "absent"}`, !projectInstalled);

  const version = await installedVersion(pluginsDir);
  check(`Installed version: ${version.version ?? "unknown"}${version.from ? ` (${version.from})` : " (no version stamp)"}`);

  // Read once: the config.yml checks below used to re-read the same file two more times.
  const configText = await readIfExists(configPath);
  check(`OMP config.yml: ${configText !== null ? "ok" : "MISSING"} ${configPath}`, configText !== null);

  // Ponytail
  const ponytailPkg = path.join(pluginsDir, "node_modules", "@dietrichgebert", "ponytail", "package.json");
  const ponytailExt = path.join(pluginsDir, "node_modules", "@dietrichgebert", "ponytail", "pi-extension", "index.js");
  const ponytailInstalled = (await readIfExists(ponytailPkg)) !== null;
  const ponytailExtInstalled = (await readIfExists(ponytailExt)) !== null;
  check(`Ponytail package: ${ponytailInstalled ? "installed" : "MISSING"}`, ponytailInstalled);
  check(`Ponytail extension: ${ponytailExtInstalled ? "installed" : "MISSING"}`, ponytailExtInstalled);

  if (configText !== null) {
    const hasPonytailPath = configText.includes("ponytail") && configText.includes("pi-extension");
    check(`Ponytail in config.yml: ${hasPonytailPath ? "registered" : "MISSING"}`, hasPonytailPath);
  }

  const ponytailConfigPath = path.join(ponytailConfigDir(), "config.json");
  const ponytailConfigRaw = await readIfExists(ponytailConfigPath);
  if (ponytailConfigRaw) {
    let parsed = null;
    try {
      parsed = JSON.parse(ponytailConfigRaw.replace(/^\uFEFF/, ""));
    } catch {
      parsed = null;
    }
    const row = parsed?.hideStatus === true ? "hidden (unified row)" : "visible (duplicate row)";
    const toast = parsed?.quietStartup === true ? "quiet" : "visible (startup toast)";
    check(`Ponytail config: ok defaultMode=${parsed?.defaultMode ?? "?"}, status row ${row}, startup toast ${toast}`);
  } else {
    check(`Ponytail config: MISSING ${ponytailConfigPath}`, false);
  }

  // RTK
  const rtkExists = (await readIfExists(rtkBin)) !== null;
  check(`RTK binary: ${rtkExists ? "installed" : "MISSING"} ${rtkBin}`, rtkExists);
  if (rtkExists) {
    try {
      const v = (await execP(rtkBin, ["--version"], { timeout: 5000 })).stdout.trim();
      check(`RTK version: ${v}`);
    } catch {
      check("RTK version: unavailable (may not be executable)");
    }
  }

  // RTK's own savings report, from the managed binary when it exists, else whatever `rtk` is on PATH.
  // Only the head is printed: the full table is long, and the numbers are what rtk counts locally,
  // not something this installer can verify.
  try {
    const gain = (await execCli(rtkExists ? rtkBin : "rtk", ["gain"], { timeout: 5000 })).stdout
      .split(/\r?\n/)
      .slice(0, 6)
      .join("\n")
      .trimEnd();
    check("rtk self-report: RTK's numbers are self-reported by the rtk binary, not independently verified.");
    for (const line of gain.split("\n")) console.log(`    ${line}`);
  } catch (e) {
    check(`rtk self-report: unavailable (${e.message.split("\n")[0]})`);
  }

  // Headroom is an OPTIONAL external tool: this pack never bundles, installs, or depends on it, so a
  // missing CLI is reported without failing the run. The path comes from the platform's own PATH
  // resolver (where / command -v) run through execCli — the same shell lookup the installer already
  // relies on for `omp` — rather than a second resolver in JS.
  try {
    const version = (await execCli("headroom", ["--version"], { timeout: 5000 })).stdout.trim();
    const exe = await execCli(IS_WINDOWS ? "where" : "sh", IS_WINDOWS ? ["headroom"] : ["-c", "command -v headroom"], { timeout: 5000 })
      .then((r) => r.stdout.split(/\r?\n/)[0].trim())
      .catch(() => "");
    check(`Headroom: ok ${version}${exe ? ` ${exe}` : ""}`);
  } catch {
    check("Headroom: not installed (optional)");
  }

  const modelsYml = path.join(agentDir, "models.yml");
  const modelsYmlText = await readIfExists(modelsYml);
  check(`Headroom wrap: ${modelsYmlText !== null && /headroom/i.test(modelsYmlText) ? "wrapped (models.yml anthropic baseUrl)" : "not wrapped"}`);
  console.log("    `headroom wrap omp` only redirects the anthropic provider — other providers keep their endpoints.");

  // The extension files themselves are covered by the hash loop above (managedFiles); what remains
  // here is the state that is not a managed file.
  const tokenSaverConfig = tokenSaverConfigPath();
  const tokenSaverRaw = await readIfExists(tokenSaverConfig);
  if (tokenSaverRaw) {
    let preset = "?";
    try {
      preset = JSON.parse(tokenSaverRaw.replace(/^\uFEFF/, ""))?.preset ?? "?";
    } catch {
      preset = `unreadable`;
    }
    check(`Token Saver config: ok preset=${preset} ${tokenSaverConfig}`);
  } else {
    check(`Token Saver config: MISSING (sessions fall back to ${DEFAULT_PRESET}) ${tokenSaverConfig}`, false);
  }

  // Pre-2.0 leftovers: the stale directory registers a duplicate /combo command.
  const staleComboDir = path.join(extDir, STALE_COMBO_DIRNAME);
  const noStaleCombo = !(await dirExists(staleComboDir));
  check(`${STALE_COMBO_DIRNAME} (pre-2.0): ${noStaleCombo ? "ok absent" : `STALE ${staleComboDir}`}`, noStaleCombo);

  if (configText !== null) {
    const hasTokenSaverPath = configText.includes("token-saver");
    check(`Token Saver in config.yml: ${hasTokenSaverPath ? "registered" : "MISSING"}`, hasTokenSaverPath);
    if (configText.includes(STALE_COMBO_DIRNAME)) {
      check(`[warn] config.yml still lists ${STALE_COMBO_DIRNAME} — rerun: install --yes`, false);
    }
  }

  if (failed > 0) {
    console.log(`\n${failed} check(s) failed — see the MISSING/drift/STALE rows above.`);
    process.exitCode = 1;
    return;
  }
  console.log("\nAll checks passed.");
}

// --- Uninstall ---

async function runUninstall(options = {}) {
  const confirmed = options.yes ?? yes;
  // --legacy-only is the cutover step in front of a plugin install: the legacy tree and its
  // config.yml entries go, and nothing under ~/.omp/plugins or the rtk binary is touched.
  const cutoverOnly = options.legacyOnly ?? legacyOnly;
  const shouldRemovePonytail = cutoverOnly ? false : (options.removePonytail ?? removePonytail);
  const shouldRemoveRtk = cutoverOnly ? false : (options.removeRtk ?? removeRtk);
  const shouldDryRun = options.dryRun ?? dryRun;
  // A bare `uninstall` claims to remove the managed extensions, so it takes both scopes; `reinstall`
  // passes the scope it is about to rewrite.
  const scope = options.scope ?? scopeFlag ?? "both";
  if (!SCOPE_CODES[scope]) {
    console.error(`[fail] Invalid --scope: ${scope}. Use: user, project, both`);
    process.exitCode = 1;
    return;
  }
  const removesUserScope = scope === "user" || scope === "both";
  const removesProjectScope = scope === "project" || scope === "both";

  console.log("\n=== OMP Supreme Token Saver Uninstall ===\n");
  if (cutoverOnly) console.log("Mode: --legacy-only (legacy tree + config.yml only)\n");

  const extDir = path.join(HOME, ".omp", "agent", "extensions");
  const configPath = path.join(HOME, ".omp", "agent", "config.yml");
  const rtkBin = path.join(HOME, ".bun", "bin", IS_WINDOWS ? "rtk.exe" : "rtk");
  const projectExtDir = path.join(process.cwd(), ".omp", "extensions");

  const targets = [
    ...(removesUserScope ? [
      // writeIfChanged leaves `<file>.bak` beside every file it replaces. The ones under the
      // extension directories leave with them; these two do not, so uninstall names them itself.
      path.join(extDir, "caveman-session"),
      path.join(extDir, "rtk-session"),
      path.join(extDir, "token-saver"),
      path.join(extDir, "ai-addons-updater"),
      path.join(extDir, STALE_COMBO_DIRNAME),
      path.join(extDir, "shared"),
      path.join(extDir, "amanai-reward"),
      `${tokenSaverConfigPath()}.bak`,
      // The plugin tree is the marketplace's, not the legacy layout's: a cutover leaves it alone.
      ...(cutoverOnly ? [] : [path.join(HOME, ".omp", "plugins", "package.json.bak")]),
    ] : []),
    ...(removesProjectScope ? [
      // `--scope project` mirrors five of those under the CWD — ai-addons-updater included, which
      // stepCaveman writes at both scopes and this list used to leave behind (D1), so /ai-addons
      // stayed registered on a project install that uninstall claimed to have removed.
      path.join(projectExtDir, "caveman-session"),
      path.join(projectExtDir, "rtk-session"),
      path.join(projectExtDir, "shared"),
      path.join(projectExtDir, "amanai-reward"),
      path.join(projectExtDir, "ai-addons-updater"),
    ] : []),
  ];

  console.log("Will remove:");
  for (const t of targets) {
    console.log(`  ${t}`);
  }

  if (shouldRemoveRtk) {
    console.log(`  ${rtkBin}`);
  }

  if (!confirmed) {
    const answer = await ask("\nProceed? [y/N]: ");
    if (!answer.toLowerCase().startsWith("y")) {
      console.log("Aborted.");
      closeRL();
      return;
    }
  }

  // Remove extension directories
  for (const t of targets) {
    try {
      if (shouldDryRun) console.log(`  [dry-run] would remove ${t}`);
      else {
        await fs.rm(t, { recursive: true, force: true });
        console.log(`  [rm] ${t}`);
      }
    } catch {
      debug(`Could not remove ${t}`);
    }
  }

  // Remove the token-saver registration (plus any pre-2.0 combo leftover) and mode-reinforcement;
  // Ponytail only when requested. A project-scope install never wrote these entries, so a
  // project-only uninstall leaves the user's config.yml alone.
  if (removesUserScope) {
    await rewriteConfigLines(configPath, (lines) => {
      expandFlowExtensionLines(lines);
      const kept = lines.filter((l) => {
        if (l.includes("token-saver") || l.includes(STALE_COMBO_DIRNAME) || l.includes("mode-reinforcement")) return false;
        if (shouldRemovePonytail && l.includes("ponytail") && l.includes("pi-extension")) return false;
        return true;
      });
      return kept.length === lines.length ? null : kept;
    }, {
      dryRun: shouldDryRun,
      dryRunMessage: (removed) => `would remove ${removed} config.yml entries`,
      writeMessage: (removed) => `Updated config.yml (removed ${removed} entries)`,
    });
  }

  // Remove RTK binary if requested
  if (shouldRemoveRtk) {
    try {
      if (shouldDryRun) console.log(`  [dry-run] would remove ${rtkBin}`);
      else {
        await fs.unlink(rtkBin);
        console.log(`  [rm] ${rtkBin}`);
      }
    } catch {
      debug(`Could not remove ${rtkBin}`);
    }
  }

  console.log("\nDone. Restart OMP for changes to take effect.");
}

async function runLatestUpdate() {
  const updateScope = scopeFlag || "user";
  if (!["user", "project", "both"].includes(updateScope)) {
    console.error(`[fail] Invalid --scope: ${updateScope}. Use: user, project, both`);
    process.exitCode = 1;
    return;
  }

  const forwardedArgs = ["--yes", "--scope", updateScope];
  if (dryRun) forwardedArgs.push("--dry-run");
  if (verbose) forwardedArgs.push("--verbose");

  // Prefer the published package; fall back to the GitHub source, which is the documented install
  // path while this fork is unpublished. npm 11+ needs --allow-git=all for git specifiers.
  const npmVersion = String((await execCli("npm", ["--version"]).catch(() => ({ stdout: "0" }))).stdout).trim();
  const npmMajor = Number(npmVersion.split(".")[0]) || 0;
  const sources = [
    { label: `${PACKAGE_NAME}@latest`, spec: `${PACKAGE_NAME}@latest`, extra: [] },
    { label: GIT_SOURCE, spec: GIT_SOURCE, extra: npmMajor >= 11 ? ["--allow-git=all"] : [] },
  ];

  console.log("=== Updating OMP Supreme Token Saver ===");

  let updated = false;
  for (const source of sources) {
    console.log(`  Running the latest installer from ${source.label}...\n`);
    const npmArgs = [
      "exec",
      "--yes",
      "--prefer-online",
      ...source.extra,
      `--package=${source.spec}`,
      "--",
      PACKAGE_BIN,
      "--apply-update",
      ...forwardedArgs,
    ];

    const npmCommand = IS_WINDOWS ? process.env.ComSpec || "cmd.exe" : "npm";
    const npmCommandArgs = IS_WINDOWS ? ["/d", "/s", "/c", "npm", ...npmArgs] : npmArgs;

    try {
      const result = await execP(npmCommand, npmCommandArgs, {
        timeout: 300000,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
        shell: false,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      console.log("\n=== Update complete ===");
      updated = true;
      break;
    } catch (e) {
      if (e.stdout) process.stdout.write(e.stdout);
      if (e.stderr) process.stderr.write(e.stderr);
      console.log(`  [warn] ${source.label} failed: ${e.message}\n`);
    }
  }

  if (!updated) {
    console.error(`[fail] Could not update from ${sources.map((s) => s.label).join(" or ")}`);
    console.error("[hint] Install manually: node install-omp-addons.js install --yes");
    process.exitCode = 1;
  }
}

// --- Plugin layout ---

// Every scope writes caveman-session, so its presence is what "this tree holds an install" means —
// a stale directory alone does not count.
async function treeInstalled(extDir) {
  return dirExists(path.join(extDir, "caveman-session"));
}

// D6: omp auto-discovers <cwd>/.omp/extensions *in addition to* ~/.omp/agent/extensions, so the same
// extensions in both trees register /caveman and /rtk twice. Whichever scope is already installed
// wins unless the caller insists with --force; `--scope both` is that duplication by construction.
async function duplicateScopeConflict(scope, userExtDir, projectExtDir) {
  if (scope === SCOPE_CODES.both) {
    return `--scope both installs the same extensions into ${projectExtDir} and ${userExtDir}, and omp discovers both trees — /caveman and /rtk would register twice.`;
  }
  if (scope === SCOPE_CODES.project && (await treeInstalled(userExtDir))) {
    return `A user-scope install already exists in ${userExtDir}; a project-scope copy in ${projectExtDir} would register /caveman and /rtk twice.`;
  }
  if (scope === SCOPE_CODES.user && (await treeInstalled(projectExtDir))) {
    return `A project-scope install already exists in ${projectExtDir}; a user-scope copy in ${userExtDir} would register /caveman and /rtk twice.`;
  }
  return null;
}

// Prints the refusal and reports whether the caller must stop. Shared by the install path and the
// reinstall cleanup, which has to refuse *before* it removes anything.
async function refusedDuplicateScope(scope, userExtDir, projectExtDir) {
  const conflict = await duplicateScopeConflict(scope, userExtDir, projectExtDir);
  if (!conflict || force) return false;
  console.error(`\n[fail] ${conflict}`);
  console.error("[hint] Remove the other one first: node install-omp-addons.js uninstall --scope project --yes");
  console.error("[hint] Or install into both trees on purpose with --force.");
  process.exitCode = 1;
  return true;
}

// The plugin layout takes its extension modules *and* their registration from the marketplace, so
// this verb installs only what the marketplace cannot: the Ponytail plugin and the rtk binary. No
// extension copying, no config.yml edit. It refuses to run next to a legacy tree, which would
// register the same commands twice.
async function runPluginInstall(options = {}) {
  console.log("\n=== OMP Supreme Token Saver — plugin layout ===");
  console.log("  Runtime dependencies only: the Ponytail plugin and the rtk binary.");

  const preview = options.dryRun ?? dryRun;
  const legacyExtDir = path.join(HOME, ".omp", "agent", "extensions");
  if ((await treeInstalled(legacyExtDir)) && !(options.force ?? force)) {
    // A preview changes nothing, so it reports the cutover that the real run would insist on rather
    // than refusing outright: `--dry-run` has to stay a pure preview of what would happen.
    console.error(`\n  ${preview ? "[warn]" : "[fail]"} A legacy extensions tree is installed at ${legacyExtDir}.`);
    console.error("  Next to the marketplace plugin it would register /caveman and /rtk twice.");
    console.error("  [hint] Cut over first: node install-omp-addons.js uninstall --legacy-only --yes");
    console.error("  [hint] Or keep both on purpose with --force.");
    if (!preview) {
      process.exitCode = 1;
      return;
    }
  }

  if (preview) console.log("  [dry-run] No changes will be written.\n");

  stepTotal = 2;
  // userDir is null on purpose: there is no config.yml for the plugin layout to register into.
  await stepPonytail(path.join(HOME, ".omp", "plugins"), null, { dryRun: preview, pluginLayout: true });
  await stepRtk(path.join(HOME, ".bun", "bin"), { dryRun: preview });

  console.log(`\n=== Plugin dependencies ${preview ? "preview complete" : "complete"} ===`);
  console.log("  The extension modules and their registration come from the marketplace plugin.");
}

// --- Main ---

async function main() {
  if (showVersion) {
    console.log(PACKAGE_VERSION);
    closeRL();
    return;
  }

  if (showHelp) {
    printHelp();
    closeRL();
    return;
  }

  if (unknownCommand) {
    console.error(`Unknown command: ${commandArg}`);
    printHelp();
    process.exitCode = 1;
    closeRL();
    return;
  }

  if (update && !applyUpdate) {
    await runLatestUpdate();
    closeRL();
    return;
  }

  if (presetFlag && !PRESET_NAMES.includes(presetFlag)) {
    console.error(`[fail] Invalid --preset: ${presetFlag}. Use: ${PRESET_NAMES.join(", ")}`);
    process.exitCode = 1;
    closeRL();
    return;
  }

  // Validated here, before the uninstall/reinstall branches: those run before the scope resolution
  // below, and an invalid scope has to stop them, not silently fall back to user scope.
  if (scopeFlag && !SCOPE_CODES[scopeFlag]) {
    console.error(`[fail] Invalid --scope: ${scopeFlag}. Use: user, project, both`);
    process.exitCode = 1;
    closeRL();
    return;
  }

  // Every install target is built from HOME. Without it they would silently become CWD-relative
  // paths (`.omp/agent/...`), so this has to stop before the first step runs.
  if (!HOME) {
    console.error("[fail] Neither HOME nor USERPROFILE is set — no install location to write to.");
    console.error("[hint] Set HOME (or USERPROFILE on Windows) and re-run the installer.");
    process.exitCode = 1;
    closeRL();
    return;
  }

  if (doctor) {
    await runDoctor();
    closeRL();
    return;
  }

  // Before the legacy install path: the plugin layout installs dependencies only.
  if (pluginInstall) {
    await runPluginInstall();
    closeRL();
    return;
  }

  if (uninstall) {
    await runUninstall();
    closeRL();
    return;
  }

  if (reinstall) {
    // Matches the install default when --scope is absent; an explicit --scope is honoured here and
    // again below, so `reinstall --scope project|both` no longer cleans user scope and then
    // reinstalls user scope anyway.
    const reinstallScope = scopeFlag || "user";
    // Checked before the cleanup: refusing after removing the tree would leave a half-finished
    // reinstall for a conflict that was visible from the start.
    const stop = await refusedDuplicateScope(
      SCOPE_CODES[reinstallScope],
      path.join(HOME, ".omp", "agent", "extensions"),
      path.join(process.cwd(), ".omp", "extensions"),
    );
    if (stop) {
      closeRL();
      return;
    }
    await runUninstall({ yes: true, removePonytail: false, removeRtk: true, scope: reinstallScope });
  }

  if (dryRun) console.log("[dry-run] No changes will be written.\n");

  console.log(`=== OMP Supreme Token Saver v${PACKAGE_VERSION} ===`);
  console.log(`  Platform: ${process.platform}`);
  console.log(`  Arch: ${process.arch}`);
  console.log(`  Home: ${HOME}`);

  // Determine install scope. scopeFlag was validated above, so the map cannot come back empty here.
  let scope;
  if (scopeFlag) {
    scope = SCOPE_CODES[scopeFlag];
    console.log(`  Scope: ${scopeFlag}${reinstall ? " (reinstall)" : ""}`);
  } else if (reinstall) {
    scope = SCOPE_CODES.user;
    console.log("  Scope: user (reinstall)");
  } else if (install || yes) {
    scope = "1";
    console.log(`  Scope: user (${install ? "install default" : "--scope omitted, defaulting to user with --yes"})`);
  } else {
    console.log("\nInstall scope:");
    console.log("  1) User-level (all OMP sessions)");
    console.log("  2) Project-level (this repo only)");
    console.log("  3) Both");
    scope = (await ask("\nChoose [1-3] (default 1): ")).trim() || "1";
  }

  const userDir = path.join(HOME, ".omp", "agent");
  const userExtDir = path.join(userDir, "extensions");
  const userPluginsDir = path.join(userDir, "..", "plugins");
  const bunBinDir = path.join(HOME, ".bun", "bin");
  const projectExtDir = path.join(process.cwd(), ".omp", "extensions");

  // D6: refuse a second auto-discovered tree instead of silently registering every extension twice.
  // Runs for a dry run too — the preview has to report the same refusal the real install would hit.
  if (await refusedDuplicateScope(scope, userExtDir, projectExtDir)) {
    closeRL();
    return;
  }

  // verbose/yes/scope are read as module-level flags, not off this object; only the values the steps
  // and the uninstall/reinstall paths actually look up live here.
  const options = { dryRun, reinstall, preset: presetFlag, forcePreset };

  // Check prerequisites
  console.log("\nPrerequisites:");
  try {
    const v = (await execCli("omp", ["--version"])).stdout.trim();
    console.log(`  [ok] omp ${v}`);
  } catch {
    console.log("  [fail] omp not found — ensure it's installed");
  }

  // The repo files and the remote Caveman rule are the same for both scopes: read/fetch them once
  // here instead of re-reading them for whichever scope runs second under `--scope both`.
  const sources = {
    sessionState: await readIfExists(SHARED_SESSION_STATE),
    statusLine: await readIfExists(SHARED_STATUS_LINE),
    rtkSession: await readIfExists(RTK_SESSION_INDEX),
    cavemanRule: await readIfExists(path.join(path.dirname(CAVEMAN_INDEX), "rule.md")) || "",
    cavemanIndex: await readIfExists(CAVEMAN_INDEX),
    updater: await readIfExists(UPDATER_INDEX),
    amanaiReward: await readIfExists(AMANAI_REWARD_INDEX),
    amanaiRewardPi: await readIfExists(AMANAI_REWARD_PI),
  };
  // A dry run stays offline. The bundled rule is always a valid destination, so a failed fetch falls
  // back to it instead of aborting the install with the remaining steps unrun.
  if (!dryRun) {
    try {
      sources.cavemanRule = await httpsGet(CAVEMAN_REMOTE_RULE) || sources.cavemanRule;
    } catch (e) {
      console.log(`  [warn] Could not fetch ${CAVEMAN_REMOTE_RULE} (${e.message}) — using the bundled rule`);
    }
  }

  // Install per scope. User scope plays eight steps, project scope replays four of them, and the
  // defaults step closes every run — stepTotal has to match the blocks that actually execute.
  stepTotal = (scope === "1" || scope === "3" ? 8 : 0) + (scope === "2" || scope === "3" ? 4 : 0) + 1;
  if (scope === "1" || scope === "3") {
    console.log("\n--- User-level install ---");
    await stepSharedSessionState(userExtDir, sources, options);
    await stepPonytail(userPluginsDir, userDir, options);
    const ponytailExtPath = path.join(userPluginsDir, "node_modules", "@dietrichgebert", "ponytail", "pi-extension", "index.js");
    await stepRtk(bunBinDir, options);
    await stepRtkSession(userExtDir, sources, options);
    await stepCaveman(userExtDir, sources, options);
    await stepTokenSaver(userExtDir, options);
    await stepModeReinforcement(userExtDir, ponytailExtPath, options);
    await stepAmanaiReward(userExtDir, sources, options);
  }

  if (scope === "2" || scope === "3") {
    console.log("\n--- Project-level install ---");
    await stepSharedSessionState(projectExtDir, sources, options);
    await stepRtkSession(projectExtDir, sources, options);
    await stepCaveman(projectExtDir, sources, options);
    await stepAmanaiReward(projectExtDir, sources, options);
    console.log("  [note] Token Saver, Ponytail, and the RTK binary are user-level (global) installs");
  }

  // After the extensions, so a first-run preset lands next to an installed command surface.
  await stepTokenSaverConfig(options);

  console.log("\n=== Installation complete ===");
  console.log(`\nDefaults file: ${tokenSaverConfigPath()}`);
  console.log("\nNext steps:");
  console.log("  1. Restart OMP");
  console.log("  2. /token-saver status        (alias: /ts)");
  console.log("  3. /token-saver preset high   (off | lite | medium | high | max | ultra)");
  console.log("  4. /token-saver set caveman=ultra   (per-knob override)");
  console.log("  5. /token-saver default       (what fresh sessions start from)");
  console.log("  6. /combo                     (preset-only alias)");
  console.log("  7. /ai-addons check");

  closeRL();
}

main().catch((e) => {
  closeRL();
  console.error(e);
  // A half-finished install must not look like success to a script or install.bat.
  process.exitCode = 1;
});
