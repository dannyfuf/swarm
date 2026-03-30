# Design Decisions: Docker Worktree Containers
Generated: 2026-03-26

## Original Task
> I need to dockerize my dev environment to support isolated parallel work across git worktrees.
> Each worktree gets its own Docker Compose stack with the app and all its dependencies (DB, cache, etc.) fully isolated. No two worktrees should ever share state, ports, networks, or volumes. The worktree directory is bind-mounted into the container so changes from the host are reflected immediately.
> Neovim and AI coding agents run on the host and edit files directly - they never run inside containers.
> Provide scripts to spin up and tear down a worktree's stack from within its directory.
>
> we need to integrate this to the swarm flow. I want to be able to spin up the containers from the TUI after creating a worktree. I mean i select a repo, i create a new worktree, then i select the worktree i just created and use a keybind to spin up the container. I also want a new keybind to create a worktree and automatically create the container too.
>
> the ports always should be internal of the container, for example if i have a rails app that uses a postgres db. It should expose the app port to be able to check what is going on but the postgres port its not needed to be accessible from the host. Almost no service but the main app need to expose the port to the host.
>
> for the images, we should minimize the build time. So im thinking we should mount all the containers with a common image, like build the image based on the main app and mount a different volume (the actual code) that points to the worktree code. The dependencies should barely change overtime. Idk if this make sense, but i dont want to wait a long time to spin up the environment for my worktree.
>
> I want this to be realy simple to configure, but we have to keep in mind that each project have different needs to start. So we have to design and think really well how we solve this.
>
> this is a draft of what i want, im not actually sure this is good approach. So I need you to analize this, understand the intent behind it and propose an implementation design. not a plan nor actual implementation.

## Refined Requirements
1. **Per-worktree isolated environment**: Each swarm worktree must run inside its own isolated Docker-based dev environment with no shared state, volumes, host ports, or runtime resources across worktrees.
2. **Host-edited code**: The worktree directory on the host must be bind-mounted into the runtime so host-side tools like Neovim and AI agents remain the source of truth for file edits.
3. **Fat-container runtime**: The environment model is one "fat" container per worktree, not a multi-container Compose topology.
4. **Swarm-managed infra**: Common supporting services such as postgres and redis are started inside the fat container by swarm-managed runtime logic rather than being fully user-scripted.
5. **Fast reuse of build artifacts**: Swarm should maximize reuse of slow-changing build layers while still handling branches whose dependency lockfiles differ.
6. **Simple global config**: Repo-specific container definitions must live outside the repo in swarm-owned config, use a preset-first schema, and stay simpler than raw Docker Compose.
7. **Named application processes**: Repo config must express app behavior as named processes such as `app` and `worker`, with one primary host-exposed endpoint by default.
8. **Swarm flow integration**: The TUI must support starting a selected worktree environment after creation and a combined create-plus-start action.
9. **Directory-local commands**: Container operations must be invokable from inside a worktree directory through swarm commands that infer repo/worktree context from the current directory.
10. **Minimal host exposure**: Only the primary application endpoint should be exposed to the host by default; backing services stay internal unless explicitly opted in later.
11. **Persistent dev data until worktree deletion**: Stopping an environment should preserve that worktree's DB/cache data, while deleting the worktree should remove its environment and data completely.
12. **Design only**: This document resolves architecture and behavior decisions and intentionally does not prescribe implementation steps.

**Clarifications made:**
- "Docker Compose stack" was interpreted as "one isolated dev environment per worktree" rather than literal multi-container Compose, because you explicitly chose a fat-container model during the decision loop.
- "Provide scripts" was refined to "provide swarm commands that work from inside the worktree directory" because you chose commands over generated per-worktree files.
- "common image" was refined to "shared repo base image plus dependency-keyed variants" so startup stays fast without forcing all branches to share identical dependency layers.
- "really simple to configure" was refined to "preset-first config with targeted overrides" because you wanted strong DX while still accommodating project differences.

## Overview
This feature adds per-worktree containerized dev environments to swarm without changing the host-first editing model. Swarm will own a high-level, preset-driven runtime definition for each repo, build shared images efficiently, and let the TUI and CLI start or stop isolated environments per worktree.

