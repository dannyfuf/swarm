# Design Decisions: Docker Worktree Containers

Generated: 2026-03-25

## Original Task

> I need to dockerize my dev environment to support isolated parallel work across git worktrees.
> Each worktree gets its own Docker Compose stack with the app and all its dependencies (DB, cache, etc.) fully isolated. No two worktrees should ever share state, ports, networks, or volumes. The worktree directory is bind-mounted into the container so changes from the host are reflected immediately.
> Neovim and AI coding agents run on the host and edit files directly -- they never run inside containers.
> Provide scripts to spin up and tear down a worktree's stack from within its directory.
>
> we need to integrate this to the swarm flow. I want to be able to spin up the containers from the TUI after creating a worktree. I mean i select a repo, i create a new worktree, then i select the worktree i just created and use a keybind to spin up the container. I also want a new keybind to create a worktree and automatically create the container too.
>
> the ports always should be internal of the container, for example if i have a rails app that uses a postgres db. It should expose the app port to be able to check what is going on but the postgres port its not needed to be accessible from the host. Almost no service but the main app need to expose the port to the host.
>
> for the images, we should minimize the build time. So im thinking we should mount all the containers with a common image, like build the image based on the main app and mount a different volume (the actual code) that points to the worktree code. The dependencies should barely change overtime. Idk if this make sense, but i dont want to wait a long time to spin up the environment for my worktree.
>
> Since all the project may have similar stacks to spin up we should have a preset of services to spin up the container. This shuold be configurable by a file and allow to configure the image easily, a simplified version of the docker-compose. I imagine something like
> ```
> container:
>     main_project_path: <path to the original repo (not a worktree)
>     stack: ruby:3.6.6, postgress:latest, redis:latest
>     setup: bin/rails setup-dev && bin/rails setup # command to install dependencies
>     env: <path to a env file in the project>
>
>     services:
>         app:
>             run: make start-app # command to run the main app
>             port: 3000 # exposed port to host
>         worker:
>             run: make start-worker # command to run a worker
>             # no port specified, so no port exposed.
>
> ```
> and we should use the info from "container" info to spin up a container with the stack installed, then mount the volume with the code, then install dependencies. And we have to start two process inside that container, for example, start the webserver and a worker. both inside the same container and connected to the same db and redis (for example).
>
> this is a draft of what i want, im not actually sure this is good approach. So I need you to analize this, understand the intent behind it and propose an implementation design. not a plan nor actual implementation.

## Refined Requirements

1. **Per-worktree container isolation**: Each swarm worktree gets its own Docker container running the full application stack (app, DB, cache, workers). No two worktrees share state, ports, networks, or volumes.
2. **Bind-mount for live code editing**: The worktree directory on the host is bind-mounted into the container so that Neovim and AI coding agents (running on the host) can edit files that are immediately reflected inside the container.
3. **Minimal host port exposure**: Only the main application service (e.g., the web server) exposes a port to the host. Supporting services (postgres, redis, workers) are only accessible inside the container -- they do not need host ports.
4. **Fast spin-up via shared base image**: One Docker image is built per repo (not per worktree). It contains the OS, language runtime, system services, and application dependencies. Worktrees bind-mount their code at runtime, reusing the same image. Rebuild is manual, only needed when dependencies change.
5. **Simplified container config per repo**: A YAML config file (simpler than raw docker-compose) defines the stack: base image, system packages, dependency install command, setup command, env file, and services with their run commands and optional port exposure. Swarm reads this config and manages the container lifecycle.
6. **TUI keybind: start containers**: A keybind (`s`) on the worktrees panel spins up the container for the selected worktree.
7. **TUI keybind: create + start**: A keybind (`N`) creates a new worktree AND automatically spins up its container in one action.
8. **TUI keybind: stop containers**: A keybind (`x`) tears down the container for the selected worktree.
9. **TUI keybind: rebuild image**: A keybind (`i`) rebuilds the shared Docker image for the selected repo.
10. **CLI support for up/down**: Container spin-up and teardown must also be available as CLI commands (not just TUI), so scripts and automation can manage stacks.

