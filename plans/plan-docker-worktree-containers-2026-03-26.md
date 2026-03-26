# Implementation Plan: Docker Worktree Containers
Generated: 2026-03-26

## Summary

Add per-worktree Docker-backed development environments to Swarm so each git worktree can be started, stopped, rebuilt, and deleted as an isolated runtime from the TUI and from commands run inside the worktree directory. The goal is to preserve the current host-first editing workflow while giving every worktree its own container, network, volumes, and stable host app port, with fast image reuse across branches.

### Context and scope

Affected code and directories:

- `tui/src/App.tsx`
- `tui/src/index.tsx`
- `tui/src/hooks/useKeyboardShortcuts.ts`
- `tui/src/components/HelpDialog.tsx`
- `tui/src/components/StatusBar.tsx`
- `tui/src/components/DetailView.tsx`
- `tui/src/components/WorktreeList.tsx`
- `tui/src/state/actions.ts`
- `tui/src/state/appReducer.ts`
- `tui/src/state/AppContext.tsx`
- `tui/src/types/config.ts`
- `tui/src/types/state.ts`
- `tui/src/types/worktree.ts`
- `tui/src/services/WorktreeService.ts`
- `tui/src/commands/CreateWorktreeCommand.ts`
- `tui/src/commands/DeleteWorktreeCommand.ts`
- `tui/src/commands/Command.ts`
- `tui/src/__tests__/state/appReducer.test.ts`
- `tui/src/__tests__/components/*.test.tsx`
- `tui/src/__tests__/services/*.test.ts`
- New container-focused modules under `tui/src/services/`, `tui/src/commands/`, and likely `tui/src/types/`
- External swarm-owned config/state locations: `~/.config/swarm/containers/` and `~/.config/swarm/containers/.build/`

In scope:

- Repo-level container config stored outside the repo using path-hash identity
- Per-worktree fat-container lifecycle: build, start, stop, status, logs, cleanup
- Stable host port allocation for one primary exposed app process
- Per-worktree Docker resource isolation: container, network, volumes
- TUI integration for `s`, `x`, `N`, and `i`
- Delete flow cleanup when a worktree has an attached environment
- Directory-local `swarm container ...` commands that infer repo/worktree from cwd
- Persistence of stable container metadata in Swarm state

Out of scope:

- Multi-container Docker Compose orchestration
- Production deployment/runtime hardening
- Podman/Kubernetes support
- Repo-committed Docker config files
- Exposing postgres/redis/cache ports to the host by default
- Broad preset coverage beyond a small curated Debian-family preset set in v1

## Prerequisites

### Environment

- Bun installed and project dependencies available in `tui/` via `bun install`
- Docker Desktop or Docker Engine running locally and accessible without interactive auth
- Git and tmux installed; current TUI already depends on them
- Access to `~/.config/swarm/` for config, generated artifacts, and cache

### Project structure knowledge

- Read `plans/decisions-docker-worktree-containers-2026-03-26.md` first; it is the source of truth for product decisions
- Review `README.md` for current app architecture, scripts, and existing keyboard model
- Understand current service wiring in `tui/src/index.tsx:23`
- Understand command orchestration in `tui/src/App.tsx:101`
- Understand cleanup sequencing in `tui/src/commands/DeleteWorktreeCommand.ts:15`
- Understand keyboard registration in `tui/src/hooks/useKeyboardShortcuts.ts:15`
- Understand persisted state shape in `tui/src/types/state.ts:10`
- Understand config loading/validation in `tui/src/services/ConfigService.ts:15`

### Conventions to follow

- Service classes own shell/process/filesystem logic; UI components stay declarative
- User actions should stay encapsulated in command classes returning `CommandResult`; follow `tui/src/commands/CreateWorktreeCommand.ts:14`
- App-level services are composed once in `tui/src/index.tsx:23` and injected through `tui/src/state/AppContext.tsx:21`
- State changes flow through reducer actions only; follow `tui/src/state/actions.ts:23` and `tui/src/state/appReducer.ts:54`
- Tests use Bun; reducer test style is already established in `tui/src/__tests__/state/appReducer.test.ts:25`