## Scope
**In scope:**
- Per-worktree fat-container runtime model
- Global swarm-owned container config per repo
- Preset-first config with targeted overrides
- Shared repo base image plus dependency variants
- Named processes inside the container
- Stable host port assignment for the primary app process
- TUI actions for start, stop, create-plus-start, and image build
- CLI commands that infer repo/worktree from the current directory
- Per-worktree data persistence and cleanup behavior
- Generated Docker artifacts kept outside repos

**Out of scope:**
- Multi-container Compose orchestration
- Production deployment concerns
- Non-Docker runtimes such as Podman or Kubernetes
- Repo-committed container config
- Broad base-image portability beyond Debian-family images in the first version
- Exposing backing-service ports to the host by default

## Decisions

### 1. Fat Container Per Worktree
**Addresses:** Requirements 1, 3, 4, 10
**Context:** The original request started with "Docker Compose stack" but later emphasized simple UX, fast startup, and running multiple app-related processes in the same environment.
**Options considered:**
- **Multi-container Compose stack**: Separate app, DB, cache, and worker containers per worktree - more standard Docker modeling, but more orchestration and more moving parts in the TUI.
- **Single fat container**: One container runs the app runtime, internal infra, and named app processes - simpler lifecycle, but requires swarm-owned startup orchestration.
- **Hybrid runtime**: Mostly one container, but break out a few services selectively - flexible, but conceptually muddier and harder to explain.

**Decision:** Use one fat container per worktree.
**Rationale:** This matches the chosen mental model: start one environment, stop one environment, keep the TUI simple, and treat the whole worktree as a self-contained dev box. The extra process supervision complexity is worth the cleaner UX.

### 2. Global Swarm-Owned Config With Path-Based Identity
**Addresses:** Requirements 6, 9
**Context:** Config must stay out of repos, but swarm still needs a collision-safe way to map a repo to its container definition even when different repos share the same directory name.
**Options considered:**
- **Repo-committed config**: Easy to version with the project - rejected because you want repos to stay clean.
- **Global file keyed by repo name**: Simple, but collides when two repos share a basename.
- **Global file keyed by repo path fingerprint**: Collision-safe and repo-clean, but less human-friendly unless the filename remains readable.

**Decision:** Store config in `~/.config/swarm/containers/` using a readable-plus-stable key such as `<repo-name>--<path-hash>.yml`, where the hash is derived from the absolute repo path.
**Rationale:** This keeps repos clean, avoids basename collisions, and still gives users a discoverable file naming scheme. Swarm can derive the mapping automatically from the repo path it already tracks.

### 3. Preset-First Config Model
**Addresses:** Requirements 4, 6, 7
**Context:** The central DX tradeoff is whether swarm should model Docker directly or provide a higher-level dev-environment abstraction.
**Options considered:**
- **Stack preset + overrides**: Config starts from named presets and allows focused overrides - strongest guidance and best consistency.
- **Composable features**: More flexible building blocks - powerful, but heavier cognitive load.
- **Generic schema**: One loose config shape - easier to implement, but pushes design complexity back onto the user.

**Decision:** Use stack presets with targeted overrides.
**Rationale:** This keeps the feature opinionated where swarm can genuinely help while still leaving enough room for project-specific commands and extra packages. It is the best fit for "simple to configure" without collapsing into a leaky Compose clone.

### 4. Swarm Owns Common Internal Infra
**Addresses:** Requirements 1, 4, 6
**Context:** In a fat-container model, services like postgres and redis can either be modeled as low-level user-managed commands or as swarm-owned capabilities.
**Options considered:**
- **Swarm-managed presets**: User says what infra is needed, swarm knows how to install and start it.
- **User-declared daemons**: User writes every daemon command and filesystem path - maximum control, but brittle and repetitive.
- **Hybrid**: Swarm has defaults but allows explicit daemon overrides - more flexible, but expands the surface area quickly.

