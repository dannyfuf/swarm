# Swarm - Git Worktree + Tmux Session Manager

> Seamless parallel development with Git worktrees and dedicated tmux sessions

Swarm manages Git worktrees with dedicated tmux sessions, designed for workflows that require multiple parallel branches within the `amplifier/ai_working/` directory structure.

## Quick Start

```bash
# Build
make install

# Create a new worktree
swarm create fintoc-rails feature/payments-refactor --from main

# Open in tmux session
swarm open fintoc-rails feature/payments-refactor

# List all worktrees
swarm list --all

# Remove when done
swarm remove fintoc-rails feature/payments-refactor
```

## Features

✨ **Core Features:**
- 🌳 Git worktree lifecycle management (create, list, remove, prune)
- 💻 Automatic tmux session creation and attachment
- 🔍 Repository discovery across `ai_working/`
- 🛡️ Safety checks before removal (uncommitted changes, unpushed commits)
- 💾 State persistence with reconciliation
- ⚙️ Configurable directory patterns and defaults

🚀 **Coming Soon** (Phase 2-3):
- 🎨 Interactive TUI for browsing and managing worktrees
- 🔄 Session restoration (`revive` command)
- 🪝 Extensibility hooks for custom workflows
- 📊 Health checks and orphan detection

## Why Swarm?

Working on multiple features simultaneously requires juggling Git branches and development contexts. Swarm automates:

1. **Worktree Management** - No more manual `git worktree add` commands
2. **Tmux Integration** - Each worktree gets its own session with custom layout
3. **Context Switching** - Instant switching between features
4. **Safety** - Prevents accidental data loss with pre-removal checks
5. **Discoverability** - All worktrees visible to AI tools in `ai_working/`

## Installation

### Prerequisites

