// OMP extension: /ai-addons — version check, startup update notice and manual updater for Ponytail,
// RTK, Caveman and this pack. Built-in Node modules only.
// ponytail: `skipped: none` — semantics match one-liner: fetch + compare + run install.
// rtk: `skipped: signature verification` — checksums.txt ships only SHA256 of release assets; add sigchain when upstream publishes a signing key.
// caveman: `skipped: none` — exactly the ask: write rule.md, report old/new hash.
// tokensaver: `skipped: direct writes` — the pack owns its own installer, we only spawn it.
// startup: `skipped: backoff` — a fixed interval, not an exponential one; the notice is one line per interval.

import https from "node:https";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { foreignLevels, nativeGapHint, readConfig, readOptions } from "../shared/session-state.js";

const IS_WINDOWS = process.platform === "win32";
const HOME = os.homedir();

// The pack can be installed two ways and nothing here may assume either one. Both layouts put every
// module in one `extensions/` directory, so this module's own URL locates the tree and every sibling
// follows from there:
//   legacy: ~/.omp/agent/extensions/<module>/index.js            (the installer's copies)
//   plugin: <plugins>/node_modules/@dillydalli3r/omp-supreme-token-saver/extensions/<module>/index.js
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXTENSIONS_DIR = path.resolve(MODULE_DIR, "..");
const PACK_ROOT = path.resolve(EXTENSIONS_DIR, "..");

const PACKAGE_NAME = "@dillydalli3r/omp-supreme-token-saver";
const PACKAGE_REPO = "dillydalli3r/omp-supreme-token-saver";

const PONYTAIL_REMOTE = "https://raw.githubusercontent.com/DietrichGebert/ponytail/main/package.json";
const PONYTAIL_DIR = ["@dietrichgebert", "ponytail"];
const RTK_RELEASE_API = "https://api.github.com/repos/rtk-ai/rtk/releases/latest";
const RTK_BINARY = path.join(HOME, ".bun", "bin", IS_WINDOWS ? "rtk.exe" : "rtk");
const CAVEMAN_REMOTE = "https://raw.githubusercontent.com/JuliusBrussee/caveman/main/src/rules/caveman-activate.md";
const CAVEMAN_LOCAL = path.join(EXTENSIONS_DIR, "caveman-session", "rule.md");

// The published manifest is the version the next install would land on, raw-fetched: no rate limit, no
// auth, and no token needed on a machine that has never run `gh auth login`. The npm registry is
// checked beside it for when the package is republished there.
const PACK_MANIFEST_REMOTE = `https://raw.githubusercontent.com/${PACKAGE_REPO}/main/package.json`;
const PACK_NPM_LATEST = `https://registry.npmjs.org/${PACKAGE_NAME.replace("/", "%2F")}/latest`;
const PACK_GIT_SOURCE = `github:${PACKAGE_REPO}`;
const PACK_NPM_SPEC = `${PACKAGE_NAME}@latest`;

// Same resolution as shared/session-state.js, so a session pointed at another file by
// OMP_TOKEN_SAVER_CONFIG checks the pack it actually runs. This extension's own files sit beside it.
const TS_CONFIG =
  process.env.OMP_TOKEN_SAVER_CONFIG || path.join(HOME, ".omp", "agent", "token-saver.json");
const CONFIG_PATH = path.join(path.dirname(TS_CONFIG), "ai-addons.json");
const STATE_PATH = path.join(path.dirname(TS_CONFIG), "ai-addons-state.json");
const DEFAULT_STARTUP = { checkOnStart: true, intervalHours: 6 };

// Version stamp the installer may drop into the installed tree (README: "Version sources"). Absent is
// normal — the marketplace lock file and the pack's own package.json answer for the plugin layout.
const VERSION_STAMP =
  process.env.OMP_TOKEN_SAVER_VERSION_STAMP || path.join(EXTENSIONS_DIR, ".omp-token-saver-version");

const RELOAD_MSG = "Reminder: restart OMP (or reload extensions) for updates to take effect.";

