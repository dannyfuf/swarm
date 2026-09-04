# Remote hosts

swarm can place a worktree on a remote machine (a "host") and open its tmux session from the
local TUI. The typical setup is a laptop that runs the TUI and a Linux dev-box reachable over
Tailscale via SSH. Each machine runs its own swarm install; the local swarm never touches remote
files directly. It drives the remote swarm through its CLI over SSH.

## Goals and non-goals

Goals:

- Choose the host when creating a worktree. Opening, sleeping, killing, and deleting a remote
  worktree route to its host automatically.
- Remote worktrees appear in the local list next to local ones, with a host badge and status.
- The local swarm stays usable when a host is unreachable; those worktrees show as offline.
- Zero code paths that emulate a remote filesystem. The remote swarm owns its repos, hot-copy
  pool, worktrees, tmux sessions, state, and config.

Non-goals:

- Moving a worktree between hosts. Host is placement, chosen once at create time.
- Syncing worktree files, base clones, or config between machines.
- Remote agent popups (`prefix + a` / `prefix + A`). Those stay local-only; they are for quick
  questions, not for working inside a worktree.
- A clipboard bridge. Use OSC 52 (`set -s set-clipboard on`) in the dev-box tmux override.

## Concepts

- **Host**: a named target in `config.json`. The local machine is the implicit host `local`.
- **Placement**: every worktree record has an optional `host` field. Absent means `local`.
- **Identity**: the plain worktree id is globally unique across local and remote hosts; host is
  placement metadata, not part of identity.
- **Mirror**: remote worktrees are stored in the local `state.json` as full worktree records
  (with the remote `path` and `session`) so the list renders offline. The remote state is
  authoritative. A sync replaces every local record for that host with the remote list.
- **Proxy session**: opening a remote worktree creates a local tmux session named
  `<host>/<remote session>` whose only window runs `ssh -t -- <target> <swarm> open '<id>'`.
  The TUI then `switch-client`s to it exactly like a local session. Reuse requires exactly one
  `ssh` pane, so shell-only sessions restored by tmux-resurrect are replaced.

## Configuration

```json
{
  "hosts": {
    "devbox": { "ssh": "devbox", "swarmCommand": "swarm" }
  },
  "defaultHost": "local",
  "ui": { "statusRefreshMs": 2000, "remoteStatusRefreshMs": 10000 }
}
```

- `hosts` is a map from host id to `{ ssh, swarmCommand? }`. `ssh` is anything the local `ssh`
  accepts as a destination (an alias from `~/.ssh/config`, a Tailscale MagicDNS name, or
  `user@host`). `swarmCommand` defaults to `swarm` and is the command run on the remote side; it
  must resolve in a non-interactive SSH shell (`/usr/local/bin` is normally on that PATH).
- `defaultHost` preselects the host picker in the create dialog. Default `local`. It must be
  `local` or a key of `hosts`.
- Host ids are `[a-z0-9-]+` and `local` is reserved.

Authentication is SSH's job. swarm uses `BatchMode=yes`, so keys must be loaded in an agent or
be passwordless. Multiplexing is enabled with `ControlMaster=auto`,
`ControlPath=$SWARM_HOME/cache/ssh/%C`, `ControlPersist=120`, so repeated status calls reuse one
connection. List, inspect, status, sleep, kill, and delete have a 30-second timeout; create is
unbounded.

## CLI protocol

The remote side is the ordinary `swarm` CLI; every command below also works locally. Commands
that take `--json` print exactly one JSON document on stdout and use exit code 0 on success and
1 on failure. On failure with `--json` the document is
`{ "protocol": 1, "error": { "kind": "<SwarmError kind>", "message": "..." } }`.