**Decision:** Swarm manages common infra through curated presets, with no low-level daemon templating in the first version.
**Rationale:** The product value is an opinionated dev environment manager, not a shell-script registry. Swarm should absorb recurring postgres/redis startup knowledge so configs stay short and predictable.

### 5. Small Curated Preset Catalog on Debian-Family Images
**Addresses:** Requirements 4, 6
**Context:** Presets only improve DX if they are reliable. Broad support too early would multiply edge cases across package managers and runtime families.
**Options considered:**
- **Small curated preset set**: A few high-confidence presets plus a generic fallback - focused and stable.
- **Broad preset matrix**: Many stacks from day one - more coverage, but much more design and test complexity.
- **One generic preset**: Minimal surface area - simplest, but weak DX and limited value from presets.

**Decision:** Start with a small curated preset catalog on Debian-family base images only, such as `rails`, `node-web`, `python-web`, and a generic fallback preset.
**Rationale:** This gives strong DX in common cases while keeping the runtime model predictable. Debian-family assumptions let swarm own package install and internal service startup consistently.

### 6. Targeted Escape Hatch, Not Template Escape Velocity
**Addresses:** Requirements 4, 6, 7
**Context:** Some repos will not fit a preset exactly, but too much extensibility would turn the design into a harder-to-debug templating system.
**Options considered:**
- **Commands + packages only**: Allow overriding install/setup/process commands and adding OS packages.
- **Entrypoint fragments**: Allow injecting shell into generated runtime scripts - flexible, but messy fast.
- **Full custom template mode**: Let users bypass swarm's structure entirely - maximal flexibility, minimal consistency.

**Decision:** Allow overrides for install/setup/process commands and extra packages only.
**Rationale:** This keeps swarm in control of the runtime contract while still covering the most important per-project differences. It preserves a stable abstraction boundary.

### 7. Named App Processes With One Primary Exposed Endpoint
**Addresses:** Requirements 7, 10
**Context:** The container needs to run multiple app-related processes while preserving a simple host exposure model.
**Options considered:**
- **Named app processes**: Explicit process entries like `app`, `worker`, and `scheduler` - clear and inspectable.
- **Single top-level start command**: One script starts everything - less structure and poor visibility.
- **Preset-inferred processes**: Minimal config, but too magical once projects diverge.

**Decision:** Model runtime behavior as named processes, with exactly one primary process exposed to the host by default.
**Rationale:** Named processes give the TUI and CLI something meaningful to reason about, while the single exposed endpoint preserves the desired default of "only the main app should be reachable from the host."

### 8. Shared Repo Base Image Plus Dependency Variants
**Addresses:** Requirements 1, 5, 6
**Context:** One shared image per repo is fast, but it breaks down when parallel branches diverge in lockfiles or dependency manifests.
**Options considered:**
- **One image per repo**: Fastest mental model, but incorrect when branches need different dependencies.
- **Repo base image plus dependency variants**: Share slow base layers, but cache per-dependency-image variants keyed by manifests.
- **One image per worktree**: Most accurate, but too slow and too close to full per-worktree rebuilds.

**Decision:** Split image identity into a repo-level base image and dependency-keyed derived images.
**Rationale:** This preserves the fast path for most starts while avoiding cross-worktree correctness issues when lockfiles diverge. It is the cleanest compromise between speed and true isolation.

### 9. Build Policy: Auto-Build Missing, Manual Rebuild Existing, Warn on Drift
**Addresses:** Requirements 5, 8, 9
**Context:** The system needs a predictable image lifecycle that is not too magical but still helps when developers forget to rebuild after dependency changes.
**Options considered:**
- **Manual only**: Most explicit, but rougher DX and easy to forget.
- **Manual rebuild with drift warning**: Swarm detects probable staleness and warns, but does not rebuild unless needed or requested.
- **Always auto-rebuild on changes**: Smooth in theory, but can make startup slow and surprising.

**Decision:** If no usable image exists, start triggers a build automatically. If an image exists but manifests appear stale, swarm warns and lets the developer rebuild intentionally.
**Rationale:** First-run success matters, but existing environments should not rebuild unexpectedly. This keeps rebuild cost explicit while still reducing footguns.