function httpsGet(url, { maxRedirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "omp-ai-addons-updater", Accept: "application/json,*/*" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (maxRedirects <= 0) { res.resume(); return reject(new Error("Too many redirects")); }
        res.resume();
        const next = new URL(res.headers.location, url).href;
        return resolve(httpsGet(next, { maxRedirects: maxRedirects - 1 }));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      let body = "";
      // A reset mid-body errors the response stream, not just the request; unhandled, that event
      // takes the whole process down.
      res.on("error", reject);
      // ponytail: streamed accumulation — fine for tens of KB; stream-pipe if assets ever exceed a few MB.
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.setTimeout(30000, () => req.destroy(new Error(`Timeout fetching ${url}`)));
  });
}

function httpsDownload(url, dest, { maxRedirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "omp-ai-addons-updater", Accept: "*/*" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (maxRedirects <= 0) { res.resume(); return reject(new Error("Too many redirects")); }
        res.resume();
        const next = new URL(res.headers.location, url).href;
        return resolve(httpsDownload(next, dest, { maxRedirects: maxRedirects - 1 }));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      const file = createWriteStream(dest);
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
      // A reset mid-body errors the response stream, not the request: close the handle and drop the
      // truncated archive, so a broken transfer cannot leave a partial file behind.
      const fail = (error) => {
        file.destroy();
        fs.unlink(dest).catch(() => {});
        reject(error);
      };
      res.on("error", fail);
      file.on("error", fail);
    });
    req.on("error", reject);
    req.setTimeout(120000, () => req.destroy(new Error(`Timeout downloading ${url}`)));
  });
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function parseChecksum(checksumsText, assetName) {
  const target = path.basename(assetName);
  for (const line of checksumsText.split(/\r?\n/)) {
    const m = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (m && path.basename(m[2]) === target) return m[1].toLowerCase();
  }
  return null;
}

function normalizeRtkVersion(value) {
  return String(value || "").replace(/^rtk\s+/i, "").replace(/^v/i, "").trim();
}

async function readTextIfExists(p) {
  try { return await fs.readFile(p, "utf8"); } catch { return null; }
}

function notify(ctx, msg, level) {
  ctx?.ui?.notify?.(String(msg), level || "info");
}

// --- paths -------------------------------------------------------------------------------------

// Marketplace state moves under $XDG_DATA_HOME/omp once that root exists; the non-XDG default is
// ~/.omp. Whichever root is present on disk is the one omp actually uses.
function pluginsRoot() {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) {
    const candidate = path.join(xdg, "omp", "plugins");
    if (existsSync(candidate)) return candidate;
  }
  return path.join(HOME, ".omp", "plugins");
}

function ponytailManifest() {
  return path.join(pluginsRoot(), "node_modules", ...PONYTAIL_DIR, "package.json");
}

async function readJsonFile(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; }
}

async function writeJsonFile(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// --- versions ----------------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 6000;

// `fetch` (not https.get) for everything a check reads: one URL per call, a hard timeout, and a stub a
// test can swap in. Downloads still stream through httpsDownload — those write files.
async function fetchWithTimeout(url, accept) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "omp-ai-addons-updater", accept },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url) {
  return (await fetchWithTimeout(url, "application/json,*/*")).json();
}

async function fetchText(url) {
  return (await fetchWithTimeout(url, "text/plain,*/*")).text();
}

// Semver-ish over the dotted numeric parts, ignoring a leading `v` and any pre-release suffix. This pack
// publishes plain x.y.z, where this agrees with semver exactly.
function cmpVersion(a, b) {
  const parse = (value) =>
    String(value).replace(/^v/i, "").split("-")[0].split(".").map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i] || 0;
    const r = right[i] || 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

// The stamp is either `{"version":"2.2.0"}` or a bare `2.2.0`; anything else is not a version.
function stampVersion(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("{")) return trimmed.split(/\s+/)[0];
  try {
    const parsed = JSON.parse(trimmed);
    return parsed?.version ? String(parsed.version) : null;
  } catch {
    return null;
  }
}

