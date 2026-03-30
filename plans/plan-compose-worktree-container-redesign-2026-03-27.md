# Implementation Plan: Compose-Based Worktree Container Redesign
Generated: 2026-03-27

## Summary

Redesign Swarm's container support so each worktree runs from a repo-level Docker Compose template stored under `~/.config/swarm/containers/<repo>/`, instead of the current fat-container + generated Dockerfile approach. The new design should let Swarm take a base repo dockerization, rewrite it for a selected worktree, run `docker compose up -d` with an isolated Compose project per worktree, and ensure host-side editing in Neovim or AI agents immediately updates the matching container through worktree bind mounts.

### Context and scope

Current implementation already includes container support, but it is built around repo-scoped YAML config files plus `docker build`/`docker run` orchestration:

- `tui/src/services/ContainerConfigService.ts`
- `tui/src/services/ContainerBuildService.ts`
- `tui/src/services/DockerArtifactService.ts`
- `tui/src/services/ContainerRuntimeService.ts`
- `tui/src/services/RepoIdentityService.ts`
- `tui/src/services/PortAllocatorService.ts`
- `tui/src/types/container.ts`
- `tui/src/commands/StartContainerCommand.ts`
- `tui/src/commands/StopContainerCommand.ts`
- `tui/src/commands/EnsureContainerConfigCommand.ts`
- `tui/src/commands/DeleteWorktreeCommand.ts`
- `tui/src/cli/ContainerCli.ts`
- `tui/src/cli/parseArgs.ts`
- `tui/src/cli/resolveContextFromCwd.ts`
- `tui/src/App.tsx`
- `tui/src/components/DetailView.tsx`
- `tui/src/components/HelpDialog.tsx`
- `tui/src/components/StatusBar.tsx`
- `tui/src/components/WorktreeList.tsx`
- `tui/src/hooks/useKeyboardShortcuts.ts`
- `README.md`
- `tui/src/__tests__/services/ContainerConfigService.test.ts`
- `tui/src/__tests__/services/ContainerBuildService.test.ts`
- `tui/src/__tests__/services/ContainerRuntimeService.test.ts`
- `tui/src/__tests__/commands/StartContainerCommand.test.ts`
- `tui/src/__tests__/services/PortAllocatorService.test.ts`

Reference dockerization to support:

- `~/.config/swarm/containers/buk-webapp/docker-compose.yml`
- `~/.config/swarm/containers/buk-webapp/Dockerfile`
- `~/.config/swarm/containers/buk-webapp/entrypoint.sh`
- `~/.config/swarm/containers/buk-webapp/.env`

In scope:

- Replace repo-level hashed YAML config discovery with repo-directory dockerization discovery at `~/.config/swarm/containers/<repo>/`
- Generate worktree-specific Compose overlays/env files under Swarm-owned build state
- Rewrite base-repo bind mounts and build contexts so each worktree container points at the selected worktree path
- Use unique Compose project names per worktree to isolate containers, networks, and named volumes
- Allocate stable host ports per worktree for every published port Swarm needs to override
- Rework TUI and CLI container flows to call `docker compose`, not `docker run`
- Preserve host-first editing: the worktree directory remains the source of truth for code changes
- Make delete flow run full Compose cleanup before removing the git worktree

Out of scope:

- Supporting non-Docker runtimes such as Podman
- Full generic Compose transformation for every possible Compose feature from day one
- Secret management beyond using files already present in the dockerization directory
- Auto-generating the repo dockerization itself
- Handling multiple repos with the same basename in different roots if that conflicts with the required `~/.config/swarm/containers/<repo>/` convention

## Prerequisites

### Environment

- Bun installed; run `cd tui && bun install`
- Docker Engine or Docker Desktop with Compose v2 available via `docker compose version`
- Git and tmux installed
- Access to `~/.config/swarm/containers/` and `~/.config/swarm/containers/.build/`
- A real repo dockerization directory to test against, such as `~/.config/swarm/containers/buk-webapp`

### Project structure knowledge