### 10. Runtime Env Comes From Repo-Relative Files Plus Small Inline Overrides
**Addresses:** Requirements 2, 6
**Context:** Projects often need environment variables, but storing them globally in swarm would create more hidden state and drift from repo conventions.
**Options considered:**
- **Repo-relative env file plus optional inline vars**: Familiar and easy to reason about.
- **Env file only**: Simpler, but too rigid for small swarm-specific overrides.
- **Global swarm env registry**: Centralized, but adds hidden state and maintenance burden.

**Decision:** Support a repo-relative env file path and a small set of explicit inline vars in the swarm config.
**Rationale:** This respects existing project conventions while allowing minor swarm-owned adjustments without forcing a second secret-management system.

### 11. Stable Auto-Assigned Primary App Ports
**Addresses:** Requirements 1, 8, 10, 11
**Context:** Multiple worktrees of the same repo will often want the same internal app port, but host URLs need to stay conflict-free and reasonably stable.
**Options considered:**
- **Stable auto-assigned range**: Swarm allocates from a configured host range and persists the assignment.
- **Random on every start**: Very simple, but unstable URLs hurt DX.
- **User-defined host ports**: Precise, but painful to manage across many worktrees.

**Decision:** Assign one host port per worktree from a configurable range and persist it in swarm state.
**Rationale:** Developers get predictable URLs while swarm owns conflict management. This matches the "parallel isolated work" goal much better than per-start randomness.

### 12. Strong Per-Worktree Isolation for Data and Networking
**Addresses:** Requirements 1, 11
**Context:** Even with one container, the isolation promise is broader than just the code mount. Data, Docker resource naming, and network boundaries must remain separate.
**Options considered:**
- **Container-only isolation**: Rely on separate containers and host ports alone - simplest, but weakens the "nothing shared" guarantee.
- **Dedicated named Docker resources per worktree**: Separate container name, volume set, and dedicated network per worktree.
- **Mostly shared Docker resources**: Reuse some volumes or networks for convenience - directly conflicts with the requirement.

**Decision:** Create dedicated Docker resources per worktree, including a unique container name, unique named data volumes, and a dedicated network even if only one container is attached to it.
**Rationale:** This makes the isolation story explicit and mechanically enforceable. It also leaves room for future internal helpers without changing the isolation model later.

### 13. Preserve Dev Data on Stop, Destroy It on Worktree Delete
**Addresses:** Requirements 1, 8, 11
**Context:** Developers need continuity across normal starts and stops, but worktree deletion should mean complete cleanup.
**Options considered:**
- **Keep on stop, drop on delete**: Good continuity and predictable cleanup.
- **Always ephemeral**: Simple, but too destructive for normal dev workflows.
- **Always preserved**: Safe, but leaves behind too much stale state.

**Decision:** Stopping an environment preserves its per-worktree data; deleting the worktree removes the container, network, and all per-worktree data volumes.
**Rationale:** This best matches the lifecycle boundary developers care about: pausing work should be cheap, abandoning a branch should fully clean up.

### 14. Failed Startup Leaves the Environment Intact for Debugging
**Addresses:** Requirements 8, 9, 11
**Context:** Setup failures and process crashes are part of dev work. Auto-cleaning everything on failure often destroys the very evidence needed to debug.
**Options considered:**
- **Keep failed container**: Better debugging and postmortem visibility.
- **Auto teardown**: Cleaner cleanup, but worse diagnosis.
- **Repo-configurable policy**: More flexibility, but not worth the extra complexity initially.

**Decision:** When setup or process startup fails, keep the failed environment available for inspection and logs.
**Rationale:** This is a dev tool. Debuggability beats pristine cleanup in failure cases.

### 15. TUI and CLI Contract
**Addresses:** Requirements 8, 9
**Context:** The existing TUI already has worktree-centric commands and keyboard shortcuts, so container operations should extend that model rather than create a separate interaction pattern.
**Options considered:**
- **Worktree-centric start/stop plus repo-centric build**: Mirrors existing selection semantics.
- **Everything from worktree selection only**: Simpler mentally, but image build is conceptually repo-scoped.
- **Separate container screen**: More room, but a worse fit with the current TUI architecture.