// Where the installed pack's version comes from, most specific first:
//   1. the stamp a legacy install wrote into the tree (the installer owns writing it),
//   2. the marketplace lock file — what omp believes is installed,
//   3. the package.json the module travels with (plugin layout, or a repo checkout).
// Nothing else is reported as a version: an mtime reads as a date, and a date reads as proof of a
// version this row cannot actually see, so an unreachable source is `unknown` instead.
async function readPackVersion() {
  const stamped = stampVersion(await readTextIfExists(VERSION_STAMP));
  if (stamped) return { version: stamped, source: "stamp" };

  const lock = await readJsonFile(path.join(pluginsRoot(), "omp-plugins.lock.json"));
  const locked = lock?.plugins?.[PACKAGE_NAME]?.version;
  if (locked) return { version: String(locked), source: "omp-plugins.lock.json" };

  for (const manifest of [
    path.join(pluginsRoot(), "node_modules", ...PACKAGE_NAME.split("/"), "package.json"),
    path.join(PACK_ROOT, "package.json"),
  ]) {
    const version = (await readJsonFile(manifest))?.version;
    if (version) return { version: String(version), source: "package.json" };
  }
  return { version: null, source: null };
}

// Version check for this pack. No mutation.
async function checkTokenSaver() {
  const local = await readPackVersion();
  const preset = readConfig().preset;

  let remote = null;
  let remoteError = null;
  try {
    remote = (await fetchJson(PACK_MANIFEST_REMOTE))?.version ?? null;
  } catch (e) { remoteError = e.message; }

  // The registry is a second publisher of the same package: reported when it answers, silent when it
  // 404s (this fork is published from GitHub today).
  let published = null;
  try {
    published = (await fetchJson(PACK_NPM_LATEST))?.version ?? null;
  } catch { published = null; }

  const newest = remote && published && cmpVersion(published, remote) > 0 ? published : remote;
  const update = Boolean(local.version && newest && cmpVersion(newest, local.version) > 0);
  const status = !local.version ? "version unknown"
    : !newest ? "version unknown (no published manifest)"
    : update ? `update available → ${newest}`
    : "up to date";
  const localText = local.version
    ? `${local.version} (${local.source})`
    : `unknown — no ${path.basename(VERSION_STAMP)}, no lock entry, no package.json`;
  const row = `Token saver ${status}: local=${localText} · published=${remote || "—"}` +
    `${published ? ` · npm=${published}` : ""} · preset=${preset}`;
  return {
    id: "tokensaver",
    local: local.version || "unknown",
    remote: newest || "unknown",
    update,
    row,
    text: remoteError ? `${row} (manifest lookup failed: ${remoteError})` : row,
    type: remoteError ? "warning" : "info",
  };
}

// Ponytail: version from the plugin's own manifest, wherever the plugin root resolves to.
async function checkPonytail() {
  const manifest = ponytailManifest();
  try {
    const remote = (await fetchJson(PONYTAIL_REMOTE))?.version ?? null;
    const local = (await readJsonFile(manifest))?.version ?? null;
    const update = Boolean(local && remote && cmpVersion(remote, local) > 0);
    const status = !local ? `not installed — no manifest at ${manifest}`
      : update ? "update available"
      : cmpVersion(remote, local) === 0 ? "up to date"
      : "ahead of the published version";
    const row = `Ponytail ${status}: local=${local || "—"} latest=${remote || "—"}`;
    return { id: "ponytail", local, remote, update, row, text: row, type: "info" };
  } catch (e) {
    const text = `Ponytail check failed: ${e.message}`;
    return { id: "ponytail", local: null, remote: null, update: false, row: text, text, type: "warning" };
  }
}

// RTK: the binary is not the pack's, so a path that holds nothing is reported as such rather than
// spawned.
async function checkRtk() {
  if (!existsSync(RTK_BINARY)) {
    const row = `RTK not installed: no binary at ${RTK_BINARY}`;
    return { id: "rtk", local: null, remote: null, update: false, row, text: row, type: "info" };
  }
  try {
    const latest = (await fetchJson(RTK_RELEASE_API))?.tag_name || null;
    let localVer = null;
    try {
      const out = execFileSync(RTK_BINARY, ["--version"], { encoding: "utf8", windowsHide: true, shell: false, timeout: 10000 }) || "";
      if (out) localVer = normalizeRtkVersion(out.trim().split(/\r?\n/)[0]);
    } catch { localVer = null; }
    const update = Boolean(localVer && latest && cmpVersion(normalizeRtkVersion(latest), localVer) > 0);
    const status = localVer == null ? "installed but not runnable"
      : update ? "update available"
      : "up to date";
    const row = `RTK ${status}: local=${localVer || "—"} latest=${latest || "—"}`;
    return { id: "rtk", local: localVer, remote: latest, update, row, text: row, type: "info" };
  } catch (e) {
    const text = `RTK check failed: ${e.message}`;
    return { id: "rtk", local: null, remote: null, update: false, row: text, text, type: "warning" };
  }
}

