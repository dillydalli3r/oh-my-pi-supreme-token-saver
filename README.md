# oh-my-pi-supreme-token-saver (fork)

A fork of [`@fernado03/oh-my-pi-supreme-token-saver`](https://www.npmjs.com/package/@fernado03/oh-my-pi-supreme-token-saver)
for [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi). It ships six presets (`off` → `ultra`) over
eight knobs — `caveman`, `rtk`, `ponytail`, `read`, `compress`, `prune`, `autoRtk`, `status` — behind one
command surface (`/token-saver`, alias `/ts`; `/combo` kept as a preset-only alias) and one footer row.
The `read`, `compress` and `prune` knobs drive OMP's **own** native token-economy settings
(`read.summarize.*`, `shellMinimizer.*`, `compaction.*`, artifact spill, `read.defaultLimit`) through
`omp config`, gated by `options.native.mode`; the preset supplies those knobs' starting levels plus four
tier dials (`task.*`, `tools.intentTracing`, `skillful`) that no single knob owns. On top of that it adds
three prompt-level add-ons — caveman terseness, RTK shell guidance, Ponytail code minimalism — and a
passive Amanai reward detector that only raises a local notice
when a completed final response contains a footer-shaped `AMANAI-GACHA-…` key; it never stores, sends, or
redeems the key. The pack reports no measured saving of its own.

## What this actually saves — read before installing

**The largest lever in an OMP session is not compression, and it is not this pack.** OMP already ships
structural read summaries (`read.summarize.*`), the shell-output minimizer (`shellMinimizer.*`), artifact
spill (`tools.artifact*`), and cache-aware pruning of stale reads (`compaction.supersedeReads`,
`compaction.dropUseless`), all ON by default. Verified against a stock `omp config`:
`read.summarize.enabled=true`, `shellMinimizer.enabled=true`, `compaction.supersedeReads=true`,
`compaction.dropUseless=true`. This pack runs none of that itself: the `read`, `compress` and `prune` knobs
select those host settings and tune their thresholds, key by key, under [Native settings](#native-settings).
One honest consequence: a knob level named `off` writes `false` into its keys, so a preset carrying
`read=off` / `prune=off` (presets `off`, `lite`, and `medium` for `prune`) turns the host's summaries and
pruning **off** rather than leaving stock behaviour alone. Stock behaviour is what preset `off` restores,
by resetting those keys instead of writing values.

Measured evidence, so you can calibrate expectations:

- **RTK-style shell-command rewriting is not a reliable win.** Independent paired A/B measurement of
  RTK-style rewriting ([JetBrains, 2026-07](https://blog.jetbrains.com/ai/2026/07/rtk-claude-code-token-savings/))
  found the bill went **up 7.6%** at low reasoning effort (p=0.004), with turns +13.8% and cache reads
  +14.3%, and was flat (±0.1%) at high effort — task quality unchanged throughout. RTK's own `rtk gain`
  reported ~96M tokens saved on that same run. Only ~33% of Bash calls were rewriteable, about 20% of
  tool-result characters, i.e. roughly **3% of input tokens**.
- **Caveman-style terseness is the one prompt-level lever with a measured, consistent effect:** −8.5%
  output tokens in the same benchmark series
  ([JetBrains, 2026-07](https://blog.jetbrains.com/ai/2026/07/speak-to-ai-agents-like-cavemen-tosave-tokens/)),
  with quality statistically flat.
- **Observation masking** — replacing old tool results with placeholders instead of summarizing them —
  measured ~**−52% cost at quality parity**
  ([arXiv:2508.21433](https://arxiv.org/abs/2508.21433)). That is why this pack relies on OMP's native
  `compaction.supersedeReads` / `compaction.dropUseless` rather than shipping its own JS history pruner.
- **Context rot is real and monotonic in input length**
  ([Chroma research](https://www.trychroma.com/research/context-rot)), so omission beats summarization:
  dropping a stale tool result is worth more than restating it.

Conclusion: treat every number this pack prints (including `/rtk gain` and the `👁` meter) as an estimate,
and measure your own bill with a paired A/B before believing any of it. **Never let `rtk gain` be the
success metric** — it is the CLI's own self-reported counter and it disagreed with the paired measurement
above.

## Install

From a clone:

```bash
git clone https://github.com/dillydalli3r/oh-my-pi-supreme-token-saver
cd oh-my-pi-supreme-token-saver
node install-omp-addons.js install --yes
```

Windows: run `install.bat` in the clone — no arguments runs `node install-omp-addons.js install --yes`,
and any arguments pass straight through (`install.bat --dry-run`, `install.bat doctor`,
`install.bat update --verbose`).

Without cloning:

```bash
npx --yes --allow-git=all github:dillydalli3r/oh-my-pi-supreme-token-saver install --yes
```

`--preset <name>` seeds `~/.omp/agent/token-saver.json` **only when that file does not exist yet**;
`--force-preset` lets `--preset` overwrite an existing one.

**After install: restart OMP.** The installer copies the extensions into `~/.omp/agent/extensions`,
registers them in `~/.omp/agent/config.yml`, installs the Ponytail plugin and the RTK binary, and writes
`hideStatus=true` / `quietStartup=true` to the Ponytail plugin config so only the pack's own row shows.
The installer never writes OMP's native settings — that layer is opt-in (see
[Native settings](#native-settings)).

## Presets

Exactly the table in `PRESETS` (`extensions/shared/session-state.js`). Every preset sets every knob, so a
state either matches a preset or reports as `custom`.

| Knob | off | lite | medium | high | max | ultra |
|---|---|---|---|---|---|---|
| `caveman` | off | lite | full | ultra | ultra | ultra |
| `rtk` | off | on | on | on | on | on |
| `ponytail` | off | lite | full | full | ultra | ultra |
| `read` | off | off | lite | full | full | full |
| `compress` | off | lite | full | full | full | ultra |
| `prune` | off | off | off | lite | full | ultra |
| `autoRtk` | off | on | on | on | on | on |
| `status` | full | full | full | full | full | compact |

Accepted values per knob: `caveman` `off|lite|full|ultra|wenyan` · `rtk` `off|on` · `ponytail`
`off|lite|full|ultra` · `read` `off|lite|full` · `compress` `off|lite|full|ultra` · `prune`
`off|lite|full|ultra` · `autoRtk` `off|on` · `status` `off|compact|full`.

The stored default for new sessions is `max` until changed with `/ts default <preset>`.

The `read`, `compress` and `prune` columns are **knob levels, not OMP settings**: each level names the exact
native keys it writes (see [Native settings](#native-settings)), and preset `off` pins nothing — it resets
those mapped keys to the host defaults instead of writing anti-defaults.

## Commands

One surface. `/token-saver` and `/ts` are identical; `/combo` accepts preset names only and rejects the
other verbs.

| Command | Effect |
|---|---|
| `/ts` or `/ts status` | Preset, every knob, context meter, config path, native gate, stored default |
| `/ts <preset>` or `/ts preset <preset>` | Apply a preset to this session (also `/combo <preset>`) |
| `/ts set <knob>=<value> …` | Set one or more knobs for this session; all pairs validated before any is written |
| `/ts default` | Show what new sessions start from |
| `/ts default <preset>` | Store a preset as the default for new sessions |
| `/ts default <knob>=<value> …` | Store a partial override (displays as `custom`) |
| `/ts default reset` | Delete the config file; back to built-in `max` |
| `/ts option <group>.<key>=<value>` | Set a behaviour option for new sessions — `autoRtk.timeoutMs`, `autoRtk.exclude`, `native.mode` (the whole option list) |
| `/ts native [status\|on\|off\|apply\|reset]` | Inspect/apply OMP's own settings; `on` is an alias for `auto` |
| `/ts headroom [status\|unwrap\|wrap\|install]` | Optional external Headroom proxy: report status, `unwrap` in-session; `wrap`/`install` refuse and name the command to run yourself (see [Optional: Headroom](#optional-headroom)) |
| `/ts help` | Usage, knob list, option list |

Applying a preset or `set` persists session entries and reloads the session. `/ts set ponytail=<mode>`
additionally appends the `ponytail-mode` entry the upstream Ponytail plugin reads for its own session
state — without it the knob change would be display-only.

Individual add-ons:

```text
/caveman [lite|full|ultra|wenyan|off|status]   bare = full
/rtk [on|off|status|gain]                      gain prints RTK's self-reported counters
/rtk auto [on|off|status]                      automatic rewrite of eligible bash commands
/ponytail [lite|full|ultra|off|status]         provided by the Ponytail plugin, not by this repo
/ai-addons <check|status>                      version check for ponytail / rtk / caveman / tokensaver
/ai-addons update <ponytail|rtk|caveman|tokensaver|all> [--dry-run]
```

Natural-language off switch for caveman: a bare input of `caveman off`, `stop caveman`, or `normal mode`
sets it back to `off` for the session.

## Native settings

`omp config` is the only writer of `~/.omp/agent/config.yml` (path confirmed via `omp config path`).
**The knobs are the dial.** Each level of the `read`, `compress` and `prune` knobs names exactly which OMP
keys that level writes; the preset supplies the level each knob starts at (the [presets table](#presets))
plus the four tier dials that no single knob owns (`tools.intentTracing`, `task.maxEffort`,
`task.softRequestBudget`, `skillful`). A state that is not exactly one of the six presets keeps the dials of
the built-in `max` tier, and `/ts native status` reports it as `tier: max (state is custom)`.

The pack writes these keys **only if `options.native.mode` is `auto`**. The default is `off`: presets then
never touch your OMP config, and `/ts native apply` is the only way to write it.

### Knob `read` — structural read summaries

Levels: `off` · `lite` · `full`.

| OMP key | off | lite | full | What it is |
|---|---|---|---|---|
| `read.summarize.enabled` | false | true | true | Structural code summaries for selector-less reads |
| `read.summarize.prose` | false | false | true | Structural summaries for Markdown/plain-text reads |
| `read.summarize.minTotalLines` | 100 | 100 | 60 | Files shorter than this are read verbatim instead of summarized |
| `read.summarize.unfoldLimit` | 100 | 100 | 60 | Ceiling on summary size while BFS-unfolding; larger spans stay folded |
| `read.defaultLimit` | 300 | 300 | 200 | Default line count for a read with no limit |

### Knob `compress` — shell output and artifact spill

Levels: `off` · `lite` · `full` · `ultra`.

| OMP key | off | lite | full | ultra | What it is |
|---|---|---|---|---|---|
| `shellMinimizer.enabled` | false | true | true | true | Compress verbose shell output (git, npm, cargo, …) before returning it |
| `shellMinimizer.sourceOutlineLevel` | default | default | default | aggressive | Source outline mode for `cat`/`read` of source files |
| `tools.artifactSpillThreshold` | 50 | 50 | 20 | 10 | Tool output above this size spills to an artifact, tail kept inline |
| `tools.artifactTailBytes` | 20 | 20 | 12 | 8 | Tail content kept inline when output spills |
| `tools.artifactHeadBytes` | 20 | 20 | 12 | 0 | Head kept inline alongside the tail; `0` = tail only |
| `tools.artifactTailLines` | 500 | 500 | 300 | 200 | Maximum tail lines kept inline when output spills |

### Knob `prune` — cache-aware elision of stale results

Levels: `off` · `lite` · `full` · `ultra`.

| OMP key | off | lite | full | ultra | What it is |
|---|---|---|---|---|---|
| `compaction.supersedeReads` | false | true | true | true | Prune older read results when the same file is read again (cache-aware) |
| `compaction.dropUseless` | false | false | true | true | Prune tool results flagged contextually useless (no matches, timed-out waits) |
| `compaction.keepRecentTokens` | 20000 | 20000 | 12000 | 8000 | Verbatim-history floor left after a compaction |
| `compaction.idleEnabled` | false | false | false | true | Compact while idle when the token count exceeds threshold |

`compaction.keepRecentTokens` is the main dial on post-compaction context size: it is the verbatim-history
floor left after a compaction, and everything above that floor is what a compaction may elide.

### Tier dials — per preset, not per knob

| OMP key | lite | medium | high | max | ultra | What it is |
|---|---|---|---|---|---|---|
| `tools.intentTracing` | true | true | false | false | false | Ask the agent to describe each tool call's intent before executing it |
| `task.maxEffort` | max | max | high | high | medium | Ceiling on the `task` tool's per-spawn reasoning effort |
| `task.softRequestBudget` | 200 | 200 | 200 | 150 | 90 | Soft request budget per subagent; 1.5× force-stops the run |
| `skillful` | true | true | true | true | false | List available skills in the system prompt |

Notes that matter:

- Two defaults are inverted and worth knowing: **`tools.intentTracing` defaults ON** and adds an intent
  string to every tool call — only `high` and above turn it off. **`skillful` defaults ON** and ships the
  skill inventory in the system prompt — only `ultra` drops it, and that is a real functionality tradeoff.
- `tools.artifactHeadBytes=0` under `compress=ultra` means **tail-only spill**: nothing from the head of a
  spilled output is kept inline.
- `off` as a *knob level* is a real setting, not a no-op: `read=off` writes `read.summarize.enabled=false`
  and `prune=off` writes `compaction.supersedeReads=false` plus `compaction.dropUseless=false`. That turns
  the host's summaries and pruning off — the presets `off` and `lite` carry `read=off`, and `off`, `lite`
  and `medium` carry `prune=off`.
- `off` as a *preset* is different: it writes no keys at all and instead resets all 19 keys in these tables
  to whatever OMP then considers sane, which is more durable than pinning `false`.
- Deliberately untouched: `provider.appendOnlyContext`, `memory.backend`, `advisor`/`autolearn`/`prewalk`,
  `snapcompact`, and every display/statusLine/tui key — display keys cost no model tokens.
- `/ts native reset` runs one `omp` process per key (19). A missing `omp` CLI degrades to a warning
  (`Native settings unavailable: … config.yml untouched.`); the preset itself still applies.

## Optional: Headroom

[Headroom](https://github.com/headroomlabs-ai/headroom) (Apache-2.0) is a context-compression layer that runs
between an agent and its model provider and rewrites tool output, logs and history before they are sent. It is a
**Python** package (`headroom-ai`) whose compression core is a CPython extension: the npm `headroom-ai` package is
a TypeScript SDK with no `bin`, and there is no standalone binary to download. Version 0.37.0 at the time of
writing — **198 PyPI releases since January 2026 and still no 1.0**. Read that plainly: it is a fast-moving
pre-1.0 tool, so pin it and read its changelog before you depend on any of it.

**This pack does not bundle Headroom, does not depend on it, and never installs it.** It only detects it: `doctor`
reports it, and `/ts headroom` reports and unwraps it. Nothing here starts Headroom or routes your traffic for you.

### What it measured for us — and what it did not

Probed here through Headroom's own shipped `compress()` API:

| Input | Measured reduction |
|---|---|
| JSON / structured log output | ~37-45% |
| Shell output | ~0% |
| Prose | ~0% |

**These are our own probe measurements, not vendor benchmarks, and nothing here has been independently
reproduced.** They say something narrower than the word "compression": Headroom's win is repetitive structured
payloads. Shell transcripts and prose — most of what an OMP session actually carries — came back essentially
unchanged.

### The limitation that decides it

`headroom wrap omp` works by injecting a marker-fenced `providers.anthropic.baseUrl` override into
`~/.omp/agent/models.yml` (backed up byte-for-byte pre-wrap; `headroom unwrap omp` restores it). **It only
redirects the `anthropic` provider.** A session running on any other provider — OpenAI-direct, Gemini, DeepSeek,
whatever else — keeps its normal endpoint and the wrap changes nothing at all. It redirects the provider, not the
tool output, so it applies to a whole session or to none of it.

This pack's native-settings layer already covers structural read summaries (`read.summarize.*`), shell-output
minimisation (`shellMinimizer.*`) and pruning of stale results (`compaction.supersedeReads`,
`compaction.dropUseless`) without an external process, a proxy, or a second config file — the `read`,
`compress` and `prune` knobs select those settings, and only under `native.mode=auto`. For most sessions that is
the better trade. Reach for Headroom when you are on Anthropic and feeding the model large repetitive JSON or log
dumps.

### Install (outside this pack)

```bash
uv tool install --python 3.13 "headroom-ai[all]"   # canonical — self-contained app env
pip install "headroom-ai[all]"                     # or into the current Python
npm install headroom-ai                            # TypeScript SDK only — no `headroom` command
```

Docker: `docker pull ghcr.io/headroomlabs-ai/headroom:latest` (headroom's own upstream image). Windows: the
prebuilt wheel installs without a toolchain — a source build needs MSVC **and** a Rust toolchain, because the
compression core is a CPython extension rather than a standalone binary.

### Use, and how to get back out

Run `headroom wrap omp` **from your own shell, never from inside a session**: it starts the proxy *and* launches a
new `omp`, so running it inside a live session nests OMP inside OMP. After that:

| Command | Effect |
|---|---|
| `/ts headroom` (or `/ts headroom status`) | Headroom version, wrap state, and whether a wrap would even cover this session's provider |
| `/ts headroom unwrap` | Restore the pre-wrap `models.yml` (runs `headroom unwrap omp`; safe from inside a session) |
| `/ts headroom wrap` | Refuses, prints the command to run yourself — starting it here would nest OMP |
| `/ts headroom install` | Refuses, prints the uv/pip/Docker lines above — this pack installs nothing for you |

## Configuration file

`~/.omp/agent/token-saver.json`. Only keys that were set appear; the installer seeds the minimal form:

```json
{ "version": 2, "preset": "max" }
```

After `/ts default max`, `/ts default ponytail=off`, `/ts option autoRtk.exclude=[".git"]` and
`/ts option native.mode=auto`, the same file reads:

```json
{
  "version": 2,
  "preset": "max",
  "modes": { "ponytail": "off" },
  "options": {
    "autoRtk": { "exclude": [".git"] },
    "native": { "mode": "auto" }
  }
}
```

- `preset` replaces every mode; `modes` are per-knob overrides that win over the preset for the keys they
  set, so a partial config stays a partial override. Writing a preset with `/ts default <preset>` deletes
  every mode override, which is what makes it stick.
- `/ts default <preset|knob=value|reset>` writes `preset`/`modes` (`reset` deletes the file). It changes
  what **new** sessions start from; the running session is untouched.
- `/ts option <group>.<key>=<value>` writes `options.<group>.<key>`. Only two groups exist, and the value
  type decides the syntax: `autoRtk.timeoutMs` takes a number, `autoRtk.exclude` takes a JSON array
  (`/ts option autoRtk.exclude=[".git","dist"]`), and `native.mode` is a string — `auto` makes presets and
  knob changes write `config.yml`, anything else (including `off`) leaves it alone. Unknown groups, unknown
  keys, a non-numeric `timeoutMs`, and an `exclude` that is not a JSON array are rejected with a usage
  line. Options describe behaviour (timeouts, exclusion lists, the native gate), not intensity. They are
  stored for the sessions that follow, but two of them are read at different times: `autoRtk.*` is cached
  when a session starts, while `native.mode` is read at every native write, so flipping it takes effect on
  the running session's next preset or knob change.
- The stored defaults are `autoRtk.timeoutMs=2000`, `autoRtk.exclude=[]`, `native.mode=off`, so a fresh
  file needs no `options` block at all.
- Choosing a ponytail default also pushes it into the Ponytail plugin's own config, and reports
  `[pending] Ponytail plugin not found` when that write fails.
- Legacy migration: if `token-saver.json` is absent, the pre-2.0 `~/.omp/agent/combo-defaults.json`
  (bare `caveman`/`rtk`/`ponytail` keys) is read once so an upgrade keeps your level. The next write goes
  to `token-saver.json` and deletes the legacy file.

Environment overrides:

| Variable | Overrides |
|---|---|
| `OMP_TOKEN_SAVER_CONFIG` | Path of `token-saver.json` |
| `OMP_COMBO_DEFAULTS_FILE` | Path of the legacy `combo-defaults.json` |
| `OMP_PONYTAIL_PACKAGE_DIR` | Location of the Ponytail plugin package (default reading/writing of its `defaultMode`) |

## Status row

`extensions/shared/status-line.js` is the **only** module that writes the `modes` status key, so a knob's
symbol never depends on how the value was set (`/ts`, a per-app command, or the stored default). One row,
full form:

```text
🧩 MAX · 🦴 caveman: ULTRA · 🦀 rtk: ON · 🐴 ponytail: ULTRA · 📖 read: FULL · 🗜️ compress: FULL · 🧹 prune: FULL · 🔁 auto: ON · 👁 42% ctx
```

Compact form (`preset ultra`, or `status compact`):

```text
🧩 ULTRA · 🦴U · 🦀ON · 🐴U · 📖F · 🗜️U · 🧹U · 🔁ON · 👁42%
```

- The meter (`👁 NN% ctx`) is appended only when context usage is known; the usage value is published once
  per `turn_end`/`message_end` and read back from shared state.
- `status off` removes the row entirely (the key is deleted, not blanked).
- Rendering is display-only: nothing in the status module changes a mode.

## File locations

| What | Path |
|---|---|
| Token Saver extension (commands, presets, native driver) | `~/.omp/agent/extensions/token-saver/` |
| Shared modules (`session-state.js`, `status-line.js`, `mode-reinforcement.js`) | `~/.omp/agent/extensions/shared/` |
| Caveman extension | `~/.omp/agent/extensions/caveman-session/` |
| RTK extension | `~/.omp/agent/extensions/rtk-session/` |
| Updater extension (`/ai-addons`) | `~/.omp/agent/extensions/ai-addons-updater/` |
| Amanai reward detector | `~/.omp/agent/extensions/amanai-reward/` |
| Ponytail plugin | `~/.omp/plugins/node_modules/@dietrichgebert/ponytail/` |
| Ponytail plugin config (`defaultMode`, `hideStatus`, `quietStartup`) | `$XDG_CONFIG_HOME/ponytail/config.json`, else `%APPDATA%\ponytail\config.json`, else `~/.config/ponytail/config.json` |
| RTK binary | `~/.bun/bin/rtk` (`rtk.exe` on Windows) |
| Session defaults | `~/.omp/agent/token-saver.json` |
| Legacy pre-2.0 defaults (read once, deleted on first write) | `~/.omp/agent/combo-defaults.json` |
| OMP native settings and extension registrations | `~/.omp/agent/config.yml` |
| OMP model config (what an external `headroom wrap omp` edits) | `~/.omp/agent/models.yml` |
| Project scope install target | `./.omp/extensions` |

Pre-2.0 shipped a separate `combo-toggle` extension directory. 2.0 has no such directory: `/combo` is
registered by `token-saver`.

## Troubleshooting

### `/combo` is missing after upgrading

A pre-2.0 install left `~/.omp/agent/extensions/combo-toggle/` and its `config.yml` entries behind, and
OMP would load that duplicate instead of the 2.0 surface. Fix by reinstalling — the installer removes the
stale directory and its `config.yml` lines:

```bash
oh-my-pi-supreme-token-saver reinstall
```

`oh-my-pi-supreme-token-saver doctor` reports it either way:
`combo-toggle (pre-2.0): STALE <path>` plus `[warn] config.yml still lists combo-toggle — rerun: install --yes`.

### RTK is missing or not executable

`oh-my-pi-supreme-token-saver reinstall`, then `doctor`. On Linux/macOS a hand-installed binary can be
repaired with `chmod +x ~/.bun/bin/rtk`. `/rtk status` shows the toggle; a failed spawn or timeout leaves
the command unchanged rather than failing the tool call. Remember the A/B result above before enabling
`autoRtk` for the sake of savings.

### Ponytail default drifts from the reported default

The Ponytail plugin owns its own default. `/ts default <preset>` pushes it via the plugin's
`writeDefaultMode`, but `PONYTAIL_DEFAULT_MODE` in the environment outranks the config file. Locate the
plugin with `OMP_PONYTAIL_PACKAGE_DIR` if it is installed somewhere non-standard, and check both values
with `/ponytail status` (it prints `current <mode> • default <mode>`).

### `omp config` unavailable

The native layer is optional. With no `omp` CLI on the path, `/ts native …` and preset-time native writes
report `Native settings unavailable: … config.yml untouched.` as a warning — the preset still applies and
no OMP file is modified. Everything else in the pack is unaffected.

### Headroom wrap left behind after an experiment

If `models.yml` is still wrapped after a Headroom experiment, `/ts headroom unwrap` — or `headroom unwrap omp`
from your own shell — restores the pre-wrap file byte-for-byte; `doctor` reports the state either way
(`Headroom wrap: wrapped (models.yml anthropic baseUrl)` / `not wrapped`).

### WSL

Windows and WSL have separate OMP homes. Run the install from inside WSL and check `command -v npm`: it
must resolve to a Linux path such as `~/.nvm/versions/node/.../bin/npm`, not a Windows path under
`/mnt/c/`, or the add-ons land in the Windows OMP home instead.

## CLI

Entry point: `oh-my-pi-supreme-token-saver` (`install-omp-addons.js`).

| Command | Purpose |
|---|---|
| `install` | Install the add-ons; user scope by default |
| `update` | Run the latest installer — npm package first, GitHub source as fallback |
| `reinstall` | Clean and reinstall the user-scope add-ons |
| `doctor` | Check OMP, extension, Ponytail, RTK, and Headroom health (including the stale `combo-toggle` check; a missing Headroom is reported as optional, never fatal) |
| `uninstall` | Remove the managed extensions |
| `version` | Print the package version |
| `help` | Print usage |

| Flag | Effect |
|---|---|
| `--scope user\|project\|both` | Install scope (default `user`; accepts `--scope=user` too) |
| `--preset <off\|lite\|medium\|high\|max\|ultra>` | Seed the default preset, only when `token-saver.json` is absent |
| `--force-preset` | Let `--preset` overwrite an existing `token-saver.json` |
| `--remove-ponytail` | Uninstall: also drop the Ponytail plugin entry from `config.yml` |
| `--remove-rtk` | Uninstall: also delete the RTK binary |
| `--yes`, `-y` | Non-interactive |
| `--dry-run` | Preview writes; nothing touches disk |
| `--verbose` | Debug output |
| `--version`, `-v` / `--help`, `-h` | Same as `version` / `help` |

## License

MIT