**Clarifications made:**
- "mount all the containers with a common image" was interpreted as "one Docker image per repo, reused across all worktrees via bind-mounted code" because the intent is to avoid rebuilding images per worktree and keep spin-up fast.
- "stack: ruby:3.6.6, postgres:latest, redis:latest" was interpreted as "use an official language Docker image as the base, install postgres and redis as system packages inside it" because a single-container model cannot compose multiple Docker images, and the user confirmed this architecture.
- "start two processes inside that container" was interpreted as "single-container model with a bash entrypoint managing multiple processes" because the user explicitly chose the single fat container approach over docker-compose multi-container.
- "main_project_path" was dropped from the config because swarm already tracks repo paths via `repo.Discovery` and `state.Store`; it would be redundant.
- The original task mentions "Docker Compose stack" but the resolved architecture is a single Docker container (not compose), since the user chose the single-container model. Docker Compose is not used.

## Overview

This feature adds Docker container management to swarm, enabling each git worktree to run its own isolated development environment (app server, database, cache, background workers) inside a single Docker container. A per-repo config file defines the stack, and swarm handles image building, container lifecycle, port allocation, and TUI/CLI integration. The worktree's code is bind-mounted so host-side editing works seamlessly.

## Scope

**In scope:**
- Container config file format and loading (`~/.config/swarm/containers/<repo-name>.yml`)
- Dockerfile generation from config (auto-generated, not user-maintained)
- Bash entrypoint generation for process supervision inside the container
- Image build command (manual trigger, one image per repo)
- Container start/stop commands per worktree
- Port allocation system (auto-assign from range, persisted in state)
- Named Docker volumes for data persistence (postgres/redis data)
- TUI keybinds: `s` (start), `N` (create+start), `x` (stop), `i` (rebuild image)
- CLI commands: `swarm container up`, `swarm container down`, `swarm container build`
- Container status display in TUI (list indicator + detail panel)
- State tracking for container metadata (port, status, container name)
- Integration with existing delete workflow (auto-stop container on worktree delete)

**Out of scope:**
- Multi-container docker-compose orchestration (decided: single container)
- Production deployment or multi-environment support
- Container orchestration beyond Docker (no Kubernetes, Podman, etc.)
- Remote Docker hosts (assumes local Docker daemon)
- GPU passthrough or specialized hardware access
- Container networking beyond the single container (no inter-worktree communication)
- Log aggregation or monitoring dashboards

## Decisions

### 1. Single Fat Container Architecture
**Addresses:** Requirements 1, 3
**Context:** The developer works across multiple worktrees simultaneously. Each needs a complete dev environment (app + DB + cache + workers). The question is whether to use docker-compose with separate containers per service, or a single container running everything.
**Options considered:**
- **Multi-container docker-compose**: Standard approach. Each service (postgres, redis, app, worker) is a separate container on an isolated Docker network. Pros: follows Docker best practices, clean separation of concerns, easy to restart individual services. Cons: more complex orchestration, slower startup (multiple containers), more resource overhead, more moving parts to manage per worktree.
- **Single fat container**: One container runs everything via a process supervisor. Pros: simpler lifecycle (one container to start/stop), faster startup, lower resource overhead, simpler networking (everything is localhost inside the container). Cons: non-standard Docker pattern, all-or-nothing restarts, process supervision complexity.

**Decision:** Single fat container with a bash entrypoint script managing all processes.
**Rationale:** This is a dev environment, not production. Simplicity and speed of spin-up matter more than separation of concerns. A single container means one `docker run` to start everything and one `docker stop` to tear it down. The bash entrypoint is sufficient for dev-environment reliability requirements.

### 2. Official Language Image as Base + System Packages
**Addresses:** Requirements 4, 5
**Context:** The container needs the correct language runtime (exact version) plus services like postgres and redis. In a single-container model, we must install everything into one image.
**Options considered:**
- **Lean base (debian-slim/alpine) + install everything via package manager**: Maximum control, but language runtimes from system packages are often outdated or wrong version. Requires version managers (asdf/mise) which add build complexity and time.
- **Official language Docker image + apt-get for services**: Images like `ruby:3.2.6-slim` are already Debian-slim with the exact language version pre-compiled. Adding postgres and redis via `apt-get` is straightforward and fast.

