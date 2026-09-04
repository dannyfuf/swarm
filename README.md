# swarm

swarm is a keyboard-driven control panel for copy-on-write development worktrees. It runs
inside one tmux popup, keeps base clones pristine, and gives each working copy its own tmux
session. Sleeping a session closes idle windows while preserving agents, servers, and editors
with unsaved work.

For each repository, swarm keeps a configurable pool of prepared copies under the worktree root.
Creating a worktree atomically claims the lowest available slot into a private attempt directory
and immediately rebuilds that slot in the background. A missing prepared copy falls back by copying
the base into the private attempt; the final path appears only when registration succeeds. A small
publish-intent marker lets the next startup recover or safely discard a copy interrupted between
its final rename and state registration.

## Requirements

- Node.js 26.4 or newer (`.nvmrc` pins 26.8.1)
- tmux 3.2 or newer
- Git and an authenticated GitHub CLI (`gh`)
- macOS `cp -c`, or GNU `cp --reflink=auto` on Linux
- Optional: Neovim, Claude Code, OpenCode, and lazygit for agent popups and default windows

Run `swarm doctor` after installation to check the required tools and authentication.

## Install

```sh
nvm install
nvm use
npm install
npm run build
ln -s "$PWD/bin/swarm" /usr/local/bin/swarm
```

The launcher finds this repository from its own location, so `swarm` works from any current
directory. You can choose another writable directory on `PATH` for the symlink. It uses
`SWARM_NODE` when set to an executable, otherwise caches a resolved Node 26.4+ path under
`${SWARM_HOME:-~/.swarm}/cache`. The tmux popup inherits the tmux server environment and does not
source interactive shell startup files.

### tmux

The project-owned [`tmux/tmux.conf`](tmux/tmux.conf) is a complete tmux configuration. The
`tx` shell function starts tmux with this file; plain `tmux` also works because `~/.tmux.conf`
sources it. Both entry points prefer `~/buk/swarm` and fall back to this refactor worktree.
Set `SWARM_ROOT` to use another checkout.

The configuration uses `C-s` as its prefix. `prefix` + `s` opens swarm (replacing the built-in
session chooser), `prefix` + `a` opens Claude Code, and `prefix` + `A` opens OpenCode. Agent
popups use persistent `swarm-agent-*` tmux sessions rooted at the configured `reposDir`; press
`C-q` to hide one without stopping the agent, then use the same prefix binding to reopen it with
its live terminal and scrollback intact. It enables tmux-resurrect and tmux-continuum, saves every
10 minutes, restores sessions automatically, and restores Neovim sessions and lazygit processes
without auto-restarting coding agents. On first use, press `prefix` + `I` to install the configured
TPM plugins.

## Commands

```text
swarm                                  Open the TUI
swarm open owner/repo#slug             Mount and open a worktree by id
swarm open repo/slug                   Mount and open a worktree by tmux session
swarm list --json                      Print registered repos and worktrees
swarm create owner/repo slug [--branch name] [--base ref] [--host id] [--url url]
             [--default-branch name] [--hooks json] [--json]
                                       Clone if needed, then create and publish a worktree
swarm inspect [id...] [--fetch] [--repo owner/name] [--json]
                                       Inspect Git, PR, and tmux safety facts
swarm delete <id>... [--json]           Unconditionally delete one or more worktrees
swarm prune [--dry-run] [--no-fetch] [--kill-sessions] [--repo owner/name] [--json]
                                       Safely delete every eligible merged worktree
swarm kill owner/repo#slug --json      Kill its session if present
swarm status --json                    Print status for every worktree
swarm path owner/repo#slug             Print a local worktree's absolute path
swarm sleep [session] [--json]         Apply the sleep policy and print a JSON report
swarm agent [claude|opencode]          Create or reopen a persistent agent tmux session
swarm doctor                           Check runtime dependencies
swarm --version                        Print the installed version
```

`swarm --version` includes the package version and the Git commit baked into the build, such as
`swarm 0.1.0+f1ad163`.

## Driving swarm from an agent

For one worktree per ticket, first use `swarm list --json` and select the repository from its
`repos` array. For each ticket run:

```sh
swarm create <owner/repo> <slug> --json
```

Collect `worktree.path` from each response. The slug is also the default branch name, the base is
`origin/<repo default branch>`, and an existing worktree is returned without rerunning hooks.
Existing records are constrained only by flags supplied explicitly: an omitted `--branch` accepts
the recorded branch, and an omitted `--host` accepts the recorded host:

```text
{ protocol: 1, created: boolean, worktree: Worktree }
```

For cleanup, preview and then apply the same eligibility rules:

```sh
swarm prune --dry-run --json
swarm prune --json
swarm prune --kill-sessions --json  # only when the remaining skips are running sessions
```

Use `swarm inspect --json` to review every worktree before hand-picking IDs. The `swarm delete`
command is unconditional: every named worktree is destroyed regardless of dirty state, merge
state, unique commits, or tmux session state. Use prune as the safe bulk command. Their envelopes
are:

```text
inspect -> {
  protocol: 1,
  worktrees: [{ worktreeId, repoId, host, path, branch, baseRef, head, targetBranch,
    upstream, ahead, behind, upstreamGone, dirty, mergedIntoTarget, uniqueCommits,
    published, merged, pr, session, running, inspectedAt, warnings, error }]
}
prune  -> { protocol: 1, dryRun, deleted: string[], skipped: [{ worktreeId, reason,
            merged, dirty, uniqueCommits, running }] }
delete -> { protocol: 1, ok, results: [{ worktreeId, ok, reason? }] }
create -> { protocol: 1, created, worktree }
```

Delete continues through all requested IDs; `reason` appears only on actual failures such as an
unknown ID or unreachable host, and any failed result makes the command exit 1.

`pr` is either `null` or `{ number, state, url, baseRefName, headRefOid }`. Inspect does not fetch by default;
prune fetches with pruning by default. `mergedIntoTarget` is raw Git ancestry; `published` records
whether the branch was pushed. `merged` requires both ancestry and publication, or a merged PR
whose `headRefOid` equals or contains the inspected local `head`; commits added after a PR merge do
not inherit that PR's merged status. Prune selects only clean worktrees with `merged: true` and a
session state of `none` or `detached`; by default it also requires no running commands. Use
`--kill-sessions` only after reviewing the normal prune output: it permits running commands in
otherwise eligible detached sessions, requires a known unique-commit count, and hard-kills the
session. Attached and unknown sessions remain protected by prune. Delete has no eligibility checks;
inspect first or use `swarm prune --dry-run --json` when deletion needs a safety decision.

## Configuration

Configuration lives at `$SWARM_HOME/config.json` (default `~/.swarm/config.json`). Missing
fields are merged with these defaults:

```json
{
  "version": 1,
  "reposDir": "~/.swarm/repos",
  "worktreesDir": "~/.swarm/worktrees",
  "hosts": {},
  "defaultHost": "local",
  "hotPoolSize": 1,
  "hotFreshnessMs": 60000,
  "hotRefreshIntervalMs": 300000,
  "agent": "claude",
  "agentCommands": {
    "claude": "claude",
    "opencode": "opencode"
  },
  "windows": [
    { "name": "nvim", "command": "nvim ." },
    { "name": "cc", "command": "{agent}" },
    { "name": "lg", "command": "lazygit" }
  ],
  "sleep": {
    "enabled": true,
    "keepAlive": [
      { "id": "claude", "label": "claude", "kind": "process", "pattern": "(^|/)claude( |$)", "enabled": true },
      { "id": "opencode", "label": "opencode", "kind": "process", "pattern": "(^|/)opencode( |$)", "enabled": true },
      { "id": "codex", "label": "codex", "kind": "process", "pattern": "(^|/)codex( |$)", "enabled": true },
      { "id": "servers", "label": "server", "kind": "listening-port", "pattern": "", "enabled": true }
    ],
    "graceMs": 2000
  },
  "github": { "cacheTtlSeconds": 3600, "cloneProtocol": "ssh" },
  "ui": { "statusRefreshMs": 2000, "remoteStatusRefreshMs": 10000 }
}
```

