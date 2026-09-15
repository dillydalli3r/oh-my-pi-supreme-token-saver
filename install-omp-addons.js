#!/usr/bin/env node
// install-omp-addons.js — Install the Supreme Token Saver add-ons on any OMP device.
// Usage: node install-omp-addons.js [install|update|reinstall|doctor|uninstall|version|help] [options]
// Requires: node/npm and omp CLI

import https from "node:https";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import readline from "node:readline";

const IS_WINDOWS = process.platform === "win32";
const HOME = process.env.HOME || process.env.USERPROFILE || "";

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
const COMMANDS = new Set(["install", "update", "reinstall", "doctor", "uninstall", "version", "help"]);
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
const removePonytail = args.includes("--remove-ponytail");
const removeRtk = args.includes("--remove-rtk");

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
  version      Print the package version
  help         Show this help

Options:
  --scope user|project|both    Install scope (default user)
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

The extension ships one command surface: /token-saver (alias /ts), with /combo kept
as a preset-only alias. The presets (off, lite, medium, high, max, ultra) drive all
eight knobs — caveman, rtk, ponytail, read, compress, prune, autoRtk, status.`);
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
// Pre-2.0 shipped a separate combo extension directory that registered a duplicate /combo command;
// 2.0 folds that surface into token-saver. The stale directory name is spelled out once, here, so
// no other line hardcodes it.
const STALE_COMBO_DIRNAME = "combo-toggle";
const MODE_REINFORCEMENT_INDEX = path.join(EXT_DIR, "shared", "mode-reinforcement.js");
const CAVEMAN_REMOTE_RULE = "https://raw.githubusercontent.com/JuliusBrussee/caveman/main/src/rules/caveman-activate.md";
const RTK_RELEASE_API = "https://api.github.com/repos/rtk-ai/rtk/releases/latest";

// Mirrors PRESET_NAMES / DEFAULT_PRESET in extensions/shared/session-state.js. Duplicated instead of
// imported so `--version`, `help`, and a dry run never depend on the extension tree loading.
const PRESET_NAMES = ["off", "lite", "medium", "high", "max", "ultra"];
const DEFAULT_PRESET = "max";

// --- Helpers ---

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function sha256File(filePath) {
  const buf = await fs.readFile(filePath);
  return createHash("sha256").update(buf).digest("hex");
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

function httpsRequest(url, onResponse) {
  const req = https.get(
    url,
    { headers: { "User-Agent": "omp-supreme-token-saver" }, agent: HTTP_AGENT },
    onResponse
  );
  req.setTimeout(HTTP_TIMEOUT_MS, () => req.destroy(new Error(`timed out after ${HTTP_TIMEOUT_MS}ms: ${url}`)));
  return req;
}

async function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        httpsGet(new URL(res.headers.location, url).href).then(resolve).catch(reject);
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

async function httpsDownload(url, dest) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        httpsDownload(new URL(res.headers.location, url).href, dest).then(resolve).catch(reject);
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

const execFileP = promisify(execFile);

function execP(cmd, args, opts = {}) {
  return execFileP(cmd, args, {
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

async function ensureExtensionInConfig(configPath, extensionPath, label, options = {}) {
  const normalizedPath = extensionPath.replace(/\\/g, "/");
  const line = `  - ${normalizedPath}`;

  let raw = await readIfExists(configPath);
  let lines = (raw || "").split("\n");

  if (lines.some((l) => l.includes(normalizedPath))) {
    debug(`${label} already in config.yml`);
    return false;
  }

  const extLineIdx = lines.findIndex((l) => /^\s*extensions\s*:/i.test(l));

  if (options.dryRun) {
    console.log(`  [dry-run] would add ${label} to config.yml: ${normalizedPath}`);
    return true;
  }

  // Handle "extensions: []" (empty YAML array)
  const emptyArrayIdx = lines.findIndex((l) => /^\s*extensions\s*:\s*\[\s*\]\s*$/i.test(l));
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

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, lines.join("\n"), "utf8");
  console.log(`  [write] Added ${label} to config.yml`);
  return true;
}

async function ensureExtensionAfterConfigEntry(configPath, extensionPath, afterPath, label, options = {}) {
  const normalizedPath = extensionPath.replace(/\\/g, "/");
  const normalizedAfterPath = afterPath.replace(/\\/g, "/");
  const line = `  - ${normalizedPath}`;
  const raw = await readIfExists(configPath);
  const lines = (raw || "").split("\n");
  const existingIndex = lines.findIndex((entry) => entry.includes(normalizedPath));
  const afterIndex = lines.findIndex((entry) => entry.includes(normalizedAfterPath));

  if (existingIndex !== -1 && afterIndex !== -1 && existingIndex === afterIndex + 1) return false;
  if (options.dryRun) {
    console.log(`  [dry-run] would place ${label} after Ponytail in config.yml: ${normalizedPath}`);
    return true;
  }

  if (existingIndex !== -1) lines.splice(existingIndex, 1);
  const refreshedAfterIndex = lines.findIndex((entry) => entry.includes(normalizedAfterPath));
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

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, lines.join("\n"), "utf8");
  console.log(`  [write] Placed ${label} after Ponytail in config.yml`);
  return true;
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

async function stepPonytail(pluginsDir, userDir, options = {}) {
  console.log("\n[1/7] Installing Ponytail plugin...");
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

  if (options.dryRun) {
    console.log(`  [dry-run] would write ${pkgPath}`);
  } else {
    await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    console.log(`  [write] package.json`);
  }

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

    const configPath = path.join(userDir, "config.yml");
    await ensureExtensionInConfig(configPath, ponytailExtPath, "ponytail", options);
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

  // Wire extension into config.yml so /ponytail command loads
  console.log("  [ok] Ponytail pi-extension found");
  const configPath = path.join(userDir, "config.yml");
  await ensureExtensionInConfig(configPath, ponytailExtPath, "ponytail", options);
  await ensurePonytailConfig(options);
}

async function stepRtk(binDir, options = {}) {
  console.log("\n[2/7] Installing RTK binary...");

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

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rtk-"));
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
        await fs.rm(tmpDir, { recursive: true, force: true });
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
      await fs.rm(tmpDir, { recursive: true, force: true });
      return;
    }

    // Find binary
    const binaryName = IS_WINDOWS ? "rtk.exe" : "rtk";
    const entries = await fs.readdir(extractDir, { recursive: true });
    debug(`extracted entries: ${entries.join(", ")}`);
    const found = entries.find((e) => path.basename(e) === binaryName);
    if (!found) {
      console.log(`  [fail] Could not find ${binaryName} in extracted archive`);
      await fs.rm(tmpDir, { recursive: true, force: true });
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

    // Cleanup
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch (e) {
    console.log(`  [fail] RTK: ${e.message}`);
    console.log(`  [hint] Manual: https://github.com/rtk-ai/rtk/releases`);
  }
}

