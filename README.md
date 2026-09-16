# omp-supreme-token-saver (fork)

A fork of [`@fernado03/oh-my-pi-supreme-token-saver`](https://www.npmjs.com/package/@fernado03/oh-my-pi-supreme-token-saver)
for [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi). It ships six presets (`off` → `ultra`) over
nine knobs — `caveman`, `rtk`, `ponytail`, `read`, `compress`, `prune`, `threshold`, `autoRtk`, `status` —
behind one command surface (`/token-saver`, alias `/ts`; `/combo` kept as a preset-only alias) and one footer row
that spells every knob out by default (`/ts set status=full` trades the names for one icon and one letter per knob).
The `read`, `compress`, `prune` and `threshold` knobs drive OMP's **own** native token-economy settings
(`read.summarize.*`, `shellMinimizer.*`, `compaction.*`, artifact spill, `read.defaultLimit`) through
`omp config`, gated by `options.native.mode`; the preset supplies those knobs' starting levels plus four
tier dials (`task.*`, `tools.intentTracing`, `skillful`) that no single knob owns. On top of that it adds
three prompt-level add-ons — caveman terseness, RTK shell guidance, Ponytail code minimalism — and a
passive Amanai reward detector that only raises a local notice
when a completed final response contains an `AMANAI-GACHA-…` key anywhere in its text; it never stores, sends, or
redeems the key. The pack reports no measured saving of its own.

## What this actually saves — read before installing

**The largest lever in an OMP session is not compression, and it is not this pack.** OMP already ships
structural read summaries (`read.summarize.*`), the shell-output minimizer (`shellMinimizer.*`), artifact
spill (`tools.artifact*`), and cache-aware pruning of stale reads (`compaction.supersedeReads`,
`compaction.dropUseless`), all ON by default. Verified against a stock `omp config`:
`read.summarize.enabled=true`, `shellMinimizer.enabled=true`, `compaction.supersedeReads=true`,
`compaction.dropUseless=true`. This pack runs none of that itself: the `read`, `compress`, `prune` and
`threshold` knobs select those host settings and tune their thresholds, key by key, under
[Native settings](#native-settings).
One honest consequence: a knob level named `off` writes `false` into its keys, so a preset carrying
`read=off` / `prune=off` (presets `lite`, and `medium` for `prune`) turns the host's summaries and
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

Conclusion: treat every number this pack prints (including `/rtk gain`) as an estimate,
and measure your own bill with a paired A/B before believing any of it. **Never let `rtk gain` be the
success metric** — it is the CLI's own self-reported counter and it disagreed with the paired measurement
above.

## Install

Two ways in, and only one of them may be active at a time — both register the same six extension
modules, so running the installer on top of a marketplace install (or the reverse) loads every module
twice. Pick one; to switch, run the cutover in [CLI](#cli): `uninstall --legacy-only` removes the legacy
tree and its `config.yml` entries, `plugin` adds the runtime dependencies the marketplace does not
carry, and `omp plugin install` supplies the modules.

From a clone — the installer copies the modules into `~/.omp/agent/extensions` and registers them in
`~/.omp/agent/config.yml`:

```bash
git clone https://github.com/dillydalli3r/omp-supreme-token-saver
cd omp-supreme-token-saver
node install-omp-addons.js install --yes
```

As a marketplace plugin — omp reads the modules from the package's own `omp.extensions` (below), with
no `config.yml` entries and no copies. The marketplace carries no runtime dependencies, so the Ponytail
plugin and the rtk binary come from the installer's `plugin` verb:

```bash
omp plugin marketplace add dillydalli3r/omp-addons
omp plugin install supreme-token-saver@omp-addons
node install-omp-addons.js plugin --yes    # ponytail + rtk only; no extension copying
```

Windows: run `install.bat` in the clone — no arguments runs `node install-omp-addons.js install --yes`,
and any arguments pass straight through (`install.bat --dry-run`, `install.bat doctor`,
`install.bat update --verbose`). The window waits for a keypress before it closes, so a failure is
readable instead of a window that vanishes.

Without cloning:

```bash
npx --yes --allow-git=all github:dillydalli3r/omp-supreme-token-saver install --yes
```

`--preset <name>` seeds `~/.omp/agent/token-saver.json` **only when that file does not exist yet**;
`--force-preset` lets `--preset` overwrite an existing one.

**After install: restart OMP.** The installer copies the extensions into `~/.omp/agent/extensions`,
registers them in `~/.omp/agent/config.yml`, installs the Ponytail plugin and the RTK binary, and writes
`hideStatus=true` / `quietStartup=true` to the Ponytail plugin config so only the pack's own row shows.
The installer never writes OMP's native settings — that layer is opt-in (see
[Native settings](#native-settings)).

### What loads

`package.json` `omp.extensions` declares every module, in load order:

| # | Module | What it owns |
|---|---|---|
| 1 | `extensions/shared/mode-reinforcement.js` | the one model-facing reminder line |
| 2 | `extensions/caveman-session/index.js` | `/caveman`, and the rule injected for `full` |
| 3 | `extensions/rtk-session/index.js` | `/rtk`, `/rtk auto`, and the bash rewrite |
| 4 | `extensions/token-saver/index.js` | `/token-saver` (`/ts`), `/combo`, presets, the native driver |
| 5 | `extensions/ai-addons-updater/index.js` | `/ai-addons` — version checks, the startup notice, updates |
| 6 | `extensions/amanai-reward/index.js` | the passive reward-key detector |

A non-empty `omp.extensions` array is authoritative: a module missing from that list is a silently
missing feature, not a fallback to convention. `extensions/shared/session-state.js` and
`extensions/shared/status-line.js` are libraries those six import — they export no factory, so they are
not loaded as extensions and are not in the list. `pi.extensions` still names `amanai-reward/pi.js` for
the pre-2.0 manifest key; the loader treats it as the legacy alternative, never as a second copy.

## Presets

Exactly the table in `PRESETS` (`extensions/shared/session-state.js`) — plus the two knobs that are not
columns: `status` (the row's shape, which no preset sets) and the `headroom` switch, documented just below.
Every preset sets every *behaviour* knob, so a state either matches a preset or reports as `custom`.

| Knob | off | lite | medium | high | max | ultra |
|---|---|---|---|---|---|---|
| `caveman` | off | lite | full | ultra | ultra | ultra |
| `rtk` | off | on | on | on | on | on |
| `autoRtk` | off | on | on | on | on | on |
| `ponytail` | off | lite | full | full | ultra | ultra |
| `read` | off | off | lite | full | full | full |
| `compress` | off | lite | full | full | full | ultra |
| `prune` | off | off | off | lite | full | ultra |
| `threshold` | off | off | off | lite | full | ultra |
| `headroom` | off | off | off | off | off | **on** |

Accepted values per knob: `caveman` `off|lite|full|ultra|wenyan` · `rtk` `off|on` · `ponytail`
`off|lite|full|ultra` · `read` `off|lite|full` · `compress` `off|lite|full|ultra` · `prune`
`off|lite|full|ultra` · `threshold` `off|lite|full|ultra` · `autoRtk` `off|on` · `headroom` `off|on` ·
`status` `off|preset|names|full`.

Two knobs are deliberately outside the table above:

- **`status` is not part of any preset.** It picks the footer row's *shape* — a display preference, not a
  behaviour — so applying a preset never relayouts the row under you. Set it with `/ts set status=…` in a
  session or `/ts default status=…` for new ones; it is a knob like the others, just not a preset column.
- **`headroom` is the one knob a preset switches**, and only `ultra` turns it on: `on` starts (or reuses) a
  proxy process and routes the session's provider traffic through it, which should not be a silent side effect
  of a token dial. See [Optional: Headroom](#optional-headroom).

The row is ordered by what belongs together, not by when a knob was added: `auto` (`autoRtk`) sits directly
after the `rtk` it drives — it rewrites eligible `bash` commands through the `rtk` binary before they run, while
the `rtk` knob is whether that binary is in play at all — and the four knobs that configure OMP's own token
economy (`read`, `compress`, `prune`, `threshold`) stay adjacent. `status` is last because it is not a
behaviour; it picks the row's own shape.

The stored default for new sessions is `max` until changed with `/ts default <preset>`, and its footer row starts
on the `names` shape until `/ts default status=<shape>` says otherwise.

The `read`, `compress`, `prune` and `threshold` columns are **knob levels, not OMP settings**: each level
names the exact native keys it writes (see [Native settings](#native-settings)), and preset `off` pins
nothing — it resets those mapped keys to the host defaults instead of writing anti-defaults.

## Commands

One surface. `/token-saver` and `/ts` are identical; `/combo` accepts presets plus `status`, `help`,
`preset` and `default`, and rejects the knob/option verbs.

| Command | Effect |
|---|---|
| `/token-saver` or `/ts` | Opens the settings menu — presets, knobs, stored defaults, options, `config.yml` — so nothing has to be typed or hand-edited. Prints the status text instead when the session has no selector (subagent, print run, RPC) |
| `/ts status` | The status text: preset, every knob, config path, native gate (plus the `/ts native on` line while the gate leaves the knob levels unwritten), stored default |
| `/ts config` (alias `/ts settings`) | The same menu, explicitly |
| `/ts <preset>` or `/ts preset <preset>` | Apply a preset to this session (also `/combo <preset>`) |
| `/ts set <knob>=<value> …` | Set one or more knobs for this session; all pairs validated before any is written |
| `/ts default` | Show what new sessions start from |
| `/ts default <preset>` | Store a preset as the default for new sessions |
| `/ts default <knob>=<value> …` | Store a partial override (displays as `custom` only when the resulting state matches no preset) |
| `/ts default reset` | Delete the config file; back to built-in `max` |
| `/ts option <group>.<key>=<value>` | Set a behaviour option for new sessions — `autoRtk.timeoutMs`, `autoRtk.exclude`, `native.mode`, `threshold.percent`, `threshold.tokens`, `threshold.pick` (the whole option list) |
| `/ts native [status\|on\|off\|apply\|reset]` | Inspect/apply OMP's own settings; `on` is an alias for `auto` |
| `/ts headroom [status\|wrap\|unwrap\|unwrap-models\|install]` | Optional external Headroom proxy: `wrap` routes this session's provider through it (any family the proxy carries, not just Anthropic), `unwrap` unroutes and stops a proxy the pack started (see [Optional: Headroom](#optional-headroom)) |
| `/ts help` | Usage, knob list, option list |

Applying a preset or `set` persists session entries and reloads the session. `/ts set ponytail=<mode>`
additionally appends the `ponytail-mode` entry the upstream Ponytail plugin reads for its own session
state — without it the knob change would be display-only.

Individual add-ons:

```text
/caveman [off|lite|full|ultra|wenyan|status]   bare = full
/rtk [on|off|status|gain]                      gain prints RTK's self-reported counters
/rtk auto [on|off|status]                      automatic rewrite of eligible bash commands
/ponytail [lite|full|ultra|off|status]         provided by the Ponytail plugin, not by this repo
/ai-addons <check|status>                      installed vs published version, per add-on
/ai-addons update <ponytail|rtk|caveman|tokensaver|all> [--dry-run]
/ai-addons level [on|off]                      the session-start update check (see below)
```

`tokensaver` is compared by version, not by date: the row reads the installed version from the tree's
version stamp, the marketplace lock file or the package.json it travels with, and the published one
from the repo's manifest (plus the npm registry when the package is there). A version it cannot resolve
is reported as `unknown` rather than guessed from a file's mtime.

The `full` rule is validated before it is injected. The installer may overwrite
`extensions/caveman-session/rule.md` with the upstream caveman text, which advertises
`wenyan-lite|wenyan-full|wenyan-ultra` — three levels `/caveman` here rejects — so a rule.md naming any
level the command does not take is not served: the copy bundled inside the extension is, which makes an
online and an offline install inject identical text. `/ai-addons update caveman` refuses to write such a
rule and says why instead of churning the file.

Natural-language off switch for caveman: a bare input of `caveman off`, `stop caveman`, or `normal mode`
sets it back to `off` for the session.

### Configuring it without typing commands

Typing `/token-saver` (or `/ts`) opens the settings as a menu — nothing to remember, nothing to
hand-edit. `/ts config` and `/ts settings` open the same menu; `/ts status` prints the text. Every
entry is a front end for the verb above it, so a pick reaches the same write the typed form reaches:

| Menu entry | What it opens |
|---|---|
| Preset | The six presets, each showing the knobs it sets; a pick applies it to the session |
| Knob | One knob, then its level, then where it goes — **This session** (`/ts set`) or **New sessions** (`/ts default`) |
| Footer row | The four row shapes, each option previewing the exact row it would render, then where it goes — **This session** (`/ts set status=`) or **New sessions** (`/ts default status=`) |
| Default for new sessions | The preset list plus `reset`, which deletes `token-saver.json` |
| Behaviour options | `autoRtk.timeoutMs`, `autoRtk.exclude`, `native.mode`, `threshold.percent`, `threshold.tokens`, `threshold.pick`; an enum picks from a list, a number or a list takes typed input |
| OMP's own settings | `status` / `apply` / `auto` / `off` / `reset` for `config.yml`, the `/ts native` verbs |
| Headroom | Proxy health, `wrap` / `unwrap` for this session, and `unwrap-models` for a durable wrap |
| Status | The same text `/ts status` prints |

Escape backs out of a level without writing. The menu needs the interactive TUI: a subagent, a print
run, or an RPC client (`hasUI: false`) prints the typed verb list instead. What it writes is the same
value a hand-edited `~/.omp/agent/token-saver.json` would hold, so the file and the menu stay
interchangeable.

## Startup update check

`extensions/ai-addons-updater/index.js` runs the same check `/ai-addons check` runs — once, off the
turn, at most once per stored interval. It never blocks startup: the `session_start` handler returns
immediately and the check resolves in the background, so a slow or unreachable GitHub cannot delay the
first prompt.

- **Throttle.** `ai-addons-state.json` holds `lastCheck`; anything inside the interval (default 6h)
  returns without a network call. The timestamp is written *before* the fetch, so a machine that is
  offline at every start does not re-attempt the whole set on every session.
- **One line, when it is news.** Nothing is said while every add-on is current. When something is
  outdated the notice names each one and the exact command to run, e.g.
  `ai-addons: 1 update: tokensaver 2.1.0 → 2.2.0 — run /ai-addons update tokensaver`. The same result is
  not announced twice: the state file also stores the signature of what was announced, so restarting
  a session does not repeat a nag no new release stands behind.
- **The native gap, named once.** The `read` / `compress` / `prune` / `threshold` knobs reach OMP's own
  settings only when `options.native.mode` is `auto`, and that gate stays `off` by default — writing
  `config.yml` is opt-in. While a session runs preset `high`, `max` or `ultra` with the gate off, the
  notice carries one extra line naming `/ts native on`. `/ts status` prints the same line (`Native knobs:
  …`) so it is there whenever it is asked for, and it disappears the moment the gate writes.
- **Off switch.** `/ai-addons level on|off` stores it; `level` alone reports it.

| File | What it holds |
|---|---|
| `~/.omp/agent/ai-addons.json` | `{"checkOnStart": true, "intervalHours": 6}` — the switch and the interval |
| `~/.omp/agent/ai-addons-state.json` | `{"lastCheck": …, "notified": "<signature>"}` |

Both sit next to `token-saver.json`, so `OMP_TOKEN_SAVER_CONFIG` moves them with it.

**Version sources.** The installed version is read from the most specific source that answers, and
reported as `unknown` when none does:

| # | Source | Layout |
|---|---|---|
| 1 | `<extensions>/.omp-token-saver-version` (the stamp an install writes; JSON or a bare version) | either |
| 2 | `<plugins>/omp-plugins.lock.json` → `plugins["@dillydalli3r/omp-supreme-token-saver"].version` | plugin |
| 3 | the `package.json` the module travels with | plugin, or a repo checkout |

Every path the updater resolves is derived from its own module URL, so it runs unchanged from
`~/.omp/agent/extensions/…` and from `~/.omp/plugins/node_modules/…`: the caveman rule and the
token-saver module are siblings, the Ponytail manifest and the lock file come from the plugins root
(`$XDG_DATA_HOME/omp/plugins` when that root exists, else `~/.omp/plugins`). A path that resolves to
nothing is reported as such — `RTK not installed: no binary at …`, `no manifest at …` — never as a
failed check with no explanation.

## Native settings

`omp config` is the only writer of the native *settings* in `~/.omp/agent/config.yml` (path confirmed via
`omp config path`) — the installer edits that file too, but only its `extensions:` list.
**The knobs are the dial.** Each level of the `read`, `compress`, `prune` and `threshold` knobs names
exactly which OMP keys that level writes; the preset supplies the level each knob starts at (the [presets table](#presets))
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

`compaction.keepRecentTokens` is the main dial on post-compaction context size: it is the verbatim-history
floor left after a compaction, and everything above that floor is what a compaction may elide.

This knob decides what a compaction **may elide**; *when* it fires is the `threshold` knob below — idle
compaction used to hang off `prune=ultra` and could never fire.

### Knob `threshold` — when automatic compaction fires

Levels: `off` · `lite` · `full` · `ultra`.

| OMP key | off | lite | full | ultra | What it is |
|---|---|---|---|---|---|
| `compaction.thresholdPercent` | -1 | 85 | 70 | 55 | Share of the context window at or above which OMP compacts after a turn; `-1` = reserve-based |
| `compaction.thresholdTokens` | -1 | -1 | -1 | -1 | Fixed token limit; a positive value outranks the share. `options.threshold` is what sets it |
| `compaction.idleEnabled` | false | false | true | true | Also compact while the session sits idle, once the token count below is passed |
| `compaction.idleThresholdTokens` | 200000 | 200000 | 120000 | 80000 | Token count that arms idle compaction |

Those four keys are the compaction *trigger*: `prune` says what a compaction may drop, this says how full the
context has to get before one runs. The level word alone hides the number it picked, so the footer shows the
number in the level's place — `⏱️70%` for `full`, `⏱️100k` once a token cap is pinned, `⏱️res` for `off`, whose
limit is the host's reserve rather than a share of its own — and the spelled row carries both
(`threshold full (70%)`).

`compaction.thresholdPercent` is the only one of the four that is a *share* of the context window, which is why
the knob dials it and not an absolute cap: the same percent means different token counts on a 200k and a 1M
model, and an absolute number would be wrong the moment the session changes model. Lower percent = compaction
fires earlier = fewer tokens carried per turn, but each compaction rewrites the prompt prefix, so it also means
more cache re-reads. `off` writes `-1`, which is the host's own reserve-based default — a 16384-token floor and
at least 15% of the window — **not** "never compact"; this knob never touches `compaction.enabled`.

#### An exact share or an exact limit

The level picks a share from a four-step table; `options.threshold` is for when that is not exact enough:

| Option | Default | What it does |
|---|---|---|
| `threshold.percent` | `-1` | The share to write, replacing the level's own (`40` = compact at 40% of the window). `-1` follows the level |
| `threshold.tokens` | `-1` | A fixed token limit, for a model whose window you know and whose share you would rather pin in tokens. `-1` = none |
| `threshold.pick` | `auto` | Which of the two is written: `auto` (whichever fires first), `percent` or `tokens` |

```bash
/ts option threshold.tokens=100000      # never carry more than 100k tokens into a turn
/ts option threshold.percent=40         # and/or compact at 40% of whatever window is in play
/ts option threshold.pick=auto          # write whichever of the two fires first (the default)
```

The host applies a positive `compaction.thresholdTokens` **whenever it is set**, before the share is even read,
so "whichever is lower" is not something `config.yml` can express — the pack has to decide, and it decides with
the window the session's model reports: with `pick=auto` the cap is written only when it is no higher than
`percent`% of that window, and the losing limit is written back to `-1` rather than left in the file to outrank
the winner. `pick=percent` and `pick=tokens` skip the comparison and pin one of them. With no window to read
(an unresolved model), the cap is the only limit that can be evaluated, so `auto` keeps it.

The comparison uses the window `<provider>/<model>` reports *now*: switching to a much smaller model makes the
share fire earlier, and a cap that was the lower limit stays written until the next native apply. Re-run
`/ts native apply` (or change any knob) after a model switch to re-decide.

The idle pair is the second trigger: `off` and `lite` leave idle compaction off, `full` and `ultra` turn it on
and bring the token trigger down with it. The two token numbers are **absolute** because the host key is —
they are tuned for a ~200k window, so scale them down (or leave the pair at `off`) on a model whose whole
window is well under that. The dwell, `compaction.idleTimeoutSeconds`, stays stock at 300: it is how long the
session must sit idle before the trigger is checked, and this knob leaves it alone.

This is also where the idle bug was: `prune=ultra` used to write `compaction.idleEnabled=true` while leaving
`compaction.idleThresholdTokens` at its 200000 host default — at or above the whole usable window of many
models, so the setting could never fire. `compaction.idleEnabled` is gone from every `prune` level, and the
trigger family now belongs to this knob alone, switch and token trigger together.

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
- `off` as a *preset* is different: it writes no keys at all and instead resets all 22 keys in these tables
  to whatever OMP then considers sane, which is more durable than pinning `false`.
- Deliberately untouched inside `compaction.*`: `compaction.midTurnEnabled`, `compaction.methodOrder`,
  `compaction.asyncEnabled`, `compaction.autoContinue` and `compaction.reserveTokens` — those decide *how* and
  *with what* a compaction runs, and this pack only dials *when*. (`compaction.thresholdTokens` is written, but
  only through `options.threshold`: a level never sets a positive value, because a positive cap silently
  outranks the share and would then be wrong on the next model.) Also untouched: `provider.appendOnlyContext`,
  `memory.backend`, `advisor`/`autolearn`/`prewalk`, `snapcompact`, and every display/statusLine/tui key —
  display keys cost no model tokens.
- `/ts native reset` runs one `omp` process per key (22). A missing `omp` CLI degrades `/ts native apply`
  (and any preset-time native write) to a warning
  (`Native settings unavailable: … config.yml untouched.`); the preset itself still applies.

## Optional: Headroom

[Headroom](https://github.com/headroomlabs-ai/headroom) (Apache-2.0) is a context-compression layer that runs
between an agent and its model provider and rewrites tool output, logs and history before they are sent. It is a
**Python** package (`headroom-ai`) whose compression core is a CPython extension: the npm `headroom-ai` package is
a TypeScript SDK with no `bin`, and there is no standalone binary to download. Version 0.37.0 at the time of
writing — **198 PyPI releases since January 2026 and still no 1.0**. Read that plainly: it is a fast-moving
pre-1.0 tool, so pin it and read its changelog before you depend on any of it.

**This pack does not bundle Headroom, does not depend on it, and never installs it.** It detects it, and — since
`/ts headroom wrap` — it can route the session through it. Installing stays your job.

### It is not anthropic-only, and neither is the wrap here

Two different things get conflated, including in Headroom's own `wrap omp`:

- **The proxy is provider-agnostic.** `headroom proxy` picks the upstream from the request's protocol and each
  family's real endpoint comes from a flag: `--openai-api-url`, `--anthropic-api-url`, `--gemini-api-url`,
  `--vertex-api-url`. Anything OpenAI-compatible — DeepSeek, OpenRouter, Groq, Mistral, a local server — is
  carried end to end. Its `any-llm` backend additionally covers 38+ providers.
- **`headroom wrap omp` is anthropic-only.** It injects a marker-fenced `providers.anthropic.baseUrl` override
  into `~/.omp/agent/models.yml` (backed up byte-for-byte; `headroom unwrap omp` restores it) and its own help
  says the other providers "keep their normal endpoints; route those via your own custom provider in models.yml".

`/ts headroom wrap` closes that gap for the session: it reads the active model's own `api` family and `baseUrl`,
starts (or reuses) the proxy with the matching upstream flag, and points the provider at it.

### How the pack routes it — and what that scope buys

| Step | Mechanism |
|---|---|
| Upstream | The session model's own `baseUrl` becomes the proxy's `--*api-url`, so the proxy forwards where the provider was already going |
| Routing | `pi.registerProvider(<provider>, { baseUrl })` — a **runtime** transport override that outranks `models.yml` and the bundled catalog for that provider id, keeping its bundled models and stored credentials |
| Take effect | `pi.setModel(resolve(<provider>/<model>))` re-points the live session (a session holds a resolved Model; the registry override alone does not move traffic) |
| Undo | `/ts headroom unwrap` — `unregisterProvider` + re-resolve, then stop the proxy **only if this pack started it** |

Scope is the trade: this routes the current process (subagents included), immediately, with no file edits and no
restart — and stops when the session does. `headroom wrap omp` survives into new processes but only ever covers
anthropic. Use whichever matches; they can coexist.

`/ts headroom status` reports the proxy's health, the upstreams it is actually configured with (its own
`/health`), this session's provider/family/`baseUrl`, and whether this session is routed — it reads the routing
back off the registry rather than assuming the call took. Wrap refuses to route through a proxy already on the
port that forwards somewhere else, since that would send this session's traffic and API key to another upstream.

### The `headroom` knob

Routing is also a knob, so it lands in the row, in `/ts set`, in `/ts default` and in the settings menu like
every other setting — `off` (default, and what every preset carries) or `on`:

```text
/ts set headroom=on        # start or reuse the proxy, route this session, 🔀 headroom: ON
/ts set headroom=off       # unroute it, stop a proxy this pack started
/ts default headroom=on    # new sessions start routed (they wrap themselves at session start)
```

Three details that make it behave like a setting rather than a command:

- **The row shows what is routed, not what was asked for.** The knob's value in the row is the *effective*
  state: a wrap that failed (no headroom installed, no upstream flag for this provider's family, a proxy on the
  port pointed elsewhere) publishes `off` and says why. The session *entry* keeps your intent, so a resumed
  session retries once at session start.
- **`ultra` turns it on, every other preset turns it off** (including `max`, the default for new sessions). A
  preset is a token dial, so only the most aggressive one reaches for the extra process; on a machine without
  Headroom the wrap fails, the row stays `OFF` and the reason is reported. `off` unroutes a routed session.
- **Subagents inherit it.** They run in the same process, so they use the same routed provider.

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

This pack's native-settings layer also covers structural read summaries (`read.summarize.*`), shell-output
minimisation (`shellMinimizer.*`) and pruning of stale results (`compaction.supersedeReads`,
`compaction.dropUseless`) with no external process at all — the `read`, `compress`, `prune` and `threshold`
knobs select those settings, under `native.mode=auto`. Headroom is the extra layer for large repetitive JSON
or log traffic.

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

| Command | Effect |
|---|---|
| `/ts headroom` (or `/ts headroom status`) | Headroom version, proxy health and its upstreams, the session's family and whether it is routed |
| `/ts headroom wrap` | Start (or reuse) the proxy on the active provider's endpoint and route this session through it |
| `/ts headroom unwrap` | Unroute this session; stop the proxy if this pack started it |
| `/ts headroom unwrap-models` | Restore a `models.yml` a *durable* `headroom wrap omp` wrote (runs `headroom unwrap omp`) |
| `/ts headroom install` | Refuses, prints the uv/pip/Docker lines above — this pack installs nothing for you |

The proxy is a detached process the pack spawns directly (never through a shell, so the pid it records is the
one that owns the port), logging to `~/.omp/agent/headroom.log`, with its state in `~/.omp/agent/headroom.json`.
Run `headroom wrap omp` from your own shell only if you want the *durable* anthropic wrap: it starts a proxy and
launches its own `omp`, so it nests OMP if run from inside a session.

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
- `/ts option <group>.<key>=<value>` writes `options.<group>.<key>`. Four groups exist, and the value
  type decides the syntax: `autoRtk.timeoutMs` takes a number, `autoRtk.exclude` takes a JSON array
  (`/ts option autoRtk.exclude=[".git","dist"]`), `headroom.port` a port, and `native.mode` is a string — `auto`
  (or `on`/`true`) makes presets and knob changes write `config.yml`, `off` leaves it alone, and any other value
  is rejected. Unknown groups, unknown keys, a non-numeric `timeoutMs`, and an `exclude` that is not a JSON array
  are rejected with a usage line. Options describe behaviour (timeouts, exclusion lists, the native gate),
  not intensity. They are stored for the sessions that follow, but they are read at different times: `autoRtk.*`
  is cached when a session starts, while `native.mode` and the `threshold.*` limits are read at every native write
  and every row render, so flipping those takes effect on the running session's next preset, knob change or
  `native apply`.
- `threshold.percent` and `threshold.tokens` are numbers (`-1` = unset, meaning "the level's share" and "no fixed
  cap"), and `threshold.pick` is `auto` \| `percent` \| `tokens`. They are the one option group a *level* also
  speaks about, which is why the footer row reports the limit that wins rather than the level's own number.
- The stored defaults are `autoRtk.timeoutMs=2000`, `autoRtk.exclude=[]`, `native.mode=off`,
  `headroom.port=8787`, `threshold.percent=-1`, `threshold.tokens=-1`, `threshold.pick=auto`, so a fresh
  file needs no `options` block at all.
- Choosing a ponytail default also pushes it into the Ponytail plugin's own config, and reports
  `[pending] Ponytail plugin not found` when that write fails.
- Legacy migration: if `token-saver.json` is absent, the pre-2.0 `~/.omp/agent/combo-defaults.json`
  (bare `caveman`/`rtk`/`ponytail` keys) is read once so an upgrade keeps your level. The next write goes
  to `token-saver.json` and deletes the legacy file.

Environment overrides:

| Variable | Overrides |
|---|---|
| `OMP_TOKEN_SAVER_CONFIG` | Path of `token-saver.json`; the updater's `ai-addons.json` and `ai-addons-state.json` follow its directory |
| `OMP_COMBO_DEFAULTS_FILE` | Path of the legacy `combo-defaults.json` |
| `OMP_PONYTAIL_PACKAGE_DIR` | Location of the Ponytail plugin package (default reading/writing of its `defaultMode`) |
| `OMP_HEADROOM_STATE` | Path of the headroom wrap state (`headroom.json`); the proxy log follows the agent dir |
| `OMP_CAVEMAN_RULE` | Path of the caveman rule read for `full` (default `extensions/caveman-session/rule.md`) |
| `OMP_TOKEN_SAVER_VERSION_STAMP` | Path of the installed version stamp the check reads |
| `XDG_DATA_HOME` | Marketplace root: `$XDG_DATA_HOME/omp/plugins` is used when it exists, else `~/.omp/plugins` |
| `PI_CODING_AGENT_DIR` | Relocates the whole agent dir — the pack's `headroom.json`, the `models.yml` its headroom status reads, and the `config.yml` the native layer writes |

## Status row

`extensions/shared/status-line.js` is the **only** module that writes the `modes` status key, so a knob's
symbol never depends on how the value was set (`/ts`, a per-app command, or the stored default). One row,
built to fit a footer rather than to document the pack:

| `status` | Row | Why |
|---|---|---|
| `names` (default) | `🧩 MAX · caveman ultra · rtk on · autoRtk on · ponytail ultra · read full · compress full · prune full · threshold full (70%) · headroom off` | Every knob spelled out — the knob's real name and its level in the lowercase the commands take. A footer is read, not decoded, so this is what a session starts on |
| `full` | `🧩 MAX · 🦴U 🦀ON 🔁ON 🐴U · 📖F 🗜️F 🧹F ⏱️70% · 🔀OFF` | One icon and one value per knob, no label repeating what the icon says, grouped by the layer the knob configures: the prompt add-ons, the four OMP settings, the extras — for a footer with no room for nine words |
| `preset` | `🧩 MAX` | One word: the preset determines all nine knobs anyway |
| `off` | *(no row)* | The key is deleted, not blanked |

How a knob is written in the `full` row:

- An `on`/`off` knob keeps the word (`🦀ON`, `🔁OFF`): both spellings start with "O", so one letter would not
  say which one is set.
- A level knob shortens to its first letter (`🦴U` = `caveman=ultra`, `🗜️F` = `compress=full`) — off/lite/full/ultra,
  plus `wenyan` for caveman.
- `threshold` shows the number instead of the letter (`⏱️70%`), because the letter is only a stand-in for that
  number and the row has room for one of them; a pinned token cap renders as `⏱️100k`, and `off` renders
  `⏱️res`, the host's reserve-based default. The `names` row carries the level and the number
  (`threshold full (70%)`), resolved by the same function that writes the keys, so the row cannot describe a
  limit `config.yml` is not set to.
- A knob whose icon is missing renders as `name value` rather than vanishing.

- The row opens with the preset, so it is also the readout of which preset the session is on — and no preset
  changes the shape, so switching presets never moves the row's layout.
- `compact` was a shape until a narrow non-icon row arrived; the two would now be the same row twice, so it is
  gone. A stored or branched `compact` resolves to the default instead of erroring.
- `/ts config` → **Footer row** lists these with the exact row each one would render, so the shape is
  picked by what it looks like rather than spelled from memory (`Knob` → `status` sets the same knob), and the
  pick then asks where it goes — **This session** or **New sessions** — like every other knob.
- `status` is display-only, and that is load-bearing in two places: it is excluded from the
  preset match — choosing a row shape on an `ultra` session keeps reporting `ULTRA`, not `custom` — and
  it writes nothing to `config.yml`, since a display key costs no model tokens.
- Rendering is display-only: nothing in the status module changes a mode.

## File locations

| What | Path |
|---|---|
| Token Saver extension (commands, presets, native driver) | `~/.omp/agent/extensions/token-saver/` (follows `PI_CODING_AGENT_DIR`) |
| Shared modules (`session-state.js`, `status-line.js`, `mode-reinforcement.js`) | `~/.omp/agent/extensions/shared/` |
| Caveman extension | `~/.omp/agent/extensions/caveman-session/` |
| RTK extension | `~/.omp/agent/extensions/rtk-session/` |
| Updater extension (`/ai-addons`, startup check) | `~/.omp/agent/extensions/ai-addons-updater/` |
| Amanai reward detector | `~/.omp/agent/extensions/amanai-reward/` |
| Installed version stamp (read by the check; absent on a plugin install) | `~/.omp/agent/extensions/.omp-token-saver-version` |
| Startup check switch and interval | same directory as `token-saver.json` — `~/.omp/agent/ai-addons.json` |
| Startup check state (`lastCheck`, `notified`) | same directory as `token-saver.json` — `~/.omp/agent/ai-addons-state.json` |
| The same six modules, marketplace layout | `~/.omp/plugins/node_modules/@dillydalli3r/omp-supreme-token-saver/extensions/` (per `package.json` `omp.extensions`) |
| Marketplace install record | `~/.omp/plugins/omp-plugins.lock.json`, `~/.omp/plugins/installed_plugins.json` |
| Ponytail plugin | `~/.omp/plugins/node_modules/@dietrichgebert/ponytail/` |
| Ponytail plugin config (`defaultMode`, `hideStatus`, `quietStartup`) | `$XDG_CONFIG_HOME/ponytail/config.json`, else `%APPDATA%\ponytail\config.json`, else `~/.config/ponytail/config.json` |
| RTK binary | `~/.bun/bin/rtk` (`rtk.exe` on Windows) |
| Session defaults | `~/.omp/agent/token-saver.json` |
| Legacy pre-2.0 defaults (read once, deleted on first write) | `~/.omp/agent/combo-defaults.json` |
| OMP native settings and extension registrations | `~/.omp/agent/config.yml` (follows `PI_CODING_AGENT_DIR`) |
| OMP model config (what an external `headroom wrap omp` edits) | `~/.omp/agent/models.yml` |
| Project scope install target | `./.omp/extensions` |

Pre-2.0 shipped a separate `combo-toggle` extension directory. 2.0 has no such directory: `/combo` is
registered by `token-saver`.

## Troubleshooting

### The injected caveman rule is not the upstream one

By design. The upstream text advertises `wenyan-lite|wenyan-full|wenyan-ultra`, none of which
`/caveman` accepts, so serving it would tell you to type values the command rejects. A rule.md that
names any level the command does not take is skipped in favour of the copy bundled in
`extensions/caveman-session/index.js`, which is identical to the rule.md this repo ships — an install
with network access and one without inject the same text. `/ai-addons check` reports it as
`Caveman rule: serving the bundled rule — the published rule names wenyan-lite, …`, and
`/ai-addons update caveman` refuses to write the upstream copy. To inject your own rule, edit
`extensions/caveman-session/rule.md` and keep it to `off|lite|full|ultra|wenyan`.

### The startup notice never appears (or appears every session)

It only speaks when something is actually outdated — or while a preset's native levels are unwritten
and the gate is `off`. If it stays silent when you expect news, check `/ai-addons check`: the notice is
throttled to `intervalHours` (default 6h) and remembers the last result it announced, so a restart does
not repeat it. `/ai-addons level` prints the switch and the interval, `/ai-addons level off` stops it
entirely, and deleting `~/.omp/agent/ai-addons-state.json` forces the next session to check again.

### `Token saver version unknown` in the check row

The check could not find a version for the installed pack: no `<extensions>/.omp-token-saver-version`
stamp, no `omp-plugins.lock.json` entry and no `package.json` beside the modules — the exact situation
of a legacy install the installer has never stamped. It reports `unknown` rather than guessing from a
file's mtime. Reinstalling (which writes the stamp) or installing the pack as a marketplace plugin
both make the row readable again.

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

The native layer is optional. With no `omp` CLI on the path, `/ts native apply` and preset-time native writes
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
| `install` | Install the add-ons (user scope by default) |
| `update` | Run the latest installer — npm package first, GitHub source as fallback |
| `reinstall` | Clean and reinstall the user-scope add-ons |
| `doctor` | Check the current installation (including the stale `combo-toggle` check; a missing Headroom is reported as optional, never fatal) |
| `uninstall` | Remove the managed extensions |
| `plugin` | Plugin layout only: install the runtime dependencies the marketplace cannot — the Ponytail plugin and the rtk binary. No extension copying and no `config.yml` edits; refuses while a legacy tree is installed |
| `version` | Print the package version |
| `help` | Print usage |

`--doctor` and `--uninstall` remain as aliases of those two commands.

| Flag | Effect |
|---|---|
| `--scope user\|project\|both` | Install scope (default `user`; accepts `--scope=user` too). A scope that would leave the same extensions in both the CWD tree and the user tree is refused — omp discovers both, so `/caveman` and `/rtk` would register twice |
| `--force` | Proceed despite that refusal, or install the plugin layout over a legacy tree |
| `--legacy-only` | Uninstall: cutover mode. Remove the legacy extensions tree and its `config.yml` entries only — never `~/.omp/plugins` and never the rtk binary. The safe step before `plugin` |
| `--preset <off\|lite\|medium\|high\|max\|ultra>` | Seed the default preset, only when `token-saver.json` is absent |
| `--force-preset` | Let `--preset` overwrite an existing `token-saver.json` |
| `--remove-ponytail` | Uninstall: also drop the Ponytail plugin entry from `config.yml` |
| `--remove-rtk` | Uninstall: also delete the RTK binary |
| `--yes`, `-y` | Non-interactive |
| `--dry-run` | Preview writes; nothing touches disk (a pure offline preview, including for `plugin`) |
| `--verbose` | Debug output |
| `--version`, `-v` / `--help`, `-h` | Same as `version` / `help` |

Switching layouts — out of the legacy tree, into the marketplace one:

```bash
node install-omp-addons.js uninstall --legacy-only --yes   # legacy tree + config.yml entries only
node install-omp-addons.js plugin --yes                    # ponytail + rtk, the parts the marketplace does not carry
omp plugin install supreme-token-saver@omp-addons           # the six extension modules themselves
```

## License

MIT