**Decision:** Use official language Docker images (e.g., `ruby:3.2.6-slim`) as the base, install service packages (postgresql, redis-server) via `apt-get`.
**Rationale:** Official language images give exact version control with zero build overhead for the runtime. They're already lean (Debian-slim based). Installing services via `apt-get` on top is fast and well-cached by Docker's layer system. This avoids the complexity of version managers entirely.

### 3. Dependencies Baked Into Image at Build Time
**Addresses:** Requirement 4
**Context:** Application dependencies (gems, npm packages) change infrequently. Installing them every container start would be slow. But some setup tasks (db:create, db:migrate) require a running database and the actual app code, so they can't happen at image build time.
**Options considered:**
- **All setup at container start**: Simple but slow -- `bundle install` runs every time.
- **All setup at image build**: Fast starts but impossible -- DB setup needs a running database.
- **Split into install (build-time) and setup (start-time)**: Dependencies baked into image, DB setup at start.

**Decision:** Split into two phases. The config has two fields:
- `install`: Runs during `docker build`. Installs language dependencies (e.g., `bundle install`, `npm install`). Baked into the image.
- `setup`: Runs every container start. Handles DB creation, migrations, seeds. Must be idempotent.

**Rationale:** This gives fast container starts (dependencies are cached in the image) while still handling setup tasks that require runtime services. The `setup` command runs every start to catch new migrations when switching between branches.

### 4. Manual Image Rebuild
**Addresses:** Requirement 4
**Context:** The shared Docker image needs rebuilding when dependencies change (e.g., Gemfile.lock updated). The question is whether to detect this automatically or let the user trigger it.
**Options considered:**
- **Manual rebuild only**: User presses `i` in TUI or runs `swarm container build`. Simple, predictable, no magic.
- **Auto-detect lockfile changes on spin-up**: Hash the lockfile, compare to image metadata. Rebuild if different. More convenient but adds startup latency and complexity.

**Decision:** Manual rebuild triggered by user via TUI keybind (`i`) or CLI command.
**Rationale:** Simplicity. Dependency changes are infrequent and deliberate -- the developer knows when they've changed the Gemfile. Automatic detection adds complexity for a low-frequency event. If the user forgets, the container will still work (old deps) and the error will be obvious.

### 5. Bash Entrypoint for Process Supervision
**Addresses:** Requirement 1
**Context:** A single container must run multiple processes: postgres, redis, the app server, and optionally workers. Something must start them in order, manage their lifecycle, and handle shutdown signals.
**Options considered:**
- **supervisord**: Industry-standard, auto-restart, XML config. Heavier, requires installation in image.
- **s6-overlay**: Container-native, fast, proper PID 1. Steep learning curve.
- **Bash entrypoint script**: Simple shell script. Starts services in order, traps SIGTERM, shuts down cleanly. No auto-restart on crash.

**Decision:** Bash entrypoint script generated by swarm from the container config.
**Rationale:** This is a dev environment. Crash recovery is not critical -- if postgres dies, the developer will notice and restart the container. A bash script is easy to understand, debug, and generate. It has zero additional dependencies. The script will:
1. Start postgres, wait for readiness
2. Start redis
3. Run the `setup` command (db:migrate, etc.)
4. Start all services defined in config as background processes
5. Trap SIGTERM/SIGINT and shut down all processes cleanly
6. Wait for any child process to exit; if one dies, log it

### 6. Container Config in Global Swarm Config Directory
**Addresses:** Requirement 5
**Context:** Each repo needs a config file defining its container stack. The file could live in the repo itself, in swarm's global config, or alongside the worktrees.
**Options considered:**
- **In the repo root** (`.swarm-container.yml`): Version-controlled, portable, self-describing. Pollutes the project with swarm-specific files.
- **In swarm's global config** (`~/.config/swarm/containers/<repo-name>.yml`): Centralized, doesn't pollute repos. Not version-controlled with the project.
- **In ai_working_dir** (`<ai_working_dir>/.swarm-containers/<repo>.yml`): Near the worktrees. Middle ground.