async function stepSharedSessionState(extDir, options = {}) {
  const src = await readIfExists(SHARED_SESSION_STATE);
  if (!src) {
    console.log("  [skip] shared/session-state.js not found in repo");
  } else {
    await writeIfChanged(path.join(extDir, "shared", "session-state.js"), src, options);
  }

  const statusSrc = await readIfExists(SHARED_STATUS_LINE);
  if (!statusSrc) {
    console.log("  [skip] shared/status-line.js not found in repo");
    return;
  }
  await writeIfChanged(path.join(extDir, "shared", "status-line.js"), statusSrc, options);
}

async function stepModeReinforcement(extDir, ponytailExtPath, options = {}) {
  console.log("\n[6/7] Installing mode reinforcement extension...");
  const src = await readIfExists(MODE_REINFORCEMENT_INDEX);
  if (!src) {
    console.log("  [skip] shared/mode-reinforcement.js not found in repo");
    return;
  }
  const dest = path.join(extDir, "shared", "mode-reinforcement.js");
  await writeIfChanged(dest, src, options);
  await ensureExtensionAfterConfigEntry(path.join(path.dirname(extDir), "config.yml"), dest, ponytailExtPath, "mode reinforcement", options);
}

async function stepRtkSession(extDir, options = {}) {
  console.log("\n[3/7] Installing RTK session extension...");
  const src = await readIfExists(RTK_SESSION_INDEX);
  if (!src) {
    console.log("  [skip] rtk-session/index.js not found in repo");
    return;
  }
  const dest = path.join(extDir, "rtk-session", "index.js");
  await writeIfChanged(dest, src, options);
}