- `tui/src/index.tsx` wires all services once and is the single entry point for both TUI and CLI modes
- `tui/src/App.tsx` owns command dispatch and post-command refresh behavior
- `tui/src/commands/CreateWorktreeCommand.ts` is the pattern for atomic command objects returning `CommandResult`
- `tui/src/commands/DeleteWorktreeCommand.ts` shows the existing cleanup sequencing for tmux + worktree removal
- `tui/src/services/WorktreeService.ts` is the source of truth for worktree creation, listing, and persisted metadata
- `tui/src/cli/resolveContextFromCwd.ts` already resolves repo/worktree context for directory-local commands
- `tui/src/__tests__/services/ContainerRuntimeService.test.ts` shows the preferred pattern for mocking shell calls instead of running Docker in unit tests

### Conventions to follow

- Keep shell/process orchestration inside service classes, not UI components
- Keep UI actions encapsulated in command classes returning `CommandResult`
- Continue service injection through `tui/src/state/AppContext.tsx`
- Prefer persistent metadata in state and live runtime inspection from Docker/Compose
- Keep generated artifacts outside repos under `~/.config/swarm/containers/.build/`
- Follow existing Bun + TypeScript + Biome conventions in `tui/package.json`

### Background reading

- `README.md`
- `plans/plan-docker-worktree-containers-2026-03-26.md` to understand the current fat-container direction that is being replaced
- `plans/decisions-docker-worktree-containers-2026-03-26.md` to identify which prior decisions remain valid (worktree isolation, TUI/CLI integration) and which must be superseded (fat-container runtime, custom build pipeline)
- Docker Compose docs for `docker compose up`, `down`, `build`, `ps`, `logs`, `config`, project names, bind mounts, and named volumes

## Task Breakdown

1. Define the replacement container model and identify the code to retire
   - Depends on: none
   - Complexity: Medium
   - Acceptance criteria: there is a short design note in the implementation PR or plan comments that explicitly says the old per-repo YAML config, generated Dockerfiles, and `docker run` lifecycle are being replaced by Compose-directory discovery plus generated worktree overlays

2. Redesign the container domain types and persisted state for Compose projects
   - Depends on: #1
   - Complexity: High
   - Acceptance criteria: `tui/src/types/container.ts`, `tui/src/types/worktree.ts`, and `tui/src/types/state.ts` represent repo dockerization directories, worktree-specific Compose metadata, and stable published-port mappings without depending on fat-container-only fields such as base/dependency image tags

3. Implement repo dockerization discovery and validation
   - Depends on: #2
   - Complexity: High
   - Acceptance criteria: Swarm can resolve `~/.config/swarm/containers/<repo>/`, verify required files such as `docker-compose.yml` exist, detect optional `.env`, and surface actionable validation errors before any runtime command is attempted

4. Implement worktree Compose plan generation
   - Depends on: #3
   - Complexity: High
   - Acceptance criteria: given a repo, base repo path, and worktree path, Swarm can generate a worktree-specific Compose overlay/env bundle under `~/.config/swarm/containers/.build/...` that rewrites base-repo bind mounts/build contexts to the worktree path and injects unique project name and port overrides

5. Replace runtime/build/status/log operations with `docker compose`
   - Depends on: #4
   - Complexity: High
   - Acceptance criteria: start/build/stop/status/logs/delete cleanup run through `docker compose`; Compose resources are isolated per worktree; restart uses the same stored project metadata; and failures do not corrupt persisted state

6. Update TUI flows and directory-local CLI flows
   - Depends on: #5
   - Complexity: Medium
   - Acceptance criteria: `s`, `x`, `N`, `i`, inspect/status, and `swarm container ...` all operate against the new Compose workflow with updated help text, detail view, and user-facing messages

7. Add regression coverage and end-to-end validation
   - Depends on: #6
   - Complexity: Medium
   - Acceptance criteria: unit tests cover compose discovery, path rewriting, port allocation, and compose command construction; manual validation passes against a real dockerization directory and two parallel worktrees of the same repo

## Implementation Details

### 1. Define the replacement model and retirement boundaries

Files to modify:

- `tui/src/types/container.ts`
- `tui/src/services/ContainerConfigService.ts`
- `tui/src/services/ContainerBuildService.ts`
- `tui/src/services/DockerArtifactService.ts`
- `tui/src/services/ContainerRuntimeService.ts`
- `README.md`

Guidance:

- Treat `~/.config/swarm/containers/<repo>/` as the source dockerization directory for a repo. For `buk-webapp`, that means the Compose file, Dockerfile, entrypoint script, and `.env` live together in one directory.
- Replace the current `ContainerConfigService.getExpectedConfigPath()` mental model with a repo-directory resolver such as `getDockerizationDir(repoName)` and `getComposeFilePath(repoName)`.
- Plan to remove or heavily repurpose `ContainerBuildService` and `DockerArtifactService`; the current code builds images from generated Dockerfiles, but the new approach should defer image building to `docker compose build` using the repo-provided Compose definition.
- Keep the useful parts of the existing architecture: command objects, service injection, persisted stable metadata, and directory-local CLI entry points.

Patterns to follow:

- `tui/src/commands/CreateWorktreeCommand.ts` for command boundaries
- `tui/src/index.tsx` for service construction
- `tui/src/commands/DeleteWorktreeCommand.ts` for cleanup ordering

Gotchas:

- Do not try to preserve both models in parallel longer than necessary; mixed `docker run` and `docker compose` semantics will make state, status, and cleanup hard to reason about.
- Update user-facing terminology from "container config file" to "repo dockerization directory" where appropriate.

### 2. Redesign domain types and persisted state

Files to modify:

- `tui/src/types/container.ts`
- `tui/src/types/worktree.ts`
- `tui/src/types/state.ts`
- `tui/src/services/WorktreeService.ts`
- `tui/src/services/StateService.ts`

Recommended type changes:

- Replace `ContainerConfigSummary` with a summary that reflects directory-based dockerization, for example:
  - `state: "missing" | "present" | "invalid"`
  - `dockerizationDir`
  - `composeFilePath`
  - `envFilePath`
  - `error`
- Replace `WorktreeContainerMetadata` with Compose-oriented metadata, for example:
  - `projectName`
  - `dockerizationDir`
  - `composeFiles: string[]`
  - `generatedOverridePath`
  - `generatedEnvPath`
  - `publishedPorts: Record<string, number>`
  - `primaryService`
  - `primaryUrl`
- Keep metadata stable and persisted; runtime status should still be queried live.

Patterns to follow:

- `tui/src/types/state.ts` for persisted state shape
- `tui/src/services/WorktreeService.ts` for how worktree metadata is written back through state

Gotchas:

- The sample Compose file exposes both `APP_PORT` and `WEBPACK_PORT`; a single `primaryHostPort` field is no longer sufficient.
- Preserve backward compatibility when older state files contain fat-container metadata; add a migration or defensive parse path instead of crashing on load.

### 3. Implement repo dockerization discovery and validation

Files to modify or create:

- `tui/src/services/ContainerConfigService.ts`
- `tui/src/services/RepoIdentityService.ts`
- optionally new `tui/src/services/ComposeValidationService.ts`
- `tui/src/commands/EnsureContainerConfigCommand.ts`

Guidance:

- Resolve dockerization directories by repo name under `~/.config/swarm/containers/<repo>/`; this supersedes the current hashed filename convention in `ContainerConfigService`.
- Validate at least these conditions before any Compose command runs:
  - directory exists
  - `docker-compose.yml` exists (optionally also accept `compose.yml` / `compose.yaml` if you want a small quality-of-life improvement)
  - the Compose file can be parsed or `docker compose config` can validate it
  - bind mounts/build contexts that point at the base repo can be identified and rewritten for the worktree
  - published host ports are either parameterized or overridable by Swarm
- `EnsureContainerConfigCommand` should no longer generate a starter YAML file. It should instead give the user the expected directory path and optionally scaffold a minimal directory layout only if that remains useful.

Code patterns/examples to follow:

- `tui/src/services/ContainerConfigService.ts` already has clear summary-loading APIs; keep that API shape but change the underlying contract
- `tui/src/__tests__/services/ContainerConfigService.test.ts` is the right place to rewrite expectations around discovery and validation

Gotchas:

- Relative paths in Compose are resolved from the Compose file directory, not from the repo root. Validation must account for that.
- The provided example mounts `~/.config/swarm/containers/buk-webapp/entrypoint.sh` into the container; that path should remain untouched while repo-path mounts get rewritten.

### 4. Implement worktree Compose plan generation

Files to modify or create:

- replace or repurpose `tui/src/services/DockerArtifactService.ts`
- replace or repurpose `tui/src/services/ContainerBuildService.ts`
- `tui/src/services/PortAllocatorService.ts`
- new service such as `tui/src/services/ComposePlanService.ts`