// Caveman rule.md, next to this module in either layout. The upstream text names levels `/caveman` here
// rejects, and the extension serves its own bundled rule when the installed file does — so an upstream
// copy that names one is not an update this pack can adopt: adopting it changes nothing a session sees.
async function checkCaveman() {
  try {
    const remote = await fetchText(CAVEMAN_REMOTE);
    const local = await readTextIfExists(CAVEMAN_LOCAL);
    const foreign = foreignLevels(remote);
    if (foreign.length) {
      const row = `Caveman rule: serving the bundled rule — the published rule names ` +
        `${foreign.join(", ")}, which /caveman rejects`;
      return { id: "caveman", local: "bundled", remote: "rejected", update: false, row, text: row, type: "info" };
    }
    const remoteHash = sha256Hex(remote).slice(0, 16);
    const localHash = local ? sha256Hex(local).slice(0, 16) : "—";
    const update = !local || localHash !== remoteHash;
    const status = !local ? `rule.md missing at ${CAVEMAN_LOCAL}`
      : update ? "rule.md update available"
      : "rule.md up to date";
    const text = `Caveman ${status}: local=${localHash} remote=${remoteHash}`;
    return { id: "caveman", local: localHash, remote: remoteHash, update, row: text, text, type: "info" };
  } catch (e) {
    const text = `Caveman check failed: ${e.message}`;
    return { id: "caveman", local: null, remote: null, update: false, row: text, text, type: "warning" };
  }
}

// Check: no mutation.
async function collectChecks() {
  // The four probes are independent network calls, so run them together — but the user sees them in this
  // order, not in the order the hosts answered.
  return Promise.all([checkPonytail(), checkRtk(), checkCaveman(), checkTokenSaver()]);
}

async function checkAddons(ctx) {
  const rows = await collectChecks();
  for (const row of rows) notify(ctx, row.text, row.type);
  return rows.map((row) => row.row).join("\n");
}

// --- startup check -----------------------------------------------------------------------------

async function loadStartupConfig() {
  const raw = (await readJsonFile(CONFIG_PATH)) || {};
  return {
    checkOnStart: raw.checkOnStart !== false,
    intervalHours: Number.isFinite(raw.intervalHours) && raw.intervalHours > 0
      ? raw.intervalHours
      : DEFAULT_STARTUP.intervalHours,
  };
}

// Startup runs off the turn and at most once per interval. Two layers keep it quiet: `lastCheck` gates
// the network, and `notified` remembers the signature of what was announced, so a restarted session does
// not repeat a nag no new release stands behind.
async function runStartupCheck(ctx) {
  const config = await loadStartupConfig();
  if (!config.checkOnStart) return;

  const state = (await readJsonFile(STATE_PATH)) || {};
  if (Date.now() - (Number(state.lastCheck) || 0) < config.intervalHours * 3600_000) return;
  // The timestamp is written before the fetch: a machine that is offline at every start must not
  // re-attempt the whole set on every session.
  await writeJsonFile(STATE_PATH, { ...state, lastCheck: Date.now() });

  const rows = await collectChecks();
  const stale = rows.filter((row) => row.update);
  const signature = stale.map((row) => `${row.id} ${row.local}→${row.remote}`).join("|");
  if (stale.length && state.notified === signature) return;

  const lines = [];
  if (stale.length) {
    const count = `${stale.length} update${stale.length === 1 ? "" : "s"}`;
    lines.push(`${count}: ${stale.map((row) => `${row.id} ${row.local} → ${row.remote}`).join(", ")}` +
      ` — run ${stale.map((row) => `/ai-addons update ${row.id}`).join(" | ")}`);
  }
  const hint = nativeGapHint(readConfig().preset, readOptions().native.mode);
  if (hint) lines.push(hint);

  await writeJsonFile(STATE_PATH, { lastCheck: Date.now(), notified: signature });
  if (lines.length) notify(ctx, `ai-addons: ${lines.join(" · ")}`, stale.length ? "warning" : "info");
}