async function stepCaveman(extDir, options = {}) {
  console.log("\n[4/7] Installing Caveman session extension...");
  const cavemanDir = path.join(extDir, "caveman-session");
  if (!options.dryRun) await fs.mkdir(cavemanDir, { recursive: true });

  // The bundled rule is always a valid destination: dry runs stay offline, and a failed remote
  // fetch falls back to it instead of aborting the install with the remaining steps unrun.
  const bundledRule = await readIfExists(path.join(path.dirname(CAVEMAN_INDEX), "rule.md")) || "";
  let rule = bundledRule;
  if (!options.dryRun) {
    try {
      rule = await httpsGet(CAVEMAN_REMOTE_RULE) || bundledRule;
    } catch (e) {
      console.log(`  [warn] Could not fetch ${CAVEMAN_REMOTE_RULE} (${e.message}) — using the bundled rule`);
    }
  }
  await writeIfChanged(path.join(cavemanDir, "rule.md"), rule, options);

  // Write index.js
  const src = await readIfExists(CAVEMAN_INDEX);
  if (!src) {
    console.log("  [skip] caveman-session/index.js not found in repo");
    return;
  }
  await writeIfChanged(path.join(cavemanDir, "index.js"), src, options);

  // Write updater
  const updaterSrc = await readIfExists(UPDATER_INDEX);
  if (updaterSrc) {
    const updaterDest = path.join(extDir, "ai-addons-updater", "index.js");
    await writeIfChanged(updaterDest, updaterSrc, options);
  } else {
    console.log("  [skip] ai-addons-updater/index.js not found in repo");
  }
}