**Decision:** `~/.config/swarm/containers/<repo-name>.yml`. Filename must match the repo directory name as known to swarm.
**Rationale:** Developer chose centralized config to keep project repos clean. Swarm already uses `~/.config/swarm/` for its config (see `internal/config/loader.go:41`). Container configs are a natural extension. The filename-matches-repo-name convention means zero additional mapping config -- swarm just looks up `<repo.Name>.yml`.

### 7. Config File Schema
**Addresses:** Requirement 5
**Context:** The config needs to express: base image, system packages, dependency install command, runtime setup command, env file, and service definitions with run commands and optional port exposure.

**Decision:** The config schema is:

```yaml
# ~/.config/swarm/containers/my-rails-app.yml
image: ruby:3.2.6-slim          # Base Docker image (required)
packages:                        # System packages to apt-get install (optional)
  - postgresql
  - redis-server
  - libpq-dev
  - build-essential
install: bundle install          # Run during image build (optional)
setup: |                         # Run every container start, must be idempotent (optional)
  bin/rails db:prepare
  bin/rails db:seed
env: .env.development            # Env file path, relative to project root (optional)
workdir: /app                    # Mount point inside container (default: /app)

services:                        # Processes to run inside the container (required)
  app:
    run: bin/rails server -b 0.0.0.0
    port: 3000                   # Exposed to host (optional, only for main app)
  worker:
    run: bundle exec sidekiq     # No port = not exposed
```

**Rationale:** This is intentionally simpler than docker-compose. It captures exactly the decisions that vary between projects while swarm handles all the Docker orchestration details (Dockerfile generation, entrypoint script, port mapping, volume mounts). The `install` vs `setup` split reflects Decision 3.

### 8. Auto-Detect Dependency Files for Image Build
**Addresses:** Requirement 4
**Context:** During `docker build`, dependency lockfiles (Gemfile.lock, package-lock.json) must be copied into the image before running `install`. Different languages use different files. The question is whether the user specifies these files or swarm detects them.
**Options considered:**
- **Explicit in config** (`deps: [Gemfile, Gemfile.lock]`): Clear, works for any stack. Extra config to maintain.
- **Auto-detect from base image**: Swarm infers that `ruby:*` images need `Gemfile` + `Gemfile.lock`, `node:*` images need `package.json` + `package-lock.json`, etc.

**Decision:** Auto-detect based on the base image name. Swarm maintains a mapping of image prefixes to known dependency files:
| Image prefix | Files copied |
|---|---|
| `ruby:` | `Gemfile`, `Gemfile.lock` |
| `node:` | `package.json`, `package-lock.json` (or `yarn.lock` if present) |
| `python:` | `requirements.txt` (or `pyproject.toml` + `poetry.lock`) |
| `golang:` | `go.mod`, `go.sum` |

If the base image doesn't match any known prefix, no dependency files are copied and the `install` command runs with only the full code mount (less cacheable but still functional).

**Rationale:** Reduces config boilerplate for the common case. The mapping is a simple lookup table in Go code, easy to extend. For unusual setups, the user can skip `install` and put everything in `setup` (trading build caching for flexibility).

### 9. Auto-Assign Host Ports from Range
**Addresses:** Requirement 3
**Context:** When multiple worktrees of the same repo run simultaneously, they all want the same app port (e.g., 3000). The host can only bind one process per port, so we need a port allocation strategy.
**Options considered:**
- **Auto-assign from range**: Swarm picks a unique port from a configurable range (e.g., 10000-10999). Stored in state, stable across restarts.
- **Random (Docker picks)**: `docker run -p 0:3000`. Zero conflicts but port changes every restart.
- **User-specified**: Maximum control, maximum friction.

**Decision:** Auto-assign from a configurable range. Default range: `10000-10999`. Configured via `container_port_range_start` and `container_port_range_end` in `~/.config/swarm/config.yml`. The assigned port is persisted in `WorktreeState` so it remains stable across container restarts.