Guidance:

- Generate a worktree-scoped build directory such as `~/.config/swarm/containers/.build/<repo>/<worktree-slug>/`.
- Generate files Swarm owns for each worktree, for example:
  - `docker-compose.override.yml`
  - `.env.worktree`
  - `compose-plan.json` for debugging/status
- Use the base repo path (`repo.path`) as the path to search for in the source Compose config; when that path appears in a bind mount or build context, rewrite it to the selected worktree path.
- Prefer a deterministic Compose project name such as `swarm-<repo>-<worktree-slug>` so Compose automatically namespaces containers, networks, and named volumes.
- Expand `PortAllocatorService` to allocate all host ports Swarm must override, not just one primary port. Store the mapping in worktree metadata so URLs stay stable between restarts.
- Support the sample dockerization pattern where ports are parameterized through env vars like `APP_PORT` and `WEBPACK_PORT`. Generate the worktree `.env` file so those values are unique per worktree.

Patterns to follow:

- `tui/src/services/PortAllocatorService.ts` for persisted stable port allocation behavior
- `tui/src/__tests__/services/ContainerRuntimeService.test.ts` for asserting constructed shell arguments

Gotchas:

- Named volumes and networks are only isolated automatically if the Compose file does not hardcode `name:` overrides. Detect explicit names and either rewrite them in the generated override or reject them with a clear error.
- If a volume mount targets a subpath of the base repo, preserve the same relative suffix when remapping to the worktree.
- If the Compose file contains static numeric host ports with no env indirection, decide whether Swarm will rewrite them in the generated override or fail fast with guidance; document the chosen rule explicitly.

### 5. Replace runtime/build/status/log operations with Compose

Files to modify:

- `tui/src/services/ContainerRuntimeService.ts`
- `tui/src/commands/StartContainerCommand.ts`
- `tui/src/commands/StopContainerCommand.ts`
- `tui/src/commands/BuildContainerImageCommand.ts`
- `tui/src/commands/ContainerStatusCommand.ts`
- `tui/src/commands/DeleteWorktreeCommand.ts`
- `tui/src/cli/ContainerCli.ts`
- `tui/src/cli/parseArgs.ts`

Guidance:

- `ContainerRuntimeService` should become a thin wrapper around Compose plan resolution plus `docker compose` commands, for example:
  - build: `docker compose -f <base> -f <override> --project-name <name> build`
  - up: `docker compose ... up -d`
  - down: `docker compose ... down`
  - delete cleanup: `docker compose ... down -v --remove-orphans`
  - status: `docker compose ... ps --format json` if available, otherwise inspect via Docker labels/project name
  - logs: `docker compose ... logs --tail <n>`
- Persist worktree metadata only after Swarm successfully generates the plan and either confirms the Compose project exists or the command completes successfully.
- On start failure, keep generated overlay files for debugging and avoid wiping Compose resources unless the failure happened before any project was created.

Patterns to follow:

- `tui/src/commands/StartContainerCommand.ts` for missing-config handling and user messaging
- `tui/src/commands/DeleteWorktreeCommand.ts` for doing environment cleanup before state/worktree removal

Gotchas:

- `docker compose down` should preserve named volumes on normal stop if you want stop/start continuity; only deletion should use `-v`.
- `docker compose up -d` may build images implicitly if the user requests `--build`; keep build semantics explicit and consistent with the `i` action.
- `status` and `logs` must work when run from inside nested directories within a worktree via `resolveContextFromCwd`.

### 6. Update TUI and CLI flows

Files to modify:

- `tui/src/App.tsx`
- `tui/src/components/DetailView.tsx`
- `tui/src/components/HelpDialog.tsx`
- `tui/src/components/StatusBar.tsx`
- `tui/src/components/WorktreeList.tsx`
- `tui/src/hooks/useKeyboardShortcuts.ts`
- `tui/src/index.tsx`
- `tui/src/state/AppContext.tsx`
- `tui/src/cli/resolveContextFromCwd.ts`

Guidance:

- Keep the existing keyboard contract unless product decisions change: `s` start, `x` stop, `N` create + start, `i` build, `v` inspect/status.
- Update the detail view to show Compose-specific metadata instead of image tags and container names from the fat-container model. Useful fields are project name, compose files, published ports, primary URL, and service states.
- Update config summary messaging everywhere to talk about the dockerization directory, not a generated YAML config file.
- Keep CLI and TUI on the same service APIs; only the presentation layer should differ.

Code patterns/examples to follow:

- `tui/src/App.tsx` for command dispatch + refresh
- `tui/src/components/DetailView.tsx` for how selected-worktree details are rendered
- `tui/src/cli/ContainerCli.ts` for directory-local command routing

Gotchas:

- Refresh should not require the selected worktree to be running; missing or stopped Compose projects should still produce a meaningful status row.
- Make sure `CreateAndStartWorktreeCommand` uses the selected repo's dockerization directory but rewrites paths to the new worktree before starting Compose.

### 7. Add tests, docs, and manual validation

Files to modify:

- `tui/src/__tests__/services/ContainerConfigService.test.ts`
- `tui/src/__tests__/services/ContainerRuntimeService.test.ts`
- `tui/src/__tests__/services/PortAllocatorService.test.ts`
- `tui/src/__tests__/services/ContainerBuildService.test.ts` or its replacement
- `tui/src/__tests__/commands/StartContainerCommand.test.ts`
- `tui/src/__tests__/commands/DeleteWorktreeCommand.test.ts`
- `tui/src/__tests__/components/WorktreeList.test.tsx`
- `README.md`

Unit tests to add or update:

- dockerization directory resolution by repo name
- validation of missing directory / missing Compose file / invalid Compose file
- path rewriting for build contexts and bind mounts that target the base repo
- preservation of non-repo mounts such as config-dir entrypoints
- project-name generation and metadata persistence
- multi-port allocation and reuse for the same worktree
- `docker compose` argument construction for build/up/down/logs/status/delete
- delete flow using `down -v --remove-orphans`

Manual testing steps:

- Create two worktrees for the same repo from the TUI.
- Start the first worktree container with `s`; verify `docker compose ps` shows a unique project name and the app serves on its assigned host port.
- Start the second worktree container; verify it gets different containers/networks/volumes and no host-port collisions.
- Edit a file in the first worktree from the host with Neovim; verify the change is visible inside the corresponding container bind mount and not in the second worktree.
- Run `bun run start -- container status` and `bun run start -- container logs` from inside each worktree directory; verify context inference selects the correct Compose project.
- Stop one environment with `x`; verify containers stop but worktree data volumes persist.
- Delete the worktree with `d`; verify Swarm runs Compose teardown with volume removal before deleting the git worktree.

Project verification commands:

- `cd tui && bun test`
- `cd tui && bun run lint`
- `cd tui && bun run typecheck`
- `cd tui && bun run build`

## Testing Strategy

- Automated: prefer unit tests with mocked shell runners for Compose command construction and parser/rewriter behavior; avoid requiring live Docker in the core test suite
- Integration: run at least one real manual flow against `~/.config/swarm/containers/buk-webapp` and two parallel worktrees of the same repo
- End-to-end: validate TUI create/start/stop/delete flow plus directory-local CLI flow from within a worktree
- Regression focus: existing fat-container tests should be rewritten, not merely extended, so they assert Compose behavior rather than `docker run` behavior
- Type/lint gates for this TypeScript+Bun project:
  - Lint: `cd tui && bun run lint`
  - Type check: `cd tui && bun run typecheck`
  - Tests: `cd tui && bun test`

## Definition of Done

- [ ] All subtasks completed
- [ ] Tests passing
- [ ] Code follows project conventions
- [ ] No linter or type offenses
- [ ] Swarm discovers repo dockerization from `~/.config/swarm/containers/<repo>/`
- [ ] Swarm generates worktree-specific Compose overlays under `~/.config/swarm/containers/.build/`
- [ ] Each worktree uses a unique Compose project name, isolated containers/networks/volumes, and non-conflicting host ports
- [ ] Host edits in a worktree are reflected in the correct running container through bind mounts
- [ ] TUI and `swarm container ...` commands both use the same Compose-backed runtime implementation
- [ ] `cd tui && bun run lint` succeeds
- [ ] `cd tui && bun run typecheck` succeeds
- [ ] `cd tui && bun test` succeeds
- [ ] `cd tui && bun run build` succeeds
