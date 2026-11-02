# DSH-clean

![version](https://img.shields.io/badge/version-0.2.0-blue) ![license](https://img.shields.io/badge/license-MIT-green) ![platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-lightgrey)

**Audit and clean the DeepSeek Harness Desktop footprint on Windows.**

**English** | [简体中文](README.zh-CN.md)

DSH-clean is a zero-dependency Node CLI that answers four questions about one machine:

1. Which folders does DeepSeek Harness Desktop own, and who owns each of them?
2. Which plugins were installed and later removed - and what did they leave behind?
3. Have any client files changed compared with the official installer?
4. What can be cleaned up safely, and how?

It runs on demand (no daemon, no scheduled task, no startup hook), is read-only by default, and every deletion goes to the Windows Recycle Bin.

## What "clean" means

Four testable conditions, not a feeling:

| # | Condition | How it is tested |
|---|---|---|
| 1 | Every relevant folder can be enumerated | Root registry (`roots.json`); each entry records where it came from (registry, default location, config reverse-lookup) |
| 2 | Every folder has an owner | Each top-level directory maps to host / plugin / cache / unknown |
| 3 | The install directory matches the official installer | Hash baseline of the install tree (mtime + size gate, full pass on first run) plus optional `verify --installer` / `verify --upstream` against a second copy of the installer; files whose timestamps are preserved by the vendor are explained, not counted as dirty |
| 4 | No historical leftovers or useless files | The rule engine reports residue; a human decides; deletions go to the Recycle Bin |

Conditions 1-2 are prerequisites: without them, "clean" has no meaning.

## Features

- **Zero dependencies** - reuses the Node runtime that ships with DSH (Electron in Node mode). Nothing to install, nothing to build.
- **Read-only by default** - dry-run unless you explicitly apply; deletions only ever go to the Recycle Bin.
- **On demand** - no background process, no watcher, no hooks.
- **Incremental** - a full pass builds the baseline; later passes diff by (size, mtime) and usually touch only dozens of files.
- **Portable knowledge** - a built-in knowledge base ships with the repo, so a first run on an unknown machine already has half the judgement; local decisions accumulate in a case base (`judge`) so the same question is never asked twice.
- **Careful with files being written** - metadata is sampled twice at the end of a scan; anything changing is marked LOCKED and skipped this round.
- **Token-frugal** - the agent-facing output is compressed to a line or two; no agent means no tokens at all.
- **Leftover detection** - uninstall leftovers (data left by removed plugins, claimed through the retired-plugin roster), upgrade leftovers (dead caches such as a dsh-ops bash-ipc staging directory whose identity no longer matches the current package receipt), and stale rows in the startup patch layer (reported only, never edited).

## Requirements

- Windows 10 or Windows 11
- Either DeepSeek Harness Desktop installed on the machine, or `node` on PATH - one of the two is enough
- No npm, no build step, no administrator rights

## Installation

1. Download `dsh-clean-0.2.0.zip` from [Releases](https://github.com/Morgan00GZ/DSH-clean/releases).
2. Extract it to an ordinary folder - not `C:\Windows`, and not inside the DeepSeek Harness install directory.
3. Double-click `install.cmd`.
4. Restart DSH (or open a new session) and type `/dsh-clean`.

Developers can use a clone instead:

~~~bat
git clone https://github.com/Morgan00GZ/DSH-clean.git
cd DSH-clean
install.cmd
~~~

### What the installer creates

| Artifact | Location |
|---|---|
| Program | `%LOCALAPPDATA%\dsh-clean\app\` |
| DSH skill | `%USERPROFILE%\.dsh\skills\dsh-clean\` |
| Install record (used by uninstall) | `%LOCALAPPDATA%\dsh-clean\app\install.json` |
| Scan state and reports | the current workspace, `Temp\dsh-clean\` by default |

The program is copied out of the download folder, so the folder can be deleted afterwards.

## Usage

Inside DSH, type `/dsh-clean` (or just say "scan my DSH for leftovers"). The assistant runs the scan, reports in Chinese or English, and executes only what you approve.

Without a conversation, double-click `dsh-clean.cmd` for an interactive console session, or call the CLI directly:

| Command | Purpose |
|---|---|
| `scan` | Read-only inventory and report |
| `review` / `apply` | Show the cleanup list / send selected items to the Recycle Bin |
| `judge` / `unjudge` | Record or revoke a decision so it is not re-asked |
| `verify` | Compare the client against the installer (`--installer` or `--upstream`) |
| `prune` | Retire old reports and legacy state |
| `export-learning` | Export anonymised cases as a PR-ready fragment |
| `install` / `uninstall` | Deploy or remove the program and the skill |

The full command contract lives in [docs/cli.md](docs/cli.md).

Sample human output (excerpt):

~~~
DSH-clean v0.2.0 - 2026-11-02 12:00

Environment
  DSH Desktop   0.2.1-rc.3
  DSH runtime   44.7.0
  Footprint     3.7GB - 53,625 files - since last run +34.4KB - 0.9s

DSH folders (8)
  install            D:\Software\DeepSeek Harness               1.0GB  client install - launcher
  data               ~\.dsh                                     2.0GB  user data - default

Residue (A 1 - B 0 - 183B)
   1  A          183B  timestamp backup
     C:\Users\User\.dsh\our-free-model\magpie\config\magpie\settings.json.bak
~~~

Agent output (`--agent`, two lines at most):

~~~
PURITY v0.2.0 dsh=44.7.0 roots=10 files=50792 residue=1/0B unknown=0 sessions=11/32.4MB purity=0 integrity=ok plugins=182/0 patch=0/0 probe=+3/0 locked=0 known=0 leftover=0 next=review cfgbad=1
~~~

## Uninstall

Double-click `uninstall.cmd`. It removes the program, the skill, and the install record together - no orphan skill is left behind. Scan state and reports under `Temp\dsh-clean\` are yours to keep or delete; the tool does not touch them.

## How DSH-clean finds Node

DSH does not ship a standalone `node.exe`; DSH-clean reuses whatever runtime is available, in this order:

| Priority | Source |
|---|---|
| 1 | `DSH_DESKTOP_NODE_EXECUTABLE` (set automatically when the tool runs inside a DSH session) |
| 2 | `node` on PATH |
| 3 | `DeepSeek Harness.exe` in common install locations, started with `ELECTRON_RUN_AS_NODE=1` |

The resolved runtime is cached in `%LOCALAPPDATA%\dsh-clean\node-path.txt` so later runs skip the search.

## Safety

- Every deletion goes to the **Windows Recycle Bin** and can be restored.
- Files the tool did not create are reported, never removed.
- Anything written within the last 10 minutes is never classified as residue.
- Locked items are marked LOCKED and skipped - no retries, no errors.
- The tool never edits DSH configuration files (stale patch rows are report-only).

## Known limitations

- **Custom install path without Node** - if DSH lives outside the default locations and `node` is not on PATH, the launcher stops with `Cannot find a Node runtime`. Fix: put `node` on PATH, or set `DSH_DESKTOP_NODE_EXECUTABLE` to your `DeepSeek Harness.exe`.
- **Execution policy and antivirus** - `install.cmd` runs the bundled script with `-ExecutionPolicy Bypass` to survive restrictive policies; copying files into your user profile may still raise an antivirus prompt.
- **Windows only** - the Recycle Bin and registry discovery are Windows-specific. The engine is organised to be portable, but no other platform is supported yet.

## Documentation

| File | Contents |
|---|---|
| [docs/design.md](docs/design.md) | Design overview: shape decisions, four-layer processing, incremental and cost models |
| [docs/tiers.md](docs/tiers.md) | Tier definitions, rule list, hard boundaries, edge cases |
| [docs/cli.md](docs/cli.md) | Command contract, output formats, exit codes |
| [docs/state.md](docs/state.md) | State files and knowledge-base schemas, learning loop |
| [docs/roadmap.md](docs/roadmap.md) | P0-P4 phases and acceptance criteria |

## Versioning and releases

- Current version: **0.2.0** (`lib/version.mjs`), release tag: **0.2**.
- Each release ships `dsh-clean-0.2.0.zip` and `SHA256SUMS.txt` as GitHub Release assets; the ZIP is produced from the tag with `git archive`, so it contains exactly the tagged tree (tests and tooling are excluded via `.gitattributes`).
- Verify a download before running it:

~~~powershell
Get-FileHash .\dsh-clean-0.2.0.zip -Algorithm SHA256
Get-Content .\SHA256SUMS.txt
~~~

- Build a release locally: `powershell -NoProfile -ExecutionPolicy Bypass -File tools\release.ps1 -Tag 0.2`.

(待补充：tag 是否统一改成 `v0.2.0` 形式；目前沿用 `0.1` 的短格式 `0.2`，与 `VERSION` 0.2.0 的对应关系是「去掉补丁位」。)

## License

MIT © 2026 Morgan00GZ - see [LICENSE](LICENSE).