**Decision:** Add worktree-scoped `start` and `stop`, repo-scoped `build`, and a combined create-plus-start action. The keybind set is `s` to start the selected worktree environment, `x` to stop it, `N` to create a new worktree and start its environment, and `i` to build or rebuild the selected repo's image.
**Rationale:** This extends the current keyboard model naturally and keeps operations aligned with how the user already thinks about repos vs worktrees.

### 16. Directory-Local Commands, Not Generated Scripts
**Addresses:** Requirements 8, 9
**Context:** You want to invoke lifecycle operations from inside a worktree, but you explicitly chose commands over generated files.
**Options considered:**
- **Generated scripts inside each worktree**: Familiar UX, but adds files and synchronization concerns.
- **Swarm commands with cwd inference**: Clean repos and no generated artifacts.
- **Both**: More convenience, but redundant behavior to maintain.

**Decision:** Use swarm commands such as `swarm container up`, `swarm container down`, `swarm container build`, `swarm container status`, and `swarm container logs`, with repo/worktree inferred from the current directory when possible.
**Rationale:** This satisfies the "run it from there" requirement while keeping worktrees clean and avoiding script drift.

### 17. Delete Flow Owns Environment Cleanup
**Addresses:** Requirements 1, 8, 11
**Context:** The existing worktree delete flow already coordinates tmux cleanup and state removal. Containerized environments add another resource boundary that must not be orphaned.
**Options considered:**
- **Auto-stop and remove on delete confirm**: Smooth and safe.
- **Block deletion until env is manually stopped**: Safer in a narrow sense, but adds friction.
- **Delete worktree only**: Leaves orphaned container resources behind.

**Decision:** When deleting a worktree with an attached environment, swarm shows a confirmation that deletion will also stop the container and remove its per-worktree data.
**Rationale:** Delete should remain the single definitive cleanup boundary for all worktree-owned resources.

### 18. Generated Docker Artifacts Live Under Swarm Config, Not Repos
**Addresses:** Requirements 5, 6, 9
**Context:** Swarm needs generated build context, startup scripts, and cached metadata, but these artifacts should not pollute repos or worktrees.
**Options considered:**
- **Generate in the repo**: Easy to inspect, but violates the clean-repo goal.
- **Generate under swarm config/cache**: Keeps repos clean and centralizes container internals.
- **Generate in temp dirs only**: Minimal residue, but poor debuggability and worse cache reuse.

**Decision:** Keep generated Dockerfiles, entrypoint/process scripts, and cache metadata under a swarm-owned build area beneath `~/.config/swarm/containers/.build/` keyed by the same repo identity.
**Rationale:** This keeps the abstraction clean: users configure swarm, but swarm owns the Docker plumbing it derives from that config.

## Patterns to Follow
- **Worktree-centric command orchestration**: Follow `tui/src/App.tsx` for how UI actions dispatch commands and refresh state after completion.
- **Lifecycle command encapsulation**: Follow `tui/src/commands/DeleteWorktreeCommand.ts` for resource cleanup wrapped in a single command object.
- **Global keybinding registration**: Follow `tui/src/hooks/useKeyboardShortcuts.ts` for adding new shortcuts without bypassing dialog/input handling.
- **Persistent worktree metadata**: Follow `tui/src/types/state.ts` and extend worktree state with stable container metadata rather than live status.
- **Config surface expansion**: Follow `tui/src/types/config.ts` for app-level config additions such as host port range defaults.
- **Shortcut discoverability**: Follow `tui/src/components/HelpDialog.tsx` so new lifecycle actions are reflected in the help overlay.

## Data Model Changes
Swarm state should persist stable container metadata per worktree, while live runtime status should be queried from Docker to avoid stale state.