async function updatePonytail(pi, ctx, dryRun = false) {
  const pluginsDir = path.join(HOME, ".omp", "plugins");
  if (dryRun) {
    const m = `Ponytail dry-run: would run \`npm install @dietrichgebert/ponytail@latest --save --no-audit --no-fund\` in ${pluginsDir}.`;
    notify(ctx, m, "info");
    return m;
  }
  notify(ctx, "Ponytail: ensuring plugin directory exists…", "info");
  try {
    await fs.mkdir(pluginsDir, { recursive: true });
  } catch (e) {
    const m = `Ponytail update failed: failed to create ${pluginsDir}: ${e.message}`;
    notify(ctx, m, "warning");
    return m;
  }
  notify(ctx, "Ponytail: running npm install…", "info");
  let out = "";
  try {
    const [command, argv] = cliCommand("npm", ["install", "@dietrichgebert/ponytail@latest", "--save", "--no-audit", "--no-fund"]);
    // A registry that never answers must not hang the command handler for the session's lifetime.
    const r = await pi.exec(command, argv, { cwd: pluginsDir, timeout: 300000 });
    out = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
    if (r.code !== 0) throw new Error(r.stderr || `npm exited ${r.code}`);
  } catch (e) {
    const m = `Ponytail update failed: ${e.message}`;
    notify(ctx, m, "warning");
    return m;
  }
  const m = `Ponytail update finished.${out ? `\n${out}` : ""}\n${RELOAD_MSG}`;
  notify(ctx, "Ponytail update finished. " + RELOAD_MSG, "info");
  return m;
}
async function updateRtk(ctx, dryRun = false) {
  let release;
  try {
    const raw = await httpsGet(RTK_RELEASE_API);
    release = JSON.parse(raw);
  } catch (e) {
    const m = `RTK: cannot fetch release info: ${e.message}`;
    notify(ctx, m, "warning"); return m;
  }
  const tag = release.tag_name || "unknown";
  const assets = Array.isArray(release.assets) ? release.assets : [];

  // Cross-platform asset selection (mirrors installer stepRtk)
  const PLATFORM = process.platform;
  const ARCH = process.arch;
  let assetTriple;
  let assetExt;
  let binaryName;
  if (PLATFORM === "win32" && ARCH === "x64") {
    assetTriple = "x86_64-pc-windows-msvc";
    assetExt = ".zip";
    binaryName = "rtk.exe";
  } else if (PLATFORM === "linux" && ARCH === "x64") {
    assetTriple = "x86_64-unknown-linux-musl";
    assetExt = ".tar.gz";
    binaryName = "rtk";
  } else if (PLATFORM === "linux" && ARCH === "arm64") {
    assetTriple = "aarch64-unknown-linux-gnu";
    assetExt = ".tar.gz";
    binaryName = "rtk";
  } else if (PLATFORM === "darwin" && ARCH === "x64") {
    assetTriple = "x86_64-apple-darwin";
    assetExt = ".tar.gz";
    binaryName = "rtk";
  } else if (PLATFORM === "darwin" && ARCH === "arm64") {
    assetTriple = "aarch64-apple-darwin";
    assetExt = ".tar.gz";
    binaryName = "rtk";
  } else {
    const m = `RTK: unsupported platform ${PLATFORM}/${ARCH}`;
    notify(ctx, m, "warning"); return m;
  }

  const asset = assets.find((a) => a.name === `rtk-${assetTriple}${assetExt}`);
  const checksAsset = assets.find((a) => a.name === "checksums.txt");
  if (!asset || !checksAsset) {
    const m = `RTK: required assets not found in release ${tag} (need rtk-${assetTriple}${assetExt} and checksums.txt)`;
    notify(ctx, m, "warning"); return m;
  }

  if (dryRun) {
    const m = `RTK dry-run: would download ${asset.name} (${tag}), verify checksums.txt, and replace ${RTK_BINARY}.`;
    notify(ctx, m, "info");
    return m;
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rtk-update-"));
  const archivePath = path.join(tmp, asset.name);
  const checksPath = path.join(tmp, "checksums.txt");

  try {
    notify(ctx, `RTK: downloading ${asset.name} (${tag})…`, "info");
    await httpsDownload(asset.browser_download_url, archivePath);
    notify(ctx, "RTK: downloading checksums.txt…", "info");
    await httpsDownload(checksAsset.browser_download_url, checksPath);
    // Verify SHA256 against checksums.txt
    const checks = await fs.readFile(checksPath, "utf8");
    const expected = parseChecksum(checks, asset.name);
    if (!expected) {
      const m = `RTK: checksums.txt has no entry for ${asset.name}`;
      notify(ctx, m, "warning"); return m;
    }
    const archiveBuf = await fs.readFile(archivePath);
    const actual = createHash("sha256").update(archiveBuf).digest("hex").toLowerCase();
    if (actual !== expected) {
      const m = `RTK: checksum mismatch! expected=${expected.slice(0,12)}… actual=${actual.slice(0,12)}…`;
      notify(ctx, m, "warning"); return m;
    }
    notify(ctx, "RTK: checksum verified.", "info");

    // Extract by archive format
    const extractDir = path.join(tmp, "extracted");
    await fs.mkdir(extractDir, { recursive: true });

    if (asset.name.endsWith(".zip")) {
      if (IS_WINDOWS) {
        execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
          `Expand-Archive -LiteralPath "${archivePath}" -DestinationPath "${extractDir}" -Force`],
          { encoding: "utf8", windowsHide: true, shell: false });
      } else {
        execFileSync("unzip", [archivePath, "-d", extractDir], { encoding: "utf8", shell: false });
      }
    } else if (asset.name.endsWith(".tar.gz") || asset.name.endsWith(".tgz")) {
      try {
        execFileSync("tar", ["xzf", archivePath, "-C", extractDir], { encoding: "utf8", shell: false });
      } catch (e) {
        execFileSync("sh", ["-c", `gunzip < "${archivePath}" | tar xf - -C "${extractDir}"`], { encoding: "utf8", shell: false });
      }
    } else {
      throw new Error(`Unknown archive format: ${asset.name}`);
    }
    const rtkExtracted = await findFile(extractDir, binaryName);
    if (!rtkExtracted) {
      const m = `RTK: ${binaryName} not found in extracted archive`;
      notify(ctx, m, "warning"); return m;
    }
    await fs.mkdir(path.dirname(RTK_BINARY), { recursive: true });
    const backupPath = `${RTK_BINARY}.bak`;
    let backedUp = false;
    try {
      await fs.copyFile(RTK_BINARY, backupPath);
      backedUp = true;
    } catch {
      backedUp = false;
    }

    await fs.copyFile(rtkExtracted, RTK_BINARY);

    // Set executable bit on Unix
    if (!IS_WINDOWS) {
      await fs.chmod(RTK_BINARY, 0o755);
    }

    let versionOut = "";
    try {
      versionOut = execFileSync(RTK_BINARY, ["--version"], { encoding: "utf8", windowsHide: true, shell: false, timeout: 10000 }).trim();
    } catch (e) {
      if (backedUp) await fs.copyFile(backupPath, RTK_BINARY);
      throw new Error(`new ${binaryName} failed --version${backedUp ? "; restored backup" : ""}: ${e.message}`);
    }
    if (normalizeRtkVersion(versionOut) !== normalizeRtkVersion(tag)) {
      if (backedUp) await fs.copyFile(backupPath, RTK_BINARY);
      throw new Error(`new ${binaryName} reports ${versionOut}, expected ${tag}${backedUp ? "; restored backup" : ""}`);
    }
    const m = `RTK updated to ${tag} → ${RTK_BINARY}\nbackup=${backedUp ? backupPath : "—"}\n${RELOAD_MSG}`;
    notify(ctx, "RTK update finished. " + RELOAD_MSG, "info");
    return m;
  } catch (e) {
    const m = `RTK update failed: ${e.message}`;
    notify(ctx, m, "warning"); return m;
  } finally {
    fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function findFile(dir, name) {
  try {
    const ents = await fs.readdir(dir, { withFileTypes: true });
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const r = await findFile(full, name);
        if (r) return r;
      } else if (e.isFile()) {
        if (e.name === name) return full;
        // Match rtk-* asset names (e.g. rtk-x86_64-unknown-linux-musl)
        if (name === "rtk" || name === "rtk.exe") {
          const base = e.name.toLowerCase();
          if (!/\.(txt|md|json|sha256|sig|asc|pem|crt|license)$/i.test(base)) {
            if (base === "rtk" || base === "rtk.exe" || /^rtk[-_.]/.test(base)) return full;
          }
        }
      }
    }
  } catch { /* ignore */ }
  return null;
}