### Background reading

- `plans/decisions-docker-worktree-containers-2026-03-26.md`
- `README.md`
- Docker docs for `docker build`, `docker run`, named volumes, and custom bridge networks

## Task Breakdown

1. Extend config and persisted state for container support
   - Depends on: none
   - Complexity: Medium
   - Files: `tui/src/types/config.ts`, `tui/src/types/state.ts`, `tui/src/types/worktree.ts`, `tui/src/services/ConfigService.ts`, `tui/src/__tests__/state/appReducer.test.ts`
   - Acceptance criteria: config supports host port range defaults; persisted worktree state can store stable container metadata; no existing state loading breaks; tests cover new reducer/state branches

2. Add repo container-config loading and repo identity resolution
   - Depends on: #1
   - Complexity: Medium
   - Files: create `tui/src/services/ContainerConfigService.ts`, `tui/src/services/RepoIdentityService.ts`, `tui/src/types/container.ts`; update `tui/src/index.tsx`, `tui/src/state/AppContext.tsx`
   - Acceptance criteria: given a repo path, Swarm can resolve the expected config file under `~/.config/swarm/containers/<repo>--<hash>.yml`; missing config yields a clear, actionable error

3. Implement Docker artifact generation and image lifecycle
   - Depends on: #2
   - Complexity: High
   - Files: create `tui/src/services/ContainerBuildService.ts`, `tui/src/services/DockerArtifactService.ts`, optionally `tui/src/services/DependencyFingerprintService.ts`; update `tui/src/types/state.ts`
   - Acceptance criteria: Swarm can derive generated Dockerfiles/scripts under `~/.config/swarm/containers/.build/`, compute dependency fingerprints, build repo base and dependency-variant images, and warn on stale dependency manifests without auto-rebuilding existing images

4. Implement per-worktree runtime lifecycle and cleanup
   - Depends on: #3
   - Complexity: High
   - Files: create `tui/src/services/ContainerRuntimeService.ts`, `tui/src/services/PortAllocatorService.ts`, `tui/src/commands/StartContainerCommand.ts`, `tui/src/commands/StopContainerCommand.ts`, `tui/src/commands/BuildContainerImageCommand.ts`, `tui/src/commands/ContainerStatusCommand.ts`; update `tui/src/commands/DeleteWorktreeCommand.ts`, `tui/src/services/WorktreeService.ts`, `tui/src/commands/Command.ts`
   - Acceptance criteria: Swarm can start/stop a fat container for a worktree, preserve volumes on stop, remove all Docker resources on worktree delete, and keep failed environments intact for debugging

5. Integrate container actions into the TUI
   - Depends on: #4
   - Complexity: High
   - Files: `tui/src/App.tsx`, `tui/src/hooks/useKeyboardShortcuts.ts`, `tui/src/components/HelpDialog.tsx`, `tui/src/components/StatusBar.tsx`, `tui/src/components/DetailView.tsx`, `tui/src/components/WorktreeList.tsx`, `tui/src/state/actions.ts`, `tui/src/state/appReducer.ts`, `tui/src/commands/CreateWorktreeCommand.ts`
   - Acceptance criteria: selected worktree supports `s` start, `x` stop, `N` create+start, and `i` repo image build; help text and status hints are updated; detail view shows container metadata and health without blocking normal worktree actions

6. Add directory-local CLI commands for container operations
   - Depends on: #4
   - Complexity: High
   - Files: likely create `tui/src/cli/` modules plus update `tui/src/index.tsx`; may also add a cwd inference utility service
   - Acceptance criteria: `swarm container up`, `swarm container down`, `swarm container build`, `swarm container status`, and `swarm container logs` can infer repo/worktree from the current directory and reuse the same services as the TUI