// 2.0 install steps, in order: 1 Ponytail, 2 RTK binary, 3 RTK session, 4 Caveman, 5 Token Saver
// (session knobs + the /token-saver command surface), 6 mode reinforcement, 7 Amanai reward.
async function stepTokenSaver(extDir, options = {}) {
  console.log("\n[5/7] Installing Token Saver extension...");
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
  const configRaw = await readIfExists(configPath);
  if (configRaw) {
    const lines = configRaw.split("\n");
    const kept = lines.filter((l) => !l.includes(STALE_COMBO_DIRNAME));
    if (kept.length !== lines.length) {
      const count = lines.length - kept.length;
      if (options.dryRun) {
        console.log(`  [dry-run] would remove ${count} ${STALE_COMBO_DIRNAME} entries from config.yml`);
      } else {
        await fs.writeFile(configPath, kept.join("\n"), "utf8");
        console.log(`  [write] Removed ${count} ${STALE_COMBO_DIRNAME} entries from config.yml`);
      }
    }
  }

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

async function stepAmanaiReward(extDir, options = {}) {
  console.log("\n[7/7] Installing Amanai reward detector...");
  const src = await readIfExists(AMANAI_REWARD_INDEX);
  if (!src) {
    console.log("  [skip] amanai-reward/index.js not found in repo");
    return;
  }
  await writeIfChanged(path.join(extDir, "amanai-reward", "index.js"), src, options);
}

// --- Doctor ---

async function runDoctor() {
  console.log("\n=== OMP Supreme Token Saver Doctor ===\n");

  // Node
  console.log(`  Node: ok ${process.version}`);

  // OMP CLI
  try {
    const v = (await execCli("omp", ["--version"])).stdout.trim();
    console.log(`  OMP CLI: ok ${v}`);
  } catch {
    console.log("  OMP CLI: MISSING");
  }

  // Home
  console.log(`  Home: ${HOME}`);

  // Directories
  const agentDir = path.join(HOME, ".omp", "agent");
  const extDir = path.join(agentDir, "extensions");
  const configPath = path.join(agentDir, "config.yml");
  const pluginsDir = path.join(HOME, ".omp", "plugins");
  const rtkBin = path.join(HOME, ".bun", "bin", IS_WINDOWS ? "rtk.exe" : "rtk");

  const agentOk = await readIfExists(agentDir) !== null || (await fs.readdir(agentDir).catch(() => null)) !== null;
  console.log(`  OMP agent dir: ${agentOk ? "ok" : "MISSING"} ${agentDir}`);

  const extOk = (await fs.readdir(extDir).catch(() => null)) !== null;
  console.log(`  OMP extensions dir: ${extOk ? "ok" : "MISSING"} ${extDir}`);

  const sharedState = path.join(extDir, "shared", "session-state.js");
  console.log(`  Shared session bridge: ${(await readIfExists(sharedState)) !== null ? "installed" : "MISSING"}`);

  const sharedStatus = path.join(extDir, "shared", "status-line.js");
  console.log(`  Unified status line: ${(await readIfExists(sharedStatus)) !== null ? "installed" : "MISSING"}`);

  const configOk = (await readIfExists(configPath)) !== null;
  console.log(`  OMP config.yml: ${configOk ? "ok" : "MISSING"} ${configPath}`);

  // Ponytail
  const ponytailPkg = path.join(pluginsDir, "node_modules", "@dietrichgebert", "ponytail", "package.json");
  const ponytailExt = path.join(pluginsDir, "node_modules", "@dietrichgebert", "ponytail", "pi-extension", "index.js");
  const ponytailInstalled = (await readIfExists(ponytailPkg)) !== null;
  const ponytailExtInstalled = (await readIfExists(ponytailExt)) !== null;
  console.log(`  Ponytail package: ${ponytailInstalled ? "installed" : "MISSING"}`);
  console.log(`  Ponytail extension: ${ponytailExtInstalled ? "installed" : "MISSING"}`);

  if (configOk) {
    const configText = await readIfExists(configPath);
    const hasPonytailPath = configText.includes("ponytail") && configText.includes("pi-extension");
    console.log(`  Ponytail in config.yml: ${hasPonytailPath ? "registered" : "MISSING"}`);
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
    console.log(`  Ponytail config: ok defaultMode=${parsed?.defaultMode ?? "?"}, status row ${row}, startup toast ${toast}`);
  } else {
    console.log(`  Ponytail config: MISSING ${ponytailConfigPath}`);
  }

  // RTK
  const rtkExists = (await readIfExists(rtkBin)) !== null;
  console.log(`  RTK binary: ${rtkExists ? "installed" : "MISSING"} ${rtkBin}`);
  if (rtkExists) {
    try {
      const v = (await execP(rtkBin, ["--version"], { timeout: 5000 })).stdout.trim();
      console.log(`  RTK version: ${v}`);
    } catch {
      console.log("  RTK version: unavailable (may not be executable)");
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
    console.log("  rtk self-report: RTK's numbers are self-reported by the rtk binary, not independently verified.");
    for (const line of gain.split("\n")) console.log(`    ${line}`);
  } catch (e) {
    console.log(`  rtk self-report: unavailable (${e.message.split("\n")[0]})`);
  }

  // Headroom is an OPTIONAL external tool: this pack never bundles, installs, or depends on it, so a
  // missing CLI is reported and the doctor still exits 0. The path comes from the platform's own PATH
  // resolver (where / command -v) run through execCli — the same shell lookup the installer already
  // relies on for `omp` — rather than a second resolver in JS.
  try {
    const version = (await execCli("headroom", ["--version"], { timeout: 5000 })).stdout.trim();
    const exe = await execCli(IS_WINDOWS ? "where" : "sh", IS_WINDOWS ? ["headroom"] : ["-c", "command -v headroom"], { timeout: 5000 })
      .then((r) => r.stdout.split(/\r?\n/)[0].trim())
      .catch(() => "");
    console.log(`  Headroom: ok ${version}${exe ? ` ${exe}` : ""}`);
  } catch {
    console.log("  Headroom: not installed (optional)");
  }

  const modelsYml = path.join(agentDir, "models.yml");
  const modelsYmlText = await readIfExists(modelsYml);
  console.log(`  Headroom wrap: ${modelsYmlText !== null && /headroom/i.test(modelsYmlText) ? "wrapped (models.yml anthropic baseUrl)" : "not wrapped"}`);
  console.log("    `headroom wrap omp` only redirects the anthropic provider — other providers keep their endpoints.");

  // Caveman
  const cavemanIndex = path.join(extDir, "caveman-session", "index.js");
  const cavemanRule = path.join(extDir, "caveman-session", "rule.md");
  console.log(`  Caveman extension: ${(await readIfExists(cavemanIndex)) !== null ? "installed" : "MISSING"}`);
  console.log(`  Caveman rule.md: ${(await readIfExists(cavemanRule)) !== null ? "installed" : "MISSING"}`);

  // RTK extension
  const rtkIndex = path.join(extDir, "rtk-session", "index.js");
  console.log(`  RTK extension: ${(await readIfExists(rtkIndex)) !== null ? "installed" : "MISSING"}`);

  // Updater
  const updaterIndex = path.join(extDir, "ai-addons-updater", "index.js");
  console.log(`  Updater extension: ${(await readIfExists(updaterIndex)) !== null ? "installed" : "MISSING"}`);

  // Token Saver extension (owns the session knobs and the /token-saver command surface)
  const tokenSaverIndex = path.join(extDir, "token-saver", "index.js");
  console.log(`  Token Saver extension: ${(await readIfExists(tokenSaverIndex)) !== null ? "installed" : "MISSING"}`);

  const tokenSaverConfig = tokenSaverConfigPath();
  const tokenSaverRaw = await readIfExists(tokenSaverConfig);
  if (tokenSaverRaw) {
    let preset = "?";
    try {
      preset = JSON.parse(tokenSaverRaw.replace(/^\uFEFF/, ""))?.preset ?? "?";
    } catch {
      preset = `unreadable`;
    }
    console.log(`  Token Saver config: ok preset=${preset} ${tokenSaverConfig}`);
  } else {
    console.log(`  Token Saver config: MISSING (sessions fall back to ${DEFAULT_PRESET}) ${tokenSaverConfig}`);
  }

  // Pre-2.0 leftovers: the stale directory registers a duplicate /combo command.
  const staleComboDir = path.join(extDir, STALE_COMBO_DIRNAME);
  console.log(`  ${STALE_COMBO_DIRNAME} (pre-2.0): ${(await dirExists(staleComboDir)) ? `STALE ${staleComboDir}` : "ok absent"}`);

  const modeReinforcement = path.join(extDir, "shared", "mode-reinforcement.js");
  console.log(`  Mode reinforcement extension: ${(await readIfExists(modeReinforcement)) !== null ? "installed" : "MISSING"}`);

  // Amanai reward detector
  const amanaiRewardIndex = path.join(extDir, "amanai-reward", "index.js");
  console.log(`  Amanai reward detector: ${(await readIfExists(amanaiRewardIndex)) !== null ? "installed" : "MISSING"}`);

  if (configOk) {
    const configText = await readIfExists(configPath);
    const hasTokenSaverPath = configText.includes("token-saver");
    console.log(`  Token Saver in config.yml: ${hasTokenSaverPath ? "registered" : "MISSING"}`);
    if (configText.includes(STALE_COMBO_DIRNAME)) {
      console.log(`  [warn] config.yml still lists ${STALE_COMBO_DIRNAME} — rerun: install --yes`);
    }
  }
}

// --- Uninstall ---

async function runUninstall(options = {}) {
  const confirmed = options.yes ?? yes;
  const shouldRemovePonytail = options.removePonytail ?? removePonytail;
  const shouldRemoveRtk = options.removeRtk ?? removeRtk;
  const shouldDryRun = options.dryRun ?? dryRun;

  console.log("\n=== OMP Supreme Token Saver Uninstall ===\n");

  const extDir = path.join(HOME, ".omp", "agent", "extensions");
  const configPath = path.join(HOME, ".omp", "agent", "config.yml");
  const rtkBin = path.join(HOME, ".bun", "bin", IS_WINDOWS ? "rtk.exe" : "rtk");

  const targets = [
    path.join(extDir, "caveman-session"),
    path.join(extDir, "rtk-session"),
    path.join(extDir, "token-saver"),
    path.join(extDir, "ai-addons-updater"),
    path.join(extDir, STALE_COMBO_DIRNAME),
    path.join(extDir, "shared"),
    path.join(extDir, "amanai-reward"),
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
      return false;
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

  // Remove the token-saver registration (plus any pre-2.0 combo leftover) and
  // mode-reinforcement; Ponytail only when requested.
  const configRaw = await readIfExists(configPath);
  if (configRaw) {
    let lines = configRaw.split("\n");
    const before = lines.length;
    lines = lines.filter((l) => {
      if (l.includes("token-saver") || l.includes(STALE_COMBO_DIRNAME) || l.includes("mode-reinforcement")) return false;
      if (shouldRemovePonytail && l.includes("ponytail") && l.includes("pi-extension")) return false;
      return true;
    });
    if (lines.length !== before) {
      if (shouldDryRun) console.log(`  [dry-run] would remove ${before - lines.length} config.yml entries`);
      else {
        await fs.writeFile(configPath, lines.join("\n"), "utf8");
        console.log(`  [write] Updated config.yml (removed ${before - lines.length} entries)`);
      }
    }
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
  return true;
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

  if (doctor) {
    await runDoctor();
    closeRL();
    return;
  }

  if (uninstall) {
    await runUninstall();
    closeRL();
    return;
  }

  if (reinstall) {
    await runUninstall({ yes: true, removePonytail: false, removeRtk: true });
  }

  if (dryRun) console.log("[dry-run] No changes will be written.\n");

  console.log(`=== OMP Supreme Token Saver v${PACKAGE_VERSION} ===`);
  console.log(`  Platform: ${process.platform}`);
  console.log(`  Arch: ${process.arch}`);
  console.log(`  Home: ${HOME}`);

  // Determine install scope
  let scope;
  if (reinstall) {
    scope = "1";
    console.log("  Scope: user (reinstall)");
  } else if (scopeFlag) {
    const map = { user: "1", project: "2", both: "3" };
    scope = map[scopeFlag];
    if (!scope) {
      console.log(`  [fail] Invalid --scope: ${scopeFlag}. Use: user, project, both`);
      closeRL();
      process.exit(1);
    }
    console.log(`  Scope: ${scopeFlag}`);
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

  const options = { dryRun, verbose, yes, scope, reinstall, preset: presetFlag, forcePreset };

  // Check prerequisites
  console.log("\nPrerequisites:");
  try {
    const v = (await execCli("omp", ["--version"])).stdout.trim();
    console.log(`  [ok] omp ${v}`);
  } catch {
    console.log("  [fail] omp not found — ensure it's installed");
  }

  // Install per scope
  if (scope === "1" || scope === "3") {
    console.log("\n--- User-level install ---");
    await stepSharedSessionState(userExtDir, options);
    await stepPonytail(userPluginsDir, userDir, options);
    const ponytailExtPath = path.join(userPluginsDir, "node_modules", "@dietrichgebert", "ponytail", "pi-extension", "index.js");
    await stepRtk(bunBinDir, options);
    await stepRtkSession(userExtDir, options);
    await stepCaveman(userExtDir, options);
    await stepTokenSaver(userExtDir, options);
    await stepModeReinforcement(userExtDir, ponytailExtPath, options);
    await stepAmanaiReward(userExtDir, options);
  }

  if (scope === "2" || scope === "3") {
    console.log("\n--- Project-level install ---");
    await stepSharedSessionState(projectExtDir, options);
    await stepRtkSession(projectExtDir, options);
    await stepCaveman(projectExtDir, options);
    await stepAmanaiReward(projectExtDir, options);
    console.log("  [note] Token Saver, Ponytail, and the RTK binary are user-level (global) installs");
  }

  // After the extensions, so a first-run preset lands next to an installed command surface.
  console.log("\n--- Token Saver defaults ---");
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