- Go 1.21+ ([install](https://go.dev/dl/))
- Git 2.31+ with worktree support
- tmux 3.0+
- macOS or Linux

### Build from Source

```bash
cd ai_working/swarm
go mod download
go build -o swarm ./cmd/swarm
sudo cp swarm /usr/local/bin/
```

Or use the Makefile:
```bash
make install
```

## Configuration

Swarm uses layered configuration with the following precedence:

1. **Environment variables** (highest priority)
2. **User config** (`~/.config/swarm/config.yml`)
3. **Project config** (`$AI_WORKING_DIR/.swarmrc`)
4. **Built-in defaults**

### Example config.yml

```yaml
# Location of repositories (default: ~/amplifier/ai_working)
ai_working_dir: ~/amplifier/ai_working

# Default base branch for new worktrees
default_base_branch: main

# Worktree directory pattern (patternA, patternB, patternC)
# patternA: ai_working/repo__wt__slug (recommended)
# patternB: ai_working/repo.worktrees/slug
# patternC: ai_working/repo/.swarm/worktrees/slug
worktree_pattern: patternA

# Create tmux session when creating worktree
create_session_on_create: true

# Custom tmux layout script (optional)
tmux_layout_script: ~/.config/swarm/layout.sh

# Status cache TTL (for expensive git operations)
status_cache_ttl: 30s

# Auto-prune git after removing worktree
auto_prune_on_remove: true
```

### Environment Variables

```bash
export AI_WORKING_DIR="$HOME/amplifier/ai_working"
export SWARM_DEFAULT_BASE_BRANCH="main"
export SWARM_WORKTREE_PATTERN="patternA"
```

## Usage

### Creating Worktrees

```bash
# Create from existing branch
swarm create <repo> <branch>

# Create new branch from base
swarm create <repo> <branch> --from main

# Custom slug
swarm create <repo> <branch> --slug custom-slug

# Skip tmux session creation
swarm create <repo> <branch> --no-session
```

**Example:**
```bash
swarm create fintoc-rails feature/payments-refactor --from main
# Created: ai_working/fintoc-rails__wt__feature_payments-refactor
# Tmux session: fintoc-rails--wt--feature_payments-refactor
```

### Opening Worktrees

```bash
# Open (attach to tmux session, create if needed)
swarm open <repo> <branch|slug>

# Only attach to existing session (don't create)
swarm open <repo> <branch> --attach-only

# Create worktree if missing
swarm open <repo> <branch> --create
```

**Example:**
```bash
swarm open fintoc-rails feature/payments-refactor
# Attaches to tmux session
# Inside tmux: window 1 = nvim, window 2 = shell, window 3 = tests
```

### Listing Worktrees

```bash
# List worktrees for specific repo
swarm list <repo>

# List all worktrees
swarm list --all

# JSON output
swarm list --all --json

# Filter by repo
swarm list --repo fintoc-rails
```

**Example output:**
```
fintoc-rails
  ✓ main                     /path/to/fintoc-rails
  ✓ feature_payments-refactor /path/to/fintoc-rails__wt__feature_payments-refactor
    [MODIFIED] [UNPUSHED]
    Last opened: 2 hours ago

underworld-tf
  ✓ main                     /path/to/underworld-tf
```

### Removing Worktrees

```bash
# Remove worktree (with safety checks)
swarm remove <repo> <branch|slug>

# Force remove (bypass safety checks)
swarm remove <repo> <branch> --force

# Keep git branch after removing worktree
swarm remove <repo> <branch> --keep-branch
```

**Safety checks:**
- ⚠️ Uncommitted changes (blocks removal)
- ⚠️ Unpushed commits (warns but allows)
- ℹ️ Branch not merged (info only)

**Example:**
```bash
swarm remove fintoc-rails feature/payments-refactor
# ⚠️  Cannot remove worktree:
#   • Worktree has uncommitted changes
#
# View changes: cd /path/to/worktree && git status
# Remove anyway: swarm remove fintoc-rails feature/payments-refactor --force
```

### Other Commands

```bash
# Prune stale worktree references
swarm prune <repo>
swarm prune --all

# List tmux sessions
swarm sessions

# Kill specific session
swarm kill-session <repo> <branch>

# Validate environment
swarm doctor

# Show config
swarm config get <key>
swarm config set <key> <value>

# Get worktree info from path
swarm info /path/to/worktree
```

## Directory Structure

### Pattern A (Default - Flat Sibling)

```
ai_working/
├── fintoc-rails/                          # Base repo
├── fintoc-rails__wt__main/                # Worktree for main
├── fintoc-rails__wt__feature_foo/         # Worktree for feature/foo
├── underworld-tf/
├── underworld-tf__wt__feature_bar/
└── .swarm-state.json                      # State file
```

**Benefits:**
- First-class visibility for AI tools
- Easy to discover and clean up
- Simple mental model

### Tmux Session Naming

Format: `<repo-slug>--wt--<worktree-slug>`

Examples:
- `fintoc-rails--wt--main`
- `fintoc-rails--wt--feature_payments-refactor`
- `underworld-tf--wt--bugfix_auth-issue`

## Architecture

Swarm follows the **"bricks and studs"** modular design philosophy:

```
┌─────────────────────────────────────────┐
│           CLI Layer (Cobra)             │
│    create, open, list, remove, etc.     │
└─────────────────┬───────────────────────┘
                  │
┌─────────────────▼───────────────────────┐
│         Domain Modules                  │
│  • repo_discovery                       │
│  • worktree_manager                     │
│  • tmux_manager                         │
│  • state_store                          │
│  • config                               │
│  • safety_checker                       │
└─────────────────┬───────────────────────┘
                  │
┌─────────────────▼───────────────────────┐
│      Infrastructure (Git, Tmux)         │
└─────────────────────────────────────────┘
```

Each module is:
- **Self-contained** with clear boundaries
- **Regeneratable** from specifications
- **Testable** in isolation

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for details.

## Development

### Project Structure

```
swarm/
├── cmd/swarm/          # CLI entry point
├── internal/
│   ├── config/         # Configuration loading
│   ├── git/            # Git command wrapper
│   ├── state/          # State persistence
│   ├── repo/           # Repository discovery
│   ├── worktree/       # Worktree lifecycle
│   ├── tmux/           # Tmux session management
│   └── safety/         # Safety checks
├── docs/
│   ├── ARCHITECTURE.md # System architecture
│   ├── DECISIONS.md    # Architecture decision records
│   ├── MODULES.md      # Module specifications
│   └── plans/          # Implementation plans
└── test/
    ├── fixtures/       # Test data
    └── integration/    # Integration tests
```

### Running Tests

```bash
# Unit tests
go test ./internal/... -v

# Integration tests (requires git + tmux)
go test ./internal/... -v -tags=integration

# All tests with coverage
go test ./... -v -coverprofile=coverage.out
go tool cover -html=coverage.out
```

### Building

```bash
# Development build
go build -o swarm ./cmd/swarm

# Production build (optimized)
go build -ldflags="-s -w" -o swarm ./cmd/swarm

# Multi-platform
GOOS=darwin GOARCH=amd64 go build -o swarm-darwin-amd64
GOOS=darwin GOARCH=arm64 go build -o swarm-darwin-arm64
GOOS=linux GOARCH=amd64 go build -o swarm-linux-amd64
```

### Code Quality

```bash
# Format
go fmt ./...

# Lint
golangci-lint run

# Vet
go vet ./...
```

## Implementation Roadmap

### ✅ Phase 1: Foundation & Core CLI (Current)

- [x] Project scaffolding
- [x] Config module (loading, precedence, validation)
- [x] Git module (worktree commands, parsing)
- [x] State module (JSON persistence, locking)
- [x] Repo module (discovery, validation)
- [x] Worktree module (slug generation, CRUD)
- [x] CLI commands: `create`, `list`, `open`, `remove`
- [x] Basic testing

### 🚧 Phase 2: TUI & Safety (Next)

- [ ] TUI framework setup (Bubble Tea)
- [ ] Interactive worktree browser
- [ ] Safety checks (uncommitted, unpushed, merged)
- [ ] Tmux session management
- [ ] Status computation (with caching)
- [ ] Orphan detection

### 🎯 Phase 3: Refinement

- [ ] `revive` command (restore sessions)
- [ ] `rename` command (branch + slug)
- [ ] Performance optimizations (parallel scanning)
- [ ] Shell completions (bash, zsh, fish)
- [ ] Comprehensive error messages
- [ ] User documentation

### 🔮 Phase 4: Extensibility

- [ ] Plugin hook system
- [ ] Custom layout templates
- [ ] fzf integration
- [ ] AI context generation hooks
- [ ] JSON-RPC server mode

## Design Philosophy

Swarm adheres to the **Amplifier implementation philosophy**:

1. **Ruthless Simplicity** - Keep everything as simple as possible
2. **Architectural Integrity** - Preserve patterns, simplify implementations
3. **Bricks and Studs** - Self-contained modules with stable contracts
4. **Regeneratable Code** - Modules can be rebuilt from specifications
5. **Test-First** - Every module has comprehensive tests

See [`ai_context/IMPLEMENTATION_PHILOSOPHY.md`](../../ai_context/IMPLEMENTATION_PHILOSOPHY.md) for details.

## Troubleshooting

### Worktree creation fails

```bash
# Check git version (need 2.31+)
git --version

# Verify repo is git repository
cd ai_working/repo-name
git status

# Check for existing worktrees
git worktree list
```

### Tmux session not found

```bash
# List all sessions
tmux ls

# Check if tmux is running
ps aux | grep tmux

# Manually create session
swarm open repo branch --create
```

### State file corruption

```bash
# Backup current state
cp ai_working/.swarm-state.json ai_working/.swarm-state.json.bak

# Regenerate from git
swarm scan --rebuild
```

### Permission errors

```bash
# Check directory permissions
ls -la ~/amplifier/ai_working

# Check git worktree permissions
git worktree list
```

## Contributing

### Reporting Issues

1. Check existing issues
2. Provide minimal reproduction
3. Include:
   - OS and version
   - Go version (`go version`)
   - Git version (`git --version`)
   - Tmux version (`tmux -V`)
   - Swarm version (`swarm version`)
   - Error messages and logs

### Development Setup

```bash
# Clone repo
cd ~/amplifier/ai_working/swarm

# Install dependencies
go mod download

# Run tests
make test

# Build
make build
```

### Pull Requests

1. Create feature branch
2. Write tests (aim for >80% coverage)
3. Update documentation
4. Run `make check` (format, lint, test)
5. Submit PR with description

## License

[License to be determined]

## Acknowledgments

Inspired by existing tools:
- [wttw](https://github.com/chitacan/wttw) - Git worktree in tmux window
- [dmux](https://github.com/justin-schroeder/dmux) - Worktree + AI agent integration
- [phantom](https://github.com/aku11i/phantom) - Parallel development with worktrees

Built with:
- [Cobra](https://github.com/spf13/cobra) - CLI framework
- [Bubble Tea](https://github.com/charmbracelet/bubbletea) - TUI framework (Phase 2)
- [Viper](https://github.com/spf13/viper) - Configuration management

## Links

- [Documentation](docs/)
- [Architecture](docs/ARCHITECTURE.md)
- [Module Specifications](docs/MODULES.md)
- [Implementation Plans](docs/plans/)
- [Git Worktree Guide](https://git-scm.com/docs/git-worktree)
- [Tmux Manual](https://man.openbsd.org/tmux.1)

---

**Questions?** Open an issue or check the [documentation](docs/).

**Status:** Phase 1 (Foundation) - In Development