7. Add automated test coverage and end-to-end validation
   - Depends on: #5 and #6
   - Complexity: Medium
   - Files: create/update `tui/src/__tests__/services/*.test.ts`, `tui/src/__tests__/components/*.test.tsx`, and reducer tests
   - Acceptance criteria: unit tests cover config resolution, fingerprinting, port allocation, Docker command construction, reducer updates, and TUI shortcut behavior; manual checklist passes for build/start/stop/delete flows

## Implementation Details

### 1. Extend config and state model

Files to modify:

- `tui/src/types/config.ts`
- `tui/src/types/state.ts`
- `tui/src/types/worktree.ts`
- `tui/src/services/ConfigService.ts`

Guidance:

- Add `containerPortRangeStart` and `containerPortRangeEnd` to `Config`; this follows the decision doc model and belongs beside existing app-wide defaults in `tui/src/types/config.ts:16`
- Extend `WorktreeState` with optional container metadata only; keep live runtime status out of persisted state, as noted in the decisions doc
- Prefer a new `tui/src/types/container.ts` for config/runtime/build types instead of overloading `worktree.ts`
- Update config mapping in `tui/src/services/ConfigService.ts:79` to support YAML keys and env overrides for port-range settings if desired

Patterns to follow:

- Persisted state shape and date restoration in `tui/src/services/StateService.ts:143`
- Config defaulting and validation in `tui/src/services/ConfigService.ts:43`

Gotchas:

- Preserve backward compatibility for old `.swarm-state.json` files with no `container` block
- Do not persist ephemeral status like running/stopped/healthy in state; query Docker live instead

### 2. Add repo container-config loading and identity resolution

Files to create:

- `tui/src/types/container.ts`
- `tui/src/services/RepoIdentityService.ts`
- `tui/src/services/ContainerConfigService.ts`

Files to modify:

- `tui/src/index.tsx`
- `tui/src/state/AppContext.tsx`

Guidance:

- `RepoIdentityService` should deterministically derive `<repo-name>--<path-hash>` from the absolute repo path; keep naming logic isolated so resource names, config paths, and build dirs stay consistent
- `ContainerConfigService` should load YAML from `~/.config/swarm/containers/`, validate schema version, preset name, env file path, process definitions, and the single exposed primary process rule
- Model named processes directly (`app`, `worker`, etc.) because the TUI and CLI need something inspectable to show users

Patterns to follow:

- Service construction/injection in `tui/src/index.tsx:23`
- Shared service availability through context in `tui/src/state/AppContext.tsx:21`

Gotchas:

- Env file paths must stay repo-relative; reject arbitrary absolute host paths
- Missing config should fail fast with the exact expected path, not a generic Docker error later

### 3. Implement Docker artifact generation and image lifecycle

Files to create:

- `tui/src/services/DockerArtifactService.ts`
- `tui/src/services/ContainerBuildService.ts`
- `tui/src/services/DependencyFingerprintService.ts`

Guidance:

- Generate all derived Dockerfiles, entrypoint scripts, and process scripts under `~/.config/swarm/containers/.build/<repo-identity>/`
- Split image handling into two layers: repo base image and dependency-variant image keyed by lockfile/manifests; the fingerprint service should inspect the files relevant to the selected preset
- Keep build policy explicit: auto-build only when no usable image exists; warn on manifest drift when an image exists but fingerprints differ

Patterns to follow:

- Command/service separation in `tui/src/commands/RefreshCommand.ts:13`
- Error-to-user message flow in `tui/src/commands/Command.ts:10`

Gotchas:

- Different worktrees of the same repo may need different dependency images even if they share the same base image
- Generated artifacts should be inspectable for debugging, not temporary-only
- Keep Docker command construction in services so it is unit-testable without running Docker in every test

### 4. Implement runtime lifecycle and delete cleanup

