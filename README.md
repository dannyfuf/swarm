# Swarm - Git Worktree + Tmux Session Manager

> Terminal UI for parallel development with Git worktrees and dedicated tmux sessions

Swarm is an interactive TUI that manages Git worktrees with dedicated tmux sessions. It scans a configurable root directory for repositories and lets you create, open, delete, and inspect worktrees from a three-panel interface.

Built with [Bun](https://bun.sh), TypeScript, and [OpenTUI React](https://github.com/anomalyco/opentui).

## Quick Start

```bash
cd tui
bun install
bun run start
```

## Features

- Three-panel TUI: repositories, worktrees, detail view
- Git worktree lifecycle management (create, delete, prune)
- Automatic tmux session creation and attachment
- Repository discovery across a configurable root directory
- Safety checks before deletion (uncommitted changes, unpushed commits)
- Git status badges (modified, unpushed, merged)
- Per-worktree Docker environments with isolated container, network, volumes, and stable host port
- Clipboard integration (copy path or branch name)
- Configurable via YAML file and environment variables

## Prerequisites

- [Bun](https://bun.sh) >= 1.0
- Git >= 2.30
- tmux >= 3.0
- macOS or Linux

## Installation

```bash
cd tui
bun install
```

## Usage

```bash
# Launch the TUI
bun run start

# Launch with file watching (auto-restart on changes)
bun run dev

# Run directory-local container commands from a repo/worktree
bun run start -- container status
```

### Keyboard Shortcuts

| Key                  | Action            |
| -------------------- | ----------------- |
| `j` / `k` / Up / Down | Navigate list   |
| `Tab` / `Shift+Tab`   | Switch panel    |
| `Enter`              | Select / Confirm  |
| `n`                  | New worktree      |
| `N`                  | New worktree + start container |
| `o`                  | Open in tmux      |
| `d`                  | Delete worktree   |
| `s`                  | Start container   |
| `x`                  | Stop container    |
| `i`                  | Build repo image  |
| `g`                  | Create config scaffold |
| `y`                  | Copy container config path |
| `v`                  | Inspect container |
| `r`                  | Refresh           |
| `p`                  | Prune orphans     |
| `c`                  | Copy path         |
| `b`                  | Copy branch name  |
| `?`                  | Show help         |
| `q` / `Ctrl+C`      | Quit              |

### Three-Panel Layout

```
+------------------+----------------------+------------------------+
|  Repositories    |     Worktrees        |       Detail           |
|  (25%)           |     (35%)            |       (40%)            |
|                  |                      |                        |
|  > my-project    |  > main              |  Branch: main          |
|    other-repo    |    feature/foo       |  Path: /path/to/wt     |
|                  |    bugfix/bar        |  Status: clean         |
|                  |                      |  Ahead: 0  Behind: 0   |
+------------------+----------------------+------------------------+
| Status bar                                                       |
+------------------------------------------------------------------+
```

## Configuration

Configuration is loaded from three sources in ascending priority:

1. **Built-in defaults** (lowest)
2. **YAML config file** at `~/.config/swarm/config.yaml` (or `.yml`)
3. **Environment variables** prefixed with `SWARM_` (highest)

### Example config.yaml

```yaml
# Root directory containing managed repositories
ai_working_dir: ~/swarm/ai_working

# Default base branch for new worktrees
default_base_branch: main

# Worktree directory layout pattern
# patternA: <root>/<repo>__wt__<slug>  (flat siblings, default)
# patternB: <repo>/.worktrees/<slug>   (nested in repo)
# patternC: <root>/.worktrees/<repo>/<slug> (centralized)
worktree_pattern: patternA

# Create tmux session when creating a worktree
create_session_on_create: true

# Custom tmux layout script (optional)
tmux_layout_script: ~/.config/swarm/layout.sh

# Status cache TTL (supports ms, s, m, h suffixes)
status_cache_ttl: 30s

# Auto-prune orphaned state on worktree removal
auto_prune_on_remove: true

# Stable host port range for worktree containers
container_port_range_start: 4100
container_port_range_end: 4899
```

### Environment Variables

| Variable                         | Description                            |
| -------------------------------- | -------------------------------------- |
| `AI_WORKING_DIR`                 | Root directory (also used as default)  |
| `SWARM_AI_WORKING_DIR`           | Root directory (overrides above)       |
| `SWARM_DEFAULT_BASE_BRANCH`      | Default base branch                    |
| `SWARM_WORKTREE_PATTERN`         | Directory layout pattern               |
| `SWARM_CREATE_SESSION_ON_CREATE` | `true` / `false`                       |
| `SWARM_TMUX_LAYOUT_SCRIPT`       | Path to custom tmux layout script      |
| `SWARM_STATUS_CACHE_TTL`         | Cache TTL in milliseconds              |
| `SWARM_AUTO_PRUNE_ON_REMOVE`     | `true` / `false`                       |
| `SWARM_CONTAINER_PORT_RANGE_START` | First host port for containers      |
| `SWARM_CONTAINER_PORT_RANGE_END`   | Last host port for containers       |

## Container Environments

Swarm can manage one Docker-backed development environment per worktree. Each environment gets:

- A dedicated container
- A dedicated Docker network
- Dedicated named volumes for persistent dev data
- One stable host-exposed app port from the configured range
- Reusable repo base images plus dependency-keyed variant images

Container config lives outside the repo under `~/.config/swarm/containers/<repo-name>--<path-hash>.yml`. In the TUI, `g` creates the starter file and `y` copies the expected container config path even before the file exists.

### Example repo container config

```yaml
schema_version: 1
repo_path: /Users/you/swarm/ai_working/my-app
preset: node-web

runtime:
  base_image: node:22-bookworm-slim
  packages:
    - libvips-dev

env:
  file: .env.development
  vars:
    NODE_ENV: development

build:
  install: bun install

setup:
  command: bun run db:prepare

processes:
  app:
    command: bun run dev -- --host 0.0.0.0 --port 3000
    expose: true
    internal_port: 3000
  worker:
    command: bun run worker
```

Rules:

- `repo_path` must exactly match the managed repo path
- `env.file` must be repo-relative
- exactly one process may set `expose: true`
- dependency changes produce stale-image warnings until you rebuild with `i` or `swarm container build`

### CLI container commands

Run these from inside a managed worktree unless noted otherwise:

```bash
# Start the selected worktree environment
bun run start -- container up

# Stop the current worktree environment
bun run start -- container down

# Rebuild the repo image set
bun run start -- container build

# Inspect live status and stale-image warnings
bun run start -- container status

# Show recent logs for the current worktree container
bun run start -- container logs
```

### TUI container workflow

1. Add the repo config file under `~/.config/swarm/containers/`
2. Launch Swarm and select a repo/worktree
3. Press `y` to copy the expected container config path, or `g` to create the scaffold in that location
4. Press `i` to build images explicitly, or press `s` to start and auto-build when needed
5. Press `N` to create a worktree and immediately start its container
6. Press `v` to refresh live container status and inspect stale-image warnings
7. Press `x` to stop the environment while preserving volumes
8. Delete the worktree with `d` to remove the environment and data volumes completely

## Directory Layout

### Pattern A (Default - Flat Siblings)

```
ai_working/
  my-project/                          # Base repository
  my-project__wt__feature_foo/         # Worktree for feature/foo
  my-project__wt__bugfix_bar/          # Worktree for bugfix/bar
  other-repo/
  other-repo__wt__experiment/
```

### Tmux Session Naming

Format: `<repo>--wt--<slug>`

Examples:
- `my-project--wt--feature_foo`
- `other-repo--wt--experiment`

## Development

### Project Structure

```
tui/
  src/
    index.tsx              # Entry point
    App.tsx                # Root component (3-panel layout)
    types/                 # Domain type definitions
    utils/                 # Shell execution, result type, slug, git parser
    services/              # Core services (Config, Git, Tmux, Repo, etc.)
    commands/              # Command pattern implementations
    state/                 # React Context + useReducer state management
    hooks/                 # Custom hooks (state, services, keyboard)
    components/            # UI components (panels, lists, dialogs)
    __tests__/             # Test suite
  package.json
  tsconfig.json
  biome.json
```

### Architecture

```
Services (OOP)        Stateless wrappers around git, tmux, filesystem
    |
Commands (pattern)    Encapsulate user actions, return Result<T>
    |
State (Context)       React Context + useReducer for app state
    |
Components (React)    OpenTUI React components for rendering
```

### Commands

```bash
# Run the TUI
bun run start

# Run with file watching
bun run dev

# Run tests
bun test

# Type check
bun run typecheck      # or: tsc --noEmit

# Lint
bun run lint           # or: bunx biome check .

# Lint and auto-fix
bun run lint:fix       # or: bunx biome check --write .

# Build
bun run build
```

### Running Tests

```bash
bun test
```

Tests cover the state reducer, git output parser, slug generation, and UI components. All 61 tests pass with 0 failures.

## Why Swarm?

Working on multiple features simultaneously means juggling Git branches and development contexts. Swarm automates:

1. **Worktree management** - No manual `git worktree add/remove` commands
2. **Tmux integration** - Each worktree gets a dedicated session
3. **Context switching** - Select a worktree, press `o`, and you're in tmux
4. **Safety** - Pre-deletion checks for uncommitted changes and unpushed commits
5. **Discoverability** - Browse all repos and worktrees in one place

## License

[License to be determined]