```text
swarm list --json
  -> { protocol: 1, version: "<swarm --version>", repos: Repo[], worktrees: Worktree[] }

swarm create <owner/name> <slug> [--branch <name>] [--base <ref>] [--url <clone url>]
             [--default-branch <name>] [--hooks <json>] --json
  -> { protocol: 1, created: boolean, worktree: Worktree }
  Registers and clones the repo synchronously when it is not registered yet (requires --url).
  Runs prepare/postCreate hooks like the TUI create flow. Blocks until the worktree is published.
  Branch defaults to the slug and base defaults to origin/<resolved default branch>. An existing
  worktree returns created:false without rerunning hooks when every explicitly supplied --branch
  or --host matches; omitted placement flags accept the recorded values. A recursive invocation
  omits --branch when the client omitted it, preserving that idempotency rule on the host.

swarm inspect [<owner/name#slug>...] [--fetch] [--repo <owner/name>] --json
  -> { protocol: 1, worktrees: WorktreeInspection[] }
  Returns the local HEAD (`head`), Git divergence, dirty state, raw mergedIntoTarget ancestry,
  uniqueCommits, published and merged policy facts, latest PR (including `headRefOid`),
  session/running state, warnings, and a per-worktree error. A merged PR sets merged only when its
  head equals or contains the local HEAD; ancestry sets merged only for a published branch. Remote
  clients send explicit ids to the owning host. --fetch is off by default.

swarm delete <owner/name#slug>... [--force] --json
  -> { protocol: 1, ok: boolean, results: [{ worktreeId, ok, reason? }] }
  Rechecks safety immediately before each deletion, continues after failures, and exits 1 when any
  result failed. Without --force it refuses dirty, attached, unknown-session, or running
  worktrees. An unmerged worktree is also refused when uniqueCommits is positive or unavailable.
  --force bypasses refusals and hard-kills the session.

swarm prune [--dry-run] [--no-fetch] [--kill-sessions] [--repo <owner/name>] --json
  -> { protocol: 1, dryRun: boolean, deleted: string[],
       skipped: [{ worktreeId, reason, merged, dirty, uniqueCommits, running }] }
  Selects clean worktrees with merged:true and a session state of none or detached. By default,
  running commands are skipped. --kill-sessions permits them only for otherwise eligible
  worktrees, requires a known unique-commit count, and hard-kills the session; attached and unknown
  sessions remain protected. A fresh unpublished branch and upstreamGone alone are never eligible.
  For remote mirrors, the client performs the same two safety snapshots and then forwards the
  hard-kill as `delete --force` to the owning host.

swarm kill <owner/name#slug> --json
  -> { protocol: 1, ok: true }

swarm sleep [session] --json
  -> { protocol: 1, kept: { window: string, reason: string }[], closed: string[], sessionKilled: boolean }

swarm status --json
  -> { protocol: 1, statuses: WorktreeStatus[] }

swarm open <owner/name#slug>
  Mounts and attaches (already exists; attaches when not inside tmux).
```

`protocol` is bumped for an incompatible removal, rename, or semantic replacement. Additive
commands and fields retain the current version, so these additions remain protocol 1. The local
swarm refuses a host whose `protocol` differs and reports it in `swarm doctor` and in the list as
offline.

`Repo.hooks` is passed as JSON in `--hooks` so the dev-box runs the same prepare/postCreate
commands. The dev-box may override them in its own state later.

## Local behavior

- **Sync** (`swarm list --json` per host): at startup, on explicit refresh, and after any remote
  create/delete. Remote worktrees whose `repoId` is not registered locally are ignored with a log
  line. Records are stored with `host` set and the remote `path` and `session`.
- **Status** (`swarm status --json` per host): one call per host every `remoteStatusRefreshMs`,
  merged into the same status map as local worktrees. An unreachable host or a protocol
  mismatch yields `session: "unknown"` for that host's worktrees, never `"none"`, because
  `"none"` means a successful observation found no session.
- **Create**: the create dialog and `swarm create --host <id>` support remote placement. The host
  invocation never receives `--host`, and it receives `--branch` only when the caller supplied the
  flag explicitly. The create dialog gains a host field (shown only when `hosts` is non-empty).
  Remote create runs in the background like a local create and shows a "creating on <host>"
  state until the CLI returns. `Tab` focuses the picker, `←`/`→` cycles it, and remote rows carry
  an `@host` badge. Base refs come from the local clone of the repo.
- **Open**: create or reuse the proxy session, then switch to it. `swarm open <id>` from the CLI
  follows the same path.
- **Inspect / prune**: group mirrored worktrees by host and invoke the same protocol commands on
  each host. An unreachable host becomes a per-worktree inspection error and is skipped by prune.
- **Sleep / kill / delete**: delegate to the host. Kill and delete then kill the local proxy
  session; sleep deliberately leaves the SSH pane alive. Delete also removes the mirror record and
  re-syncs.
- **Copy path**: `y` copies `<host>:<remote path>` for remote worktrees.
- **Doctor**: for each host, checks
  `ssh -o BatchMode=yes -o ConnectTimeout=5 -- <target> true`, then
  `<swarmCommand> list --json`, and reports the remote version and protocol.

## Nested tmux

A remote session is a tmux client running inside a local tmux window, so the local prefix
(`C-s`) wins. `tmux/tmux.conf` sources `~/.swarm/tmux.local.conf` when it exists. On the
dev-box, give the inner tmux a different prefix:

```tmux
set -g prefix C-a
unbind C-s
bind C-a send-prefix
set -s set-clipboard on
```

Everything bound with `bind <key>` in the shared config keeps working under the new prefix.

## Dev-box setup

1. Install Node 26.4+, tmux 3.2+, git, `gh` (authenticated), and the agents you use.
2. Clone swarm, `npm install && npm run build`, and symlink `bin/swarm` into `/usr/local/bin`.
3. Run `swarm doctor` on the dev-box and `swarm doctor` on the laptop.
4. Add the host to the laptop's `config.json` and create the first worktree on it.