Files to create:

- `tui/src/services/ContainerRuntimeService.ts`
- `tui/src/services/PortAllocatorService.ts`
- `tui/src/commands/StartContainerCommand.ts`
- `tui/src/commands/StopContainerCommand.ts`
- `tui/src/commands/BuildContainerImageCommand.ts`
- `tui/src/commands/ContainerStatusCommand.ts`

Files to modify:

- `tui/src/commands/DeleteWorktreeCommand.ts`
- `tui/src/services/WorktreeService.ts`

Guidance:

- `ContainerRuntimeService` should own Docker resource naming, `docker run`/`docker stop`/`docker rm`, network creation, volume creation, log inspection, and health/status lookup
- `PortAllocatorService` should allocate from the configured host range and persist the chosen primary host port in worktree state so URLs stay stable across restarts
- Update `DeleteWorktreeCommand` so container teardown happens before state removal; follow the current cleanup sequencing style in `tui/src/commands/DeleteWorktreeCommand.ts:25`
- Preserve per-worktree data volumes on stop, but remove them during delete flow

Patterns to follow:

- Worktree lifecycle orchestration in `tui/src/services/WorktreeService.ts:31`
- Best-effort cleanup behavior in `tui/src/commands/DeleteWorktreeCommand.ts:27`

Gotchas:

- If startup fails, keep the container and volumes so logs remain available
- Host port exhaustion must surface a specific error with recovery guidance
- Docker daemon unavailability must not corrupt persisted state or partially write container metadata

### 5. Integrate the TUI flow

Files to modify:

- `tui/src/App.tsx`
- `tui/src/hooks/useKeyboardShortcuts.ts`
- `tui/src/components/HelpDialog.tsx`
- `tui/src/components/StatusBar.tsx`
- `tui/src/components/DetailView.tsx`
- `tui/src/components/WorktreeList.tsx`
- `tui/src/state/actions.ts`
- `tui/src/state/appReducer.ts`
- `tui/src/commands/CreateWorktreeCommand.ts`

Guidance:

- Add new command callbacks in `tui/src/App.tsx:101` the same way refresh/delete/open are currently wired
- Add keyboard handlers in `tui/src/hooks/useKeyboardShortcuts.ts:43`; ensure dialog/input modes still short-circuit global shortcuts
- `N` should create a worktree and then immediately start its environment; keep this as a dedicated command or a small orchestration command rather than inlining the sequence in the component
- Show stable container facts in `tui/src/components/DetailView.tsx:20`: host URL/port, image tags, container name, runtime status, and warning state
- Update the status bar and help overlay so discoverability matches the new shortcuts

Patterns to follow:

- Handler + command + reducer flow in `tui/src/App.tsx:115`
- Shortcut documentation style in `tui/src/components/HelpDialog.tsx:13`
- Context-sensitive hints in `tui/src/components/StatusBar.tsx:70`

Gotchas:

- Avoid overloading `Enter`; keep existing open/select behavior intact
- Do not block refresh/open/delete just because a worktree lacks container config; container support should be additive

### 6. Add directory-local CLI commands

Files to create or modify:

- `tui/src/index.tsx`
- New modules under `tui/src/cli/` such as `ContainerCli.ts`, `parseArgs.ts`, `resolveContextFromCwd.ts`

Guidance:

- The current TypeScript app launches the TUI directly from `tui/src/index.tsx:23`; introduce a thin mode switch so no-args starts the TUI, while `container` subcommands dispatch to CLI handlers
- Reuse the same services used by the TUI so build/start/stop behavior stays identical
- `resolveContextFromCwd` should identify the base repo and selected worktree from the current directory and then call the same runtime service APIs

Patterns to follow:

- Centralized service initialization in `tui/src/index.tsx:23`
- Repo/worktree data access through existing services instead of ad-hoc filesystem logic

Gotchas:

- This codebase does not yet have a TypeScript CLI command layer, so keep the first version minimal and testable
- Ensure errors are readable in non-TUI mode; return concise messages and non-zero exit codes

### 7. Testing and validation coverage

Files to create/update:

- `tui/src/__tests__/services/ContainerConfigService.test.ts`
- `tui/src/__tests__/services/ContainerBuildService.test.ts`
- `tui/src/__tests__/services/ContainerRuntimeService.test.ts`
- `tui/src/__tests__/services/PortAllocatorService.test.ts`
- `tui/src/__tests__/state/appReducer.test.ts`
- `tui/src/__tests__/components/HelpDialog.test.tsx` or update existing component tests

Guidance:

- Mock Docker shell execution at the service boundary; verify constructed commands, generated paths, and state mutations
- Add reducer tests for new actions such as container status updates or dialog states
- Add component tests verifying shortcut text and detail rendering when container metadata exists

Patterns to follow:

- Reducer assertions in `tui/src/__tests__/state/appReducer.test.ts:37`
- Existing component test style in `tui/src/__tests__/components/RepoList.test.tsx`

Gotchas:

- Keep Docker integration tests optional/manual unless the test environment guarantees Docker availability
- Include negative tests: missing config, stale image warning, exhausted port range, startup failure, and delete-with-container cleanup

## Testing Strategy

### Unit and integration tests

- Add service tests for repo identity hashing, YAML config validation, env file path validation, dependency fingerprinting, port allocation, Docker resource naming, and cleanup sequencing
- Add command tests for start/stop/build/create+start/delete-with-container flows
- Update reducer tests for new state transitions and dialog states
- Update component tests for help text, status bar hints, and detail view rendering of container metadata

### Manual testing steps

1. Create a repo container config in `~/.config/swarm/containers/` for a test repo using one preset and one exposed `app` process
2. Launch the TUI with `cd tui && bun run start`
3. Select a repo, create a worktree, and press `s`; confirm the image auto-builds only if missing and the worktree gets a stable host port
4. Press `x`; confirm the container stops but data volumes remain
5. Start the same worktree again; confirm the same host port is reused
6. Use `N`; confirm worktree creation and environment start happen as one action
7. Use `i`; confirm repo image build/rebuild works from the selected repo context
8. Delete a started worktree; confirm the dialog warns that container resources and per-worktree data will also be removed
9. Run `swarm container up`, `swarm container down`, `swarm container status`, and `swarm container logs` from inside the worktree directory
10. Change a dependency manifest to force fingerprint drift; confirm Swarm warns instead of silently rebuilding an existing image
11. Simulate a bad setup command; confirm the failed environment remains available for logs/debugging

### End-to-end verification

- Verify two worktrees of the same repo can run simultaneously without shared ports, volumes, networks, or container names
- Verify only the primary app endpoint is exposed to the host; postgres/redis remain internal by default
- Verify deleting a worktree removes its Docker resources and leaves no stale state entry

### Project commands

- Install deps: `cd tui && bun install`
- Run tests: `cd tui && bun test`
- Lint: `cd tui && bun run lint`
- Type check: `cd tui && bun run typecheck`
- Build: `cd tui && bun run build`

`/rspec-test-agent` is not applicable here because this repository is TypeScript/Bun, not Ruby/Rails.

## Definition of Done

- [ ] All subtasks completed
- [ ] Tests passing with `cd tui && bun test`
- [ ] Code follows project conventions
- [ ] No linter or type offenses
- [ ] Type check passes with `cd tui && bun run typecheck`
- [ ] Lint passes with `cd tui && bun run lint`
- [ ] Build passes with `cd tui && bun run build`
- [ ] Per-worktree environments are isolated across container, network, volume, and host port
- [ ] TUI shortcuts `s`, `x`, `N`, and `i` work and are documented in the help UI
- [ ] Directory-local `swarm container ...` commands work from a worktree directory