Port allocation algorithm:
1. Load all assigned ports from state across all repos/worktrees
2. Find the lowest available port in the range
3. Assign it and persist to state immediately (before starting the container)
4. When a worktree is deleted, its port is freed
5. When a container is stopped (but worktree kept), the port stays assigned for stability

**Rationale:** Developers need predictable URLs (e.g., `localhost:10003` for their feature branch). Auto-assignment eliminates manual coordination while the persisted mapping ensures the port doesn't change between restarts. The range is high enough to avoid conflicts with common services.

### 10. Container Naming Convention
**Addresses:** Requirement 1
**Context:** Each Docker container needs a unique, identifiable name for management (start, stop, inspect, logs).

**Decision:** Container name format: `swarm-<repo-name>-<worktree-slug>`. Example: `swarm-my-rails-app-feature_login`.

Volume name format: `swarm-<repo-name>-<worktree-slug>-data`. This volume holds postgres and redis data directories.

Image name format: `swarm/<repo-name>:latest`. One image per repo.

**Rationale:** The `swarm-` prefix makes containers instantly identifiable in `docker ps`. Using the worktree slug (already guaranteed unique per repo by `internal/worktree/slug.go`) ensures no naming collisions. The naming mirrors the existing `__wt__` convention used for worktree directories but adapted for Docker naming rules (no double underscores).

### 11. TUI Keybindings for Container Operations
**Addresses:** Requirements 6, 7, 8, 9
**Context:** The TUI needs new keybinds for container lifecycle management. These must fit alongside existing keybinds without conflicts. Current worktrees panel binds: `enter, n, o, d, r, p, c, b, ?`.
**Options considered:**
- `s/N/x/i`: Start, New+start, stop(eXit), Image build
- `u/N/x/i`: Up, New+up, stop, Image build

**Decision:**
| Key | Action | Panel | Behavior |
|-----|--------|-------|----------|
| `s` | Start container | Worktrees | Starts container for selected worktree. If no image exists, auto-builds first. |
| `N` (shift+n) | Create + Start | Repos or Worktrees | Shows branch input, creates worktree, then auto-starts container. |
| `x` | Stop container | Worktrees | Stops and removes the container for selected worktree. Preserves data volume. |
| `i` | Build image | Repos | Builds/rebuilds the Docker image for the selected repo. |

**Rationale:** Mnemonics: **S**tart, **N**ew+, e**X**it, **I**mage. `N` extends the existing `n` (create worktree) pattern -- lowercase creates, uppercase creates+starts. `s` and `x` are symmetric start/stop. `i` is on the repos panel because images are per-repo, not per-worktree.

### 12. Container Status Display in TUI
**Addresses:** Requirements 6, 7, 8
**Context:** Users need to see which worktrees have running containers, what port they're on, and the container's health. The TUI has a worktree list (middle panel) and a detail view (right panel).

**Decision:**
- **Worktree list**: Add a colored status indicator before the branch name. Green circle for running, red circle for stopped (has config but container not running), no indicator for worktrees without container config.
- **Detail panel**: Add a "Container" section showing: status (running/stopped/none), container name, assigned host port, image name, uptime (if running).
- **Status bar**: Update the worktrees panel keybind hints to include `s: start | x: stop` alongside existing binds.

**Rationale:** The list indicator gives at-a-glance status for scanning across worktrees. The detail panel provides full info when a specific worktree is selected. This follows the existing pattern where the list shows summary info and the detail panel shows expanded info (see `view.go:155-198`).

### 13. Container State Tracking
**Addresses:** Requirements 6, 7, 8
**Context:** Swarm needs to track container metadata per worktree. The existing state system uses `.swarm-state.json` with `WorktreeState` structs (see `internal/state/types.go:21-28`).

**Decision:** Extend `WorktreeState` with container fields:

```go
type WorktreeState struct {
    // ... existing fields ...
    ContainerName   string `json:"container_name,omitempty"`
    ContainerPort   int    `json:"container_port,omitempty"`
    ContainerImage  string `json:"container_image,omitempty"`
}
```

