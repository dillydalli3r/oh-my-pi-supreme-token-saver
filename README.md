# oh-my-pi-supreme-token-saver (fork)

A passive Amanai reward detector plus three toggleable [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) add-ons for terse replies, compact shell output, and minimal code decisions. It also includes combined toggles, health checks, updates, and dry-run support.

Fork of [`@fernado03/oh-my-pi-supreme-token-saver`](https://www.npmjs.com/package/@fernado03/oh-my-pi-supreme-token-saver) with three behavior changes:

| Change | Before | Now |
|---|---|---|
| Session default | every mode off until you enable it | a fresh session behaves like `/combo max` (caveman `ultra`, RTK on, ponytail `ultra`); `/combo default <level\|app=mode>` changes what fresh sessions start from, and `/combo off` still opts one session out |
| Status bar | one footer row per add-on, and the ponytail row used a different marker per mode (`🔥`/`⚡`/`🌿`) | a **single** row for all three: `🧩 MAX · 🦴 caveman: ULTRA · 🦀 rtk: ON · 🐴 ponytail: ULTRA` — the marker per app is fixed and does not depend on whether the mode came from `/combo`, a per-app command, or the session default |
| Ponytail config path | installer wrote `~/.config/ponytail/config.json`, which the plugin does not read on Windows | installer writes the path the plugin actually resolves (`$XDG_CONFIG_HOME`, then `%APPDATA%`, then `~/.config`) and sets `hideStatus: true` so the plugin does not add a second, competing row |

## Install

From a clone:

```bash
git clone https://github.com/dillydalli3r/oh-my-pi-supreme-token-saver
cd oh-my-pi-supreme-token-saver
node install-omp-addons.js install --yes
```

Without cloning (npm runs the packaged `bin` straight from GitHub; npm 11+ needs `--allow-git=all` for git sources):

```bash
npx --yes --allow-git=all github:dillydalli3r/oh-my-pi-supreme-token-saver install --yes
```

The installer copies the bundled extensions into `~/.omp/agent/extensions`, registers them in `~/.omp/agent/config.yml`, installs the Ponytail plugin (`github:DietrichGebert/ponytail`) and the RTK binary, and pins the Ponytail defaults above. `--dry-run` previews every write; `doctor` verifies the result afterwards.

**After install:** restart OMP. New sessions start at `max`; `/combo medium`, `/combo off`, or the individual toggles change it per session, and `/combo default <level>` changes what fresh sessions start from.

Individual toggles: `/caveman ultra` · `/rtk on` · `/ponytail ultra`

`update` re-runs the published installer from npm, so it needs this fork published under its own name first (`npm login` then `npm publish --access public`). Until then use `npx --yes --allow-git=all github:dillydalli3r/oh-my-pi-supreme-token-saver install --yes` or `reinstall`.

## What it installs

| Add-on | What it does |
|---|---|
| **Caveman** | Shortens replies while retaining technical substance. Modes: `lite`, `full`, `ultra`, and `wenyan` |
| **RTK** | Routes noisy shell commands through the RTK binary for compact output |
| **Ponytail** | Favors standard-library, minimal, YAGNI-oriented code decisions |
| **Updater** | Checks and updates Ponytail, RTK, and Caveman in-session, with dry-run and backup support |
| **Combo** | Switches Caveman, RTK, and Ponytail together. Presets: `off`, `medium`, and `max`; mixed individual modes display as `custom` |
| **Amanai reward detector** | Locally notifies you when a final successful response contains a footer-shaped `AMANAI-GACHA-…` key; it never changes output, stores or sends the key, redeems it, opens a browser, or creates requests |

All three token-saving modes start at `max` (the session default); `/combo default <level>` changes what fresh sessions start from, and `/combo off` disables them for the current session.

For long sessions, the package reasserts active modes after Ponytail's prompt block on every top-level turn, including after OMP compacts earlier history.

### Amanai reward detector

The detector only scans the completed final assistant response, then shows a local notice. Redeem any detected key yourself in the Amanai billing dashboard; the extension does not retain or expose it.

The package also declares a Pi-native adapter through `pi.extensions`. It waits for Pi's final settled response before issuing the same local notice; the OMP installer installs only the OMP adapter.

## CLI

After the global install, use these short commands for routine maintenance:

| Command | Purpose |
|---|---|
| `oh-my-pi-supreme-token-saver install` | Install non-interactively to user scope by default; use `--scope project` or `--scope both` for another scope |
| `oh-my-pi-supreme-token-saver update` | Fetch the latest release and refresh the user installation |
| `oh-my-pi-supreme-token-saver reinstall` | Remove the bundled extension directories and RTK binary, then install fresh at user scope; the separate Ponytail package is preserved and refreshed |
| `oh-my-pi-supreme-token-saver doctor` | Check OMP, extension, Ponytail, and RTK installation health |
| `oh-my-pi-supreme-token-saver uninstall` | Remove bundled extensions; add `--remove-rtk` to remove the RTK binary or `--remove-ponytail` to unregister Ponytail's extension path (the Ponytail package remains installed) |
| `oh-my-pi-supreme-token-saver version` | Print the package version (`--version` or `-v` also works) |
| `oh-my-pi-supreme-token-saver help` | Show usage (`--help` or `-h` also works) |

Useful flags are `--scope user|project|both`, `--dry-run`, `--yes`/`-y`, and `--verbose`. The original no-subcommand install and legacy `--doctor` and `--uninstall` forms remain supported.

## Commands reference

### Caveman — terse replies

```text
/caveman lite         concise, drops pleasantries
/caveman full         terse caveman style
/caveman ultra        maximum terse, fragments only
/caveman wenyan       classical-Chinese-style where clear
/caveman off          normal mode
/caveman status       show current mode
```

Natural-language off switches also work: `caveman off`, `stop caveman`, and `normal mode`.

### RTK — compact shell output

```text
/rtk on               enable compact RTK output
/rtk off              disable
/rtk status           show current state
```

When enabled, the agent prefers RTK for noisy commands such as:

```text
rtk git status
rtk git diff
rtk read src/index.ts
rtk grep "pattern" src
rtk test bun test
rtk tsc
rtk lint
```

### Ponytail — minimal code

```text
/ponytail lite        light guidance
/ponytail full        full YAGNI enforcement
/ponytail ultra       aggressive simplification
/ponytail off         disable
/ponytail status      show current state
```

### Updater — check and update add-ons

```text
/ai-addons check                          check all add-on versions
/ai-addons status                         same as check
/ai-addons update ponytail                update Ponytail
/ai-addons update rtk                     update the RTK binary
/ai-addons update caveman                 update the Caveman rule
/ai-addons update all                     update all three
/ai-addons update all --dry-run           preview without changes
```

### Combo — toggle all three

```text
/combo off                          all three off for this session
/combo medium                       caveman=lite, rtk=on, ponytail=lite
/combo max                          caveman=ultra, rtk=on, ponytail=ultra
/combo status                       show the level, the underlying modes, and the default
/combo help                         show available levels
/combo default                      show the level fresh sessions start from
/combo default off|medium|max       set what fresh sessions start from
/combo default caveman=lite rtk=off ponytail=full
/combo default reset                 drop the override (back to max)
```

`/combo` persists each add-on's state and reloads OMP so the new modes apply immediately, without emitting separate `/caveman`, `/rtk`, or `/ponytail` command messages.

Active Combo presets are inherited by OMP task subagents created from the session. `/combo medium` or `/combo max` is the only way to activate a preset and show the Combo footer indicator. Individual `/caveman`, `/rtk`, and `/ponytail` commands leave Combo inactive; `/combo status` reports their actual mixed state without turning the indicator on.

### Combo defaults — what a fresh session starts from

Every session that has no combo entry yet starts from the stored defaults: built-in `max` until you change them.

- `/combo default <level>` writes the preset; `/combo default caveman=lite rtk=off ponytail=full` pins single apps and displays as `custom`. Unpinned apps keep their built-in default.
- The running session is never changed by `default` — `/combo off|medium|max` applies a level now.
- Defaults persist in `~/.omp/agent/combo-defaults.json` (override the path with `OMP_COMBO_DEFAULTS_FILE`). Only keys you set are written, so a caveman-only default never pins ponytail.
- Ponytail keeps its own default: `/combo default` also calls the plugin's `writeDefaultMode`, and `PONYTAIL_DEFAULT_MODE` still outranks it. `/ponytail status` shows `current <mode> • default <mode>`, and `/combo default` reports the value that actually runs.
- `ponytail=review` is refused: review is session-only upstream. `/combo default reset` clears the file and returns ponytail to `ultra`.
- `install` fills ponytail's `defaultMode` only when nothing has set one, so reinstalling does not undo a default you chose in-session.

## File locations

| What | Path |
|---|---|
| Caveman extension | `~/.omp/agent/extensions/caveman-session/` |
| RTK extension | `~/.omp/agent/extensions/rtk-session/` |
| Ponytail package | `~/.omp/plugins/node_modules/@dietrichgebert/ponytail/` |
| Updater extension | `~/.omp/agent/extensions/ai-addons-updater/` |
| Combo extension | `~/.omp/agent/extensions/combo-toggle/` |
| Amanai detector extension | `~/.omp/agent/extensions/amanai-reward/` |
| RTK binary | `~/.bun/bin/rtk` (`rtk.exe` on Windows) |
| Combo session defaults | `~/.omp/agent/combo-defaults.json` |
| Explicit extension registrations | `~/.omp/agent/config.yml` |

## Backups

Before replacing an existing extension source file, the installer writes `<file>.bak`. The in-session updater also creates:

- RTK binary: `rtk.bak` or `rtk.exe.bak`, restored if the new binary fails validation
- Caveman rule: `rule.md.bak`, restored if the written hash is invalid

## Prerequisites

- [OMP (Oh My Pi)](https://github.com/can1357/oh-my-pi)
- Node.js 18+ with npm

The installer and `/ai-addons update all` create `~/.bun/bin` for RTK compatibility even when Bun is not installed.

### WSL

Windows and WSL have separate OMP homes. When installing for OMP inside WSL, run the install from WSL and check:

```bash
command -v npm
```

It must resolve to a Linux path such as `~/.nvm/versions/node/.../bin/npm`, not a Windows path under `/mnt/c/`; otherwise the add-ons may be installed into the Windows environment instead of the WSL OMP home.

## Advanced: one-off use

Without keeping the package globally installed, run the latest release once:

```bash
npm exec --yes --prefer-online --package=@dillydalli3r/oh-my-pi-supreme-token-saver@latest -- oh-my-pi-supreme-token-saver install
```

## Troubleshooting

### Ponytail or Combo command is missing

Run `oh-my-pi-supreme-token-saver reinstall` in the same Windows, WSL, or Linux environment where OMP runs, restart OMP, then try `/ponytail status` and `/combo status`. If either is still missing, run `oh-my-pi-supreme-token-saver doctor`; the installer normally repairs both explicit registrations in `~/.omp/agent/config.yml`.

### A combo default does not apply to a new session

Run `/combo default` to see the stored default and its file path, then `/combo status` in the new session. A session that already has a combo entry keeps its own level — only sessions with no entry start from the default. If ponytail's mode still differs from the reported default, `PONYTAIL_DEFAULT_MODE` is set in the environment and outranks the config file; `/ponytail status` shows both values.

### RTK is missing or not executable

Run `oh-my-pi-supreme-token-saver reinstall`, then `oh-my-pi-supreme-token-saver doctor`. On Linux or macOS, an older manually installed binary can be repaired with:

```bash
chmod +x ~/.bun/bin/rtk
```

### Checksum warning or failure

The installer verifies RTK against `checksums.txt` when checksum metadata is available and aborts on a mismatch. If the checksum file or matching asset entry is unavailable, installation warns and continues; `/ai-addons update rtk` is stricter and aborts when checksum metadata is missing.

## License

MIT