async function updateCaveman(ctx, dryRun = false) {
  let remote;
  try { remote = await httpsGet(CAVEMAN_REMOTE); }
  catch (e) { const m = `Caveman update failed: ${e.message}`; notify(ctx, m, "warning"); return m; }

  // Writing a rule that names a level `/caveman` rejects would change the file and nothing a session
  // sees — caveman-session serves its bundled copy instead. Refuse loudly rather than churn the file.
  const foreign = foreignLevels(remote);
  if (foreign.length) {
    const m = `Caveman rule not updated: the published rule names ${foreign.join(", ")}, which /caveman rejects ` +
      `— the pack keeps serving its bundled rule (${CAVEMAN_LOCAL} unchanged).`;
    notify(ctx, m, "warning");
    return m;
  }

  const remoteHash = sha256Hex(remote).slice(0, 16);
  const oldLocal = await readTextIfExists(CAVEMAN_LOCAL);
  const oldHash = oldLocal ? sha256Hex(oldLocal).slice(0, 16) : null;

  if (dryRun) {
    const m = `Caveman dry-run: would write ${CAVEMAN_LOCAL}\nold=${oldHash || "—"} new=${remoteHash}.`;
    notify(ctx, m, "info");
    return m;
  }

  try {
    await fs.mkdir(path.dirname(CAVEMAN_LOCAL), { recursive: true });
    const backupPath = `${CAVEMAN_LOCAL}.bak`;
    if (oldLocal !== null) await fs.writeFile(backupPath, oldLocal, "utf8");
    await fs.writeFile(CAVEMAN_LOCAL, remote, "utf8");
    const written = await fs.readFile(CAVEMAN_LOCAL, "utf8");
    const writtenHash = sha256Hex(written).slice(0, 16);
    if (writtenHash !== remoteHash) {
      if (oldLocal !== null) await fs.writeFile(CAVEMAN_LOCAL, oldLocal, "utf8");
      throw new Error(`written hash ${writtenHash} did not match remote ${remoteHash}${oldLocal !== null ? "; restored backup" : ""}`);
    }
    const m = `Caveman rule.md updated → ${CAVEMAN_LOCAL}\nold=${oldHash || "—"} new=${remoteHash}\nbackup=${oldLocal !== null ? backupPath : "—"}\n${RELOAD_MSG}`;
    notify(ctx, "Caveman rule.md updated. " + RELOAD_MSG, "info");
    return m;
  } catch (e) {
    const m = `Caveman update failed: ${e.message}`;
    notify(ctx, m, "warning");
    return m;
  }
}