`reposDir` and `worktreesDir` must resolve to absolute paths; a leading `~/` is expanded when
the file is loaded. `hotPoolSize` is a non-negative integer (default `1`); `0` disables prepared
copies. `hotFreshnessMs` controls how long a prepared copy's marker may suppress a fetch, and
`hotRefreshIntervalMs` controls periodic refreshes (`0` disables the timer). All three are
non-negative integers. `agent` selects `"claude"` or `"opencode"`. `agentCommands` maps each agent
to the full shell command used to start it and defaults to the agent name; missing map entries are
filled independently. The `,` settings dialog edits both the selected agent and its start command.
`windows` defines tmux window order and startup commands, and `{agent}` in a command resolves to
the selected agent's configured command when a worktree session is mounted. Process
`keepAlive` patterns are case-insensitive regular expressions; `listening-port` preserves any
window whose process tree owns a listening TCP port. `github.cloneProtocol` accepts `"ssh"`
(the default) or `"https"` and controls the URL used and stored when cloning GitHub repos.
Running `swarm agent` without a name uses the configured agent; an explicit name selects the other
agent while still using that agent's entry from `agentCommands`.

`hosts` maps lowercase host ids to SSH destinations and optional remote commands, for example
`"devbox": { "ssh": "user@devbox", "swarmCommand": "swarm" }`. The id `local` is reserved;
`defaultHost` must be `local` or one of the configured ids. A persisted worktree may carry a
`host` field; when it is absent the worktree is local. Remote commands use non-interactive SSH,
while opening a remote worktree creates a one-window local tmux proxy session.
In the create dialog, `Tab` focuses the host picker and `←`/`→` cycles it; remote rows show an
`@host` badge.

Each repo record has `hooks.prepare` and `hooks.postCreate` string arrays. Prepare hooks run in a
staging prepared copy before it is published (and in fallback copies after clone). A refresh that
changes or removes prepare hooks rebuilds the slot from the pristine base, removing ignored output
left by old hooks; failures are logged as warnings. Post-create hooks start only after the worktree
is registered. One detached runner executes the ordered sequence, appends per-hook status and output
to `~/.swarm/logs/swarm.log`, and does not keep the TUI alive, so the worktree can be opened or the
popup closed while the remaining hooks continue.

Opening the new-worktree dialog starts a full prepared-copy refresh without delaying the dialog.
The base-branch picker shows `fetching…` and receives newly fetched remote branches when the refresh
finishes. Closing the popup cancels controller-owned preparation/refresh work. Named branches are
fetched explicitly before checkout; a selected non-default `origin/<base>` is fetched explicitly and
creation fails clearly if it no longer exists. Worktrees opened from any PR always fetch that PR's
head.

## Sleep policy

`swarm sleep` inspects every pane with one process snapshot and at most one port scan. Windows
matching an enabled keep-alive rule stay open. Other windows close; Neovim receives `:qa` and
is kept when it remains alive after `graceMs`, protecting unsaved buffers. A session with no
remaining windows is killed. Set `sleep.enabled` to `false` to keep every window.

Opening worktree B normally sleeps the previous swarm worktree A after switching. In the TUI,
capital `O` opens B without sleeping A.

## Updating

Press `U` on either the worktree or pull-request screen to update swarm in place. The updater
requires the install checkout to be on a clean `main` branch, fast-forwards it from
`origin/main`, installs dependencies, rebuilds swarm, and restarts the TUI on the new build.

## Troubleshooting

- `node:ffi` or native-module errors: use Node 26.4+ and launch through `bin/swarm`, which adds
  `--experimental-ffi`. Direct development runs need `node --experimental-ffi` too.
- GitHub errors: run `gh auth status`, then `gh auth login` if needed.
- Popup closes immediately: run `swarm doctor`, then inspect `~/.swarm/logs/swarm.log`.
- Command not found from tmux: use an absolute `bin/swarm` path in the tmux binding or fix the
  tmux server's `PATH`.

See [docs/KEYMAP.md](docs/KEYMAP.md) for all keys and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for contracts and storage layout.