Container running/stopped status is NOT persisted -- it's queried live from Docker (`docker inspect`) when needed. This avoids stale state if a container is stopped outside of swarm.

**Rationale:** The existing state store (`internal/state/store.go`) already handles atomic writes with file locking. Adding fields to `WorktreeState` is the minimal change. Live-querying Docker for running status is more reliable than persisting it, since containers can be stopped externally (`docker stop`, system restart, OOM kill).

### 14. Worktree Deletion with Running Container
**Addresses:** Requirement 1
**Context:** The existing `d` keybind deletes a worktree after a safety check. If the worktree has a running container, deleting the worktree would leave an orphaned container.

**Decision:** When deleting a worktree that has a running container, show an enhanced confirmation dialog: "Container is running for this worktree. Stop container and delete worktree?" On confirmation, swarm stops the container, removes the data volume, then proceeds with the normal worktree deletion flow (safety check, git worktree remove, state cleanup).

**Rationale:** This prevents orphaned containers while keeping the flow smooth. The dialog makes the consequence explicit -- the developer knows their DB data for this worktree will be lost. This follows the existing pattern of confirmation dialogs for destructive actions (see `update.go:85-104`).

### 15. Data Persistence via Named Docker Volumes
**Addresses:** Requirement 1
**Context:** When a container is stopped and restarted (e.g., developer takes a break), should the database data survive? Recreating the DB on every start is slow and loses test data.

**Decision:** Named Docker volumes per worktree store persistent data (postgres data dir, redis dump). Volume name: `swarm-<repo>-<slug>-data`. Mounted to appropriate paths inside the container (e.g., `/var/lib/postgresql/data`, `/var/lib/redis`).

Lifecycle:
- **Container stop** (`x`): Container removed, volume preserved. Next `s` restarts with existing data.
- **Worktree delete** (`d`): Container removed AND volume removed. Clean slate.
- **Image rebuild** (`i`): No effect on volumes. Data survives rebuilds.

**Rationale:** Developers accumulate test data, run seeds, create test users. Losing this on every restart wastes time. Named volumes (not anonymous) ensure data is predictably stored and can be explicitly cleaned up. Tying volume deletion to worktree deletion (not container stop) means the cleanup boundary matches the developer's mental model: "I'm done with this branch" = clean everything up.

### 16. CLI Commands for Container Management
**Addresses:** Requirement 10
**Context:** Container management must work from the CLI for scripting and automation, not just the TUI.

**Decision:** Add a `container` (or `ctr`) subcommand group to the cobra CLI:

```
swarm container build [repo]       # Build/rebuild image for repo
swarm container up [repo] [branch] # Start container for a worktree
swarm container down [repo] [branch] # Stop container for a worktree
swarm container status [repo]      # Show container status for all worktrees
swarm container logs [repo] [branch] # Tail container logs
```

If `repo` is omitted and the current directory is inside a worktree, infer the repo. If `branch` is omitted and inside a worktree, infer from the current directory.

**Rationale:** CLI commands follow the existing pattern (`swarm create`, `swarm open`, `swarm remove` in `cmd/`). The `container` subgroup keeps container operations namespaced. Auto-inferring repo/branch from the current directory enables usage from within a worktree without specifying arguments.

### 17. Dockerfile Generation Strategy
**Addresses:** Requirements 4, 5
**Context:** Swarm generates a Dockerfile from the container config. This Dockerfile needs to be stored somewhere, rebuilt on demand, and used when starting containers.

**Decision:** Swarm generates the Dockerfile and entrypoint script in a build context directory: `~/.config/swarm/containers/.build/<repo-name>/`. Files generated:
- `Dockerfile` -- generated from config
- `entrypoint.sh` -- generated from config services
- Dependency files are copied from the main repo path at build time (not symlinked)

The generated Dockerfile structure:
```dockerfile
FROM <image>

RUN apt-get update && apt-get install -y <packages> && rm -rf /var/lib/apt/lists/*

WORKDIR <workdir>

# Copy dependency files from build context
COPY Gemfile Gemfile.lock ./
RUN <install>

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
```