// Windows resolves npm/npx to .cmd shims that a shell-less spawn cannot execute (Node refuses .cmd
// without a shell), so those commands go through cmd.exe there. The installer's execCli applies the
// same fix for the same reason; without it `/ai-addons update` fails on every Windows install.
function cliCommand(name, args) {
  const argv = args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg));
  return IS_WINDOWS ? [process.env.ComSpec || "cmd.exe", ["/c", name, ...argv]] : [name, argv];
}

// Same path the installer uses: npx runs the pack's own `update`. GitHub source first (the fork
// publishes from there), npm package as the fallback once it is published. Writes never happen here
// — the pack's installer owns the extensions tree.
function tokenSaverSources() {
  return [
    { label: PACK_GIT_SOURCE, args: ["--yes", "--allow-git=all", PACK_GIT_SOURCE, "update", "--yes"] },
    { label: PACK_NPM_SPEC, args: ["--yes", PACK_NPM_SPEC, "update", "--yes"] },
  ];
}

async function updateTokenSaver(pi, ctx, dryRun = false) {
  const sources = tokenSaverSources();
  if (dryRun) {
    const m = `Token saver dry-run: would run \`npx ${sources[0].args.join(" ")}\`, falling back to \`npx ${sources[1].args.join(" ")}\`.`;
    notify(ctx, m, "info");
    return m;
  }
  const failures = [];
  for (const source of sources) {
    notify(ctx, `Token saver: running npx ${source.label} update…`, "info");
    try {
      const [command, argv] = cliCommand("npx", source.args);
      // Same reason: a stalled npx (git source or registry) must not hold the handler open forever.
      const r = await pi.exec(command, argv, { timeout: 300000 });
      const out = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
      if (r.code !== 0) throw new Error(r.stderr || `npx exited ${r.code}`);
      const m = `Token saver updated via ${source.label}.${out ? `\n${out}` : ""}\n${RELOAD_MSG}`;
      notify(ctx, "Token saver update finished. " + RELOAD_MSG, "info");
      return m;
    } catch (e) {
      failures.push(`${source.label}: ${e.message}`);
    }
  }
  const m = `Token saver update failed:\n${failures.join("\n")}`;
  notify(ctx, m, "warning");
  return m;
}