```ts
interface WorktreeState {
  slug: string
  branch: string
  path: string
  createdAt: Date
  lastOpenedAt: Date
  tmuxSession: string
  container?: {
    primaryHostPort: number
    containerName: string
    networkName: string
    dataVolumeNames: string[]
    baseImageTag: string
    dependencyImageTag: string
    dependencyFingerprint: string
  }
}

interface Config {
  aiWorkingDir: string
  defaultBaseBranch: string
  worktreePattern: WorktreePattern
  createSessionOnCreate: boolean
  tmuxLayoutScript: string
  statusCacheTTL: number
  preferFzf: boolean
  autoPruneOnRemove: boolean
  containerPortRangeStart: number
  containerPortRangeEnd: number
}
```

Global repo container config shape:

```yaml
schema_version: 1
repo_path: /absolute/path/to/repo
preset: rails

runtime:
  base_image: ruby:3.3-slim
  packages:
    - libpq-dev
    - imagemagick

env:
  file: .env.development
  vars:
    RAILS_ENV: development

build:
  install: bundle install

setup:
  command: bin/rails db:prepare

processes:
  app:
    command: bin/rails server -b 0.0.0.0 -p 3000
    expose: true
    internal_port: 3000
  worker:
    command: bundle exec sidekiq
```

## Security Considerations
- Only the designated primary app process is host-exposed by default; postgres, redis, and other internal services remain inaccessible from the host.
- Env files must be repo-relative so swarm does not become a general-purpose host file reader for arbitrary paths.
- Container commands are user-authored project commands and should be treated as trusted local development code, not sandboxed workloads.
- Per-worktree named resources prevent accidental cross-branch data leakage through shared Docker volumes or shared service ports.

## Edge Cases and Error Handling
| Scenario | Expected Behavior |
|----------|-------------------|
| No container config exists for the selected repo | Start/build actions fail with a clear message showing the expected config location under `~/.config/swarm/containers/`. |
| Docker daemon is unavailable | Swarm reports a non-fatal error and does not mutate persisted container metadata. |
| First start for a repo with no built image | Swarm automatically builds the needed image before launching the worktree environment. |
| Dependency manifests changed since the cached dependency image was built | Swarm warns that the dependency image is stale and recommends `swarm container build` or the `i` keybind before continuing. |
| Two worktrees of the same repo have different lockfiles | Swarm assigns different dependency image variants keyed by dependency fingerprint while reusing the same repo base image layers. |
| Host port range is exhausted | Start fails with a clear message instructing the user to stop/delete environments or widen the configured range. |
| Setup command fails | Swarm leaves the environment intact, surfaces the failure, and does not mark the worktree as successfully started. |
| A named app process crashes after startup | Swarm reports the environment as unhealthy/stopped and preserves logs and runtime artifacts for inspection. |
| Worktree delete is requested while its environment exists | The delete confirmation explicitly states that the container and per-worktree data will also be removed. |
| Repo path changes on disk | The old path-hash config no longer matches; swarm should surface the mismatch and require re-registering or regenerating the repo config identity. |
| Multiple repos share the same basename | Path-hash identity prevents config collisions and resource naming ambiguity. |

## Risks and Assumptions
**Assumptions:**
- Docker is installed locally and accessible without extra interactive setup during swarm operations.
- The first release can target Debian-family package management inside base images.
- Common stacks can be expressed well enough through a small curated preset catalog plus command/package overrides.
- Projects keep runtime env files inside the repo or worktree path.

**Risks:**
- **macOS bind-mount performance**: Large repos may feel slow inside Docker on macOS; this is a platform constraint, not purely a swarm design issue.
- **Variant image buildup**: Dependency-keyed images can accumulate over time; swarm will eventually need a prune story for unused variants.
- **Preset coverage gaps**: Some projects may sit awkwardly between presets; the curated catalog must stay intentionally small and high-quality.
- **Repo relocation friction**: Path-based identity is correct for uniqueness, but moving a repo means the config identity must be refreshed.

## Open Questions
None.

## Migration / Rollout Strategy
This feature is additive. Existing swarm worktree workflows continue to work unchanged for repos without a container config. State changes are backward-compatible by adding optional container metadata, and no repo-side migration is required because configs and generated artifacts live entirely under swarm-managed directories.

---
*This document is the input for `/create-plan`. All decisions here should be treated as resolved constraints during planning.*