At `docker run` time, the worktree path is bind-mounted to `<workdir>`. The installed dependencies (e.g., `/usr/local/bundle` for Ruby) persist from the image layer.

**Rationale:** Using a dedicated build context directory keeps generated files out of the repo and out of the worktree. Copying dependency files (not symlinking) into the build context ensures Docker can access them regardless of the main repo's location. The generated files are treated as cache -- they can be regenerated at any time from the config.

### 18. Setup Command Runs Every Container Start
**Addresses:** Requirement 4
**Context:** The `setup` command handles tasks like DB migration and seeding that require a running database. It runs at container start time (not build time).

**Decision:** The `setup` command runs every time the container starts, after system services (postgres, redis) are ready. The command must be idempotent (e.g., `bin/rails db:prepare` which creates-if-not-exists and migrates).

The entrypoint script sequence:
1. Start postgres, poll until accepting connections
2. Start redis
3. Run `setup` command
4. Start all `services` as background processes
5. Wait / signal trap loop

**Rationale:** Running setup every start catches new migrations when switching between branches (a branch may have added migrations that the DB from a previous session doesn't have). Since the DB data persists via volumes, idempotent commands like `db:prepare` are fast when nothing has changed (they just check and skip).

## Patterns to Follow

- **TUI keybind registration**: Add `case` statements in `handleKeyMsg()` at `internal/tui/update.go:128-186`. Implement handlers in `internal/tui/actions.go` following the existing pattern (e.g., `handleOpen()` at line 108).
- **Async TUI commands**: Follow the `tea.Cmd` pattern in `internal/tui/commands.go` and `internal/tui/actions.go`. Define message types (e.g., `containerStartedMsg`), return commands from handlers, process messages in `Update()`.
- **Confirmation dialogs**: Use `showConfirmDialog()` from `internal/tui/dialog.go:73-79`. Handle in `updateDialog()` at `internal/tui/update.go:334-381`.
- **State persistence**: Extend `WorktreeState` in `internal/state/types.go:21-28`. State is automatically persisted via the atomic write pattern in `internal/state/store.go`.
- **CLI command registration**: Add cobra commands in `cmd/` following the pattern in `cmd/create.go`, `cmd/open.go`. Wire dependencies the same way as `cmd/tui.go:30-57`.
- **Config loading**: The existing Viper-based loader at `internal/config/loader.go` handles `~/.config/swarm/config.yml`. Container configs in `~/.config/swarm/containers/` would use a separate loader but follow the same Viper pattern.
- **Dependency injection in TUI**: The `tui.New()` constructor at `internal/tui/model.go:81-128` accepts all dependencies as parameters. A new `container.Manager` would be injected the same way, wired up in `cmd/tui.go`.

## Data Model Changes

### WorktreeState Extension (`internal/state/types.go`)

```go
type WorktreeState struct {
    Slug            string    `json:"slug"`
    Branch          string    `json:"branch"`
    Path            string    `json:"path"`
    CreatedAt       time.Time `json:"created_at"`
    LastOpenedAt    time.Time `json:"last_opened_at"`
    TmuxSession     string    `json:"tmux_session"`
    // New container fields
    ContainerName   string    `json:"container_name,omitempty"`
    ContainerPort   int       `json:"container_port,omitempty"`
    ContainerImage  string    `json:"container_image,omitempty"`
}
```

### Config Extension (`internal/config/config.go`)

```go
type Config struct {
    // ... existing fields ...
    ContainerPortRangeStart int  // Default: 10000
    ContainerPortRangeEnd   int  // Default: 10999
}
```

### New Container Config Structure (new package: `internal/container/config.go`)

```go
type ContainerConfig struct {
    Image    string            // e.g., "ruby:3.2.6-slim"
    Packages []string          // e.g., ["postgresql", "redis-server"]
    Install  string            // Run during docker build
    Setup    string            // Run every container start
    Env      string            // Path to env file (relative to project root)
    Workdir  string            // Mount point, default "/app"
    Services map[string]Service
}

type Service struct {
    Run  string // Command to execute
    Port int    // Host-exposed port (0 = not exposed)
}
```

## Edge Cases and Error Handling

| Scenario | Expected Behavior |
|----------|-------------------|
| Docker daemon not running | Show clear error: "Docker is not running. Start Docker Desktop and try again." Do not crash. |
| No container config exists for repo | `s`, `N`, `i` keybinds show: "No container config found for <repo>. Create one at ~/.config/swarm/containers/<repo>.yml". |
| Port range exhausted (all ports allocated) | Show error: "No available ports in range 10000-10999. Stop some containers or expand the range in config." |
| Container start fails (e.g., port conflict with non-swarm process) | Show Docker error message in status bar. Suggestion: "Port 10003 in use. Try `swarm container down` or check for conflicting processes." |
| Image build fails (e.g., invalid package name) | Show build output in a scrollable view or log file. Status bar shows "Image build failed. Check logs at <path>." |
| Worktree deleted outside swarm while container running | Orphan detection (existing `internal/worktree/orphan.go`) should also check for orphaned containers and offer cleanup. |
| Two swarm instances try to allocate ports simultaneously | The existing file-lock mechanism in `internal/state/store.go` prevents concurrent state writes. Port allocation is protected by the same lock. |
| `setup` command fails (e.g., migration error) | Container keeps running (postgres/redis are up). Error is logged. Developer can shell in (`docker exec`) to debug. The services are NOT started -- only `setup` success triggers service startup. |
| Base image not found (e.g., typo in config) | Docker pull fails with clear error. Surfaced as: "Image 'rubi:3.2.6-slim' not found. Check the 'image' field in your container config." |
| Container stopped externally (`docker stop` outside swarm) | Live status check via `docker inspect` detects this. TUI shows container as stopped. Port assignment preserved in state for restart. |

## Risks and Assumptions

**Assumptions:**
- Docker is installed and the daemon is running on the host machine
- The developer has permissions to run Docker commands without sudo (Docker group membership or Docker Desktop)
- Base images referenced in configs are available from Docker Hub or a configured registry
- System packages listed in `packages` are available via `apt-get` (Debian-based images). Alpine-based images would need `apk` support added later.
- The `install` command produces artifacts in predictable locations (e.g., `bundle install` populates `/usr/local/bundle`) that survive the bind-mount of worktree code at runtime
- Bind-mounting the worktree code at the `workdir` does NOT shadow installed dependencies (e.g., Ruby gems go to `/usr/local/bundle` not `./vendor/bundle`)

**Risks:**
- **Bind-mount shadowing**: If a project uses `vendor/bundle` (vendored gems inside the project), the bind-mount would include it, potentially conflicting with gems installed at build time. Mitigation: Document that `install` commands should install to system paths (default for most languages), not project-local paths.
- **macOS file system performance**: Docker bind-mounts on macOS are notoriously slow for large codebases. Mitigation: This is a known Docker-for-Mac limitation. Consider documenting `:cached` or VirtioFS mount options if performance is an issue.
- **Postgres data directory permissions**: Postgres is particular about data directory ownership. Running as root inside the container simplifies this but is non-ideal. Mitigation: The entrypoint script should initialize the postgres data directory with correct permissions using `su postgres -c "initdb"` if needed.
- **State file version**: Adding fields to `WorktreeState` is backward-compatible (Go's `omitempty` + JSON unmarshaling ignores unknown fields). No state migration needed. But older swarm binaries won't understand the new fields. Low risk since this is a personal tool.

## Migration / Rollout Strategy

This is a new feature with no existing Docker state to migrate. Rollout is incremental:

1. **Phase 1**: Implement `internal/container/` package (config loading, Dockerfile generation, entrypoint generation, image build, container start/stop). Add CLI commands. Test end-to-end with a single repo.
2. **Phase 2**: Integrate into TUI (keybinds, status display, Model changes). Wire up the container manager as a dependency.
3. **Phase 3**: Handle edge cases (delete integration, orphan detection, error reporting).

No breaking changes to existing functionality. The feature is entirely additive -- swarm works exactly as before if no container config exists for a repo.

---
*This document is the input for `/create-plan`. All decisions here should be treated as resolved constraints during planning.*