export default function aiAddonsUpdaterExtension(pi) {
  pi.setLabel?.("AI add-ons updater");

  const USAGE = "/ai-addons <check|status|update ponytail|rtk|caveman|tokensaver|all|level on|off> [--dry-run]";

  pi.registerCommand("ai-addons", {
    description: "Check or update AI add-ons (ponytail/rtk/caveman/tokensaver/all) and the startup notice. Usage: " + USAGE,
    handler: async (args, ctx) => {
      const arg = String(args || "").trim().toLowerCase();
      const parts = arg.split(/\s+/).filter(Boolean);
      const dryRun = parts.includes("--dry-run") || parts.includes("dry-run");
      const cleanParts = parts.filter((p) => p !== "--dry-run" && p !== "dry-run");
      const sub = cleanParts[0];

      if (sub === "check" || sub === "status") {
        const summary = await checkAddons(ctx);
        notify(ctx, "ai-addons check complete.", "info");
        return summary;
      }
      // The startup notice is a stored preference like the suite's `/omp-addons level`: `off` stops the
      // session-start check without removing the command.
      if (sub === "level") {
        if (cleanParts[1] === "on" || cleanParts[1] === "off") {
          await writeJsonFile(CONFIG_PATH, {
            ...((await readJsonFile(CONFIG_PATH)) || {}),
            checkOnStart: cleanParts[1] === "on",
          });
        }
        const config = await loadStartupConfig();
        const m = `ai-addons: startup check ${config.checkOnStart ? "on" : "off"}, ` +
          `every ${config.intervalHours}h (${CONFIG_PATH})`;
        notify(ctx, m, "info");
        return m;
      }
      if (sub === "update" && cleanParts[1]) {
        const target = cleanParts.slice(1).join(" ");
        const results = [];
        if (target === "ponytail") {
          results.push(await updatePonytail(pi, ctx, dryRun));
        } else if (target === "rtk") {
          results.push(await updateRtk(ctx, dryRun));
        } else if (target === "caveman") {
          results.push(await updateCaveman(ctx, dryRun));
        } else if (target === "tokensaver" || target === "token-saver" || target === "ts") {
          results.push(await updateTokenSaver(pi, ctx, dryRun));
        } else if (target === "all") {
          notify(ctx, `ai-addons update all${dryRun ? " dry-run" : ""}: starting ponytail → rtk → caveman → tokensaver sequentially…`, "info");
          results.push(await updatePonytail(pi, ctx, dryRun));
          results.push(await updateRtk(ctx, dryRun));
          results.push(await updateCaveman(ctx, dryRun));
          results.push(await updateTokenSaver(pi, ctx, dryRun));
          if (!dryRun) results.push(RELOAD_MSG);
          notify(ctx, `ai-addons update all ${dryRun ? "dry-run " : ""}complete.${dryRun ? "" : ` ${RELOAD_MSG}`}`, "info");
        } else {
          const m = "Usage: /ai-addons update <ponytail|rtk|caveman|tokensaver|all> [--dry-run]";
          notify(ctx, m, "warning"); return m;
        }
        return results.join("\n\n");
      }

      notify(ctx, `Usage: ${USAGE}`, "warning");
      return USAGE;
    },
  });

  pi.on("session_start", (_event, ctx) => {
    // Fire and forget: the handler resolves immediately, so startup is never gated on GitHub.
    runStartupCheck(ctx).catch(() => {});
  });
}
