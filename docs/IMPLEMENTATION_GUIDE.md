# Swarm Implementation Guide

**For:** Junior developers implementing Swarm from scratch
**Goal:** Complete working CLI tool for Git worktree + tmux session management
**Timeline:** 4-6 weeks total (Phase 1: 2-3 weeks, Phase 2: 1-2 weeks, Phase 3: 1 week)

---

## Quick Navigation

- [**Start Here: Getting Started**](#getting-started)
- [**Phase 1: Foundation**](plans/PHASE-1-FOUNDATION.md) - Core modules and CLI
- [**Phase 2: TUI & Safety**](#phase-2-brief) - Interactive UI and safety checks
- [**Phase 3: Refinement**](#phase-3-brief) - Polish and optimization
- [**Architecture Overview**](ARCHITECTURE.md)
- [**Module Specifications**](MODULES.md)
- [**Design Decisions**](DECISIONS.md)

---

## Getting Started

### Prerequisites Knowledge

You should be familiar with:
- **Go basics** (structs, interfaces, error handling, goroutines)
- **Git fundamentals** (branches, worktrees, remotes)
- **Command-line tools** (flags, subcommands, pipes)
- **Tmux basics** (sessions, windows, panes)

Don't worry if you're not an expert - the implementation is well-documented.

### Development Environment Setup

1. **Install required tools:**
```bash
# Go 1.21+
brew install go  # macOS
# or from https://go.dev/dl/

# tmux 3.0+
brew install tmux

# Git 2.31+
brew install git

# Verify installations
go version      # Should be 1.21+
tmux -V         # Should be 3.0+
git --version   # Should be 2.31+
```

2. **Set up workspace:**
```bash
# Navigate to project
cd ~/amplifier/ai_working/swarm

# Verify it's a git repo
git status

# Set environment variable for testing
export AI_WORKING_DIR="$HOME/amplifier/ai_working"
echo 'export AI_WORKING_DIR="$HOME/amplifier/ai_working"' >> ~/.bashrc
```

3. **IDE Setup (Optional but recommended):**
```bash
# VS Code with Go extension
code .

# Or use vim/neovim with gopls LSP
```

### Project Philosophy Review

Before coding, read these documents to understand the approach:

1. **[IMPLEMENTATION_PHILOSOPHY.md](../../ai_context/IMPLEMENTATION_PHILOSOPHY.md)**
   - Ruthless simplicity
   - Avoid future-proofing
   - Trust in emergence

2. **[MODULAR_DESIGN_PHILOSOPHY.md](../../ai_context/MODULAR_DESIGN_PHILOSOPHY.md)**
   - "Bricks and studs" metaphor
   - Self-contained, regeneratable modules
   - Clear contracts

3. **[ARCHITECTURE.md](ARCHITECTURE.md)**
   - System layers
   - Data flow
   - Module dependencies

4. **[MODULES.md](MODULES.md)**
   - Each module's contract ("studs")
   - Implementation notes
   - Testing strategy

---

## Implementation Approach

### The 3-Phase Strategy

```
Phase 1 (2-3 weeks)          Phase 2 (1-2 weeks)          Phase 3 (1 week)
Foundation                   TUI & Safety                 Refinement
├─ Config                    ├─ Bubble Tea TUI            ├─ revive command
├─ Git wrapper               ├─ Safety checks             ├─ Shell completions
├─ State persistence         ├─ Tmux integration          ├─ Performance opts
├─ Repo discovery            ├─ Status computation        ├─ Documentation
├─ Worktree CRUD             └─ Orphan detection          └─ Polish
└─ Basic CLI commands

MVP (create, list, open, remove worktrees)
```

### Daily Development Workflow

1. **Morning: Pick a task**
   - Start with [Phase 1 plan](plans/PHASE-1-FOUNDATION.md)
   - Choose one task (1.1, 1.2, etc.)
   - Read task requirements thoroughly

2. **Implementation:**
   - Write contract (interface) first
   - Implement minimal version
   - Write tests as you go (not after)
   - Run tests frequently (`go test ./...`)

3. **Validation:**
   - All tests pass
   - Code formatted (`go fmt`)
   - No lint warnings (`golangci-lint run`)
   - Manual testing works

4. **Documentation:**
   - Update module README if needed
   - Add godoc comments
   - Note any decisions made

5. **Commit:**
   - Small, focused commits
   - Descriptive messages
   - Reference task number

### Test-Driven Development Pattern

**Always write tests first or alongside code:**

```go
// 1. Write test (it will fail)
func TestGenerateSlug(t *testing.T) {
    got := GenerateSlug("feature/foo")
    want := "feature_foo"
    assert.Equal(t, want, got)
}

// 2. Implement minimal code to make it pass
func GenerateSlug(branch string) string {
    return strings.ReplaceAll(branch, "/", "_")
}

// 3. Run test, watch it pass
// go test -v

// 4. Refactor if needed (tests still pass)
```

**Benefits:**
- Catches bugs early
- Forces you to think about contracts
- Makes refactoring safe
- Serves as documentation

---

## Phase Overviews

### Phase 1: Foundation & Core CLI

**Goal:** Working CLI for basic worktree lifecycle

**Duration:** 2-3 weeks

**Detailed Plan:** [PHASE-1-FOUNDATION.md](plans/PHASE-1-FOUNDATION.md)

**Key Deliverables:**
- Config system (load from env, files, defaults)
- Git wrapper (worktree commands, parsing)
- State persistence (JSON with locking)
- Repo discovery (scan `ai_working/`)
- Worktree manager (create, list, remove)
- CLI commands: `create`, `list`, `open`, `remove`

**Success Criteria:**
```bash
# These work end-to-end:
swarm create my-project feature/test --from main
swarm list my-project
swarm open my-project feature/test
swarm remove my-project feature/test
```

**Module Order:**
1. Config (no dependencies)
2. Git (no dependencies)
3. State (uses config)
4. Repo (uses git, config)
5. Worktree (uses git, state, repo)
6. CLI (uses all above)

---

### Phase 2 Brief

**Goal:** Interactive TUI, safety checks, full tmux integration

**Duration:** 1-2 weeks

**Key Modules:**

1. **TUI (Terminal User Interface)**
   - Framework: Bubble Tea + Bubbles
   - Three-panel layout (repos, worktrees, detail)
   - Keybindings: q, /, r, n, o, d, ?
   - Async status loading

2. **Safety Checker**
   - Check uncommitted changes
   - Check unpushed commits
   - Check branch merged status
   - Return CheckResult with blockers/warnings

3. **Tmux Manager**
   - Create session with custom layout
   - Attach/switch to session
   - Kill session
   - List all sessions

4. **Status Computation**
   - Lazy evaluation (cache with TTL)
   - Parallel computation
   - Display badges in TUI

**Success Criteria:**
```bash
# TUI works
swarm tui
# Interactive browsing, creation, opening, deletion

# Safety checks prevent data loss
swarm remove repo branch
# ⚠️  Cannot remove: uncommitted changes

# Tmux sessions created automatically
swarm open repo branch
# Opens in tmux with 3 windows
```

**New Commands:**
- `swarm tui` - Launch interactive UI
- `swarm sessions` - List tmux sessions
- `swarm kill-session` - Kill specific session
- `swarm prune` - Clean stale worktrees

---

### Phase 3 Brief

**Goal:** Polish, optimization, user experience

**Duration:** 1 week

**Key Features:**

1. **revive Command**
   - Scan state for recently opened worktrees
   - Recreate tmux sessions if missing
   - `swarm revive --hours 8`

2. **rename Command**
   - Rename branch + update slug
   - Update state and tmux session
   - `swarm rename repo old-branch new-branch`

3. **Performance Optimization**
   - Parallel repo scanning (worker pool)
   - Status caching (avoid redundant git calls)
   - State file incremental updates

4. **Shell Completions**
   - Generate completions for bash, zsh, fish
   - `swarm completion bash > /etc/bash_completion.d/swarm`

5. **Documentation**
   - User guide
   - Troubleshooting section
   - GIF demos (optional)

**Success Criteria:**
- `revive` brings back all recent sessions
- Performance: scan <1s for 10 repos
- Completions work in shell
- All commands have --help text
- README has quickstart guide

---

## Common Implementation Patterns

### Pattern 1: Module Structure

Every module follows this structure:

```
internal/modulename/
├── modulename.go         # Public interface (contract)
├── types.go              # Data structures
├── implementation.go     # Private implementation
├── modulename_test.go    # Unit tests
└── README.md             # Module documentation
```

**Example: worktree module**
```
internal/worktree/
├── worktree.go           # Manager interface
├── types.go              # Worktree, CreateOptions structs
├── manager.go            # Manager implementation
├── slug.go               # Slug generation
├── worktree_test.go      # Tests
├── slug_test.go          # Slug tests
└── README.md             # Module docs
```

### Pattern 2: Error Handling

```go
// Wrap errors with context
if err != nil {
    return fmt.Errorf("creating worktree: %w", err)
}

// Custom error types for specific cases
var (
    ErrRepoNotFound = errors.New("repository not found")
    ErrWorktreeExists = errors.New("worktree already exists")
)

// Check error type
if errors.Is(err, ErrRepoNotFound) {
    // Handle specifically
}
```

### Pattern 3: Interface Design

```go
// Good: Minimal, focused interface
type WorktreeManager interface {
    Create(repo *Repo, opts CreateOptions) (*Worktree, error)
    List(repo *Repo) ([]Worktree, error)
    Remove(wt *Worktree, force bool) error
}

// Bad: Kitchen sink interface
type WorktreeManager interface {
    Create(...)
    CreateWithCustomLayout(...)
    CreateAndOpen(...)
    CreateFromTemplate(...)
    // Too many methods, unclear responsibility
}
```

### Pattern 4: Testing

```go
// Table-driven tests
func TestGenerateSlug(t *testing.T) {
    tests := []struct {
        name   string
        input  string
        want   string
    }{
        {"simple", "main", "main"},
        {"with slash", "feature/foo", "feature_foo"},
        // More cases...
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            got := GenerateSlug(tt.input)
            assert.Equal(t, tt.want, got)
        })
    }
}

// Setup/teardown pattern
func TestWithTempRepo(t *testing.T) {
    // Setup
    tmpDir := t.TempDir()
    setupGitRepo(tmpDir)

    // Test
    // ...

    // Teardown is automatic with t.TempDir()
}
```

### Pattern 5: Configuration

```go
// Load with defaults
cfg := DefaultConfig
cfg.AIWorkingDir = os.Getenv("AI_WORKING_DIR")

// Override from file
if data, err := os.ReadFile(configFile); err == nil {
    json.Unmarshal(data, &cfg)
}

// Validate
if err := cfg.Validate(); err != nil {
    return err
}
```

---

## Debugging Tips

### Common Issues and Solutions

**Issue: Tests fail with "git: command not found"**
```bash
# Solution: Ensure git is in PATH
which git
export PATH="/usr/local/bin:$PATH"
```

**Issue: State file is corrupted**
```bash
# Solution: Delete and regenerate
rm ~/amplifier/ai_working/.swarm-state.json
swarm scan
```

**Issue: Import cycle detected**
```bash
# Solution: Check module dependencies
# Each module should import only its dependencies, not siblings
# Example: worktree can import git, but git should NOT import worktree
```

**Issue: Tests hang**
```bash
# Solution: Check for missing t.Parallel() or infinite loops
# Run with timeout:
go test -timeout 10s ./...
```

### Debugging Techniques

**1. Print debugging (simple but effective):**
```go
fmt.Printf("DEBUG: repo=%s, branch=%s\n", repo, branch)
```

**2. Use delve (Go debugger):**
```bash
go install github.com/go-delve/delve/cmd/dlv@latest
dlv test ./internal/worktree -- -test.run TestCreate
```

**3. Table-driven test isolation:**
```go
// Run single test case
go test -v -run TestGenerateSlug/with_slash
```

**4. Check git output directly:**
```bash
# See what git commands return
git -C ~/amplifier/ai_working/my-project worktree list --porcelain
```

---

## Getting Unstuck

### When You're Confused About:

**Module interactions:**
1. Read [ARCHITECTURE.md](ARCHITECTURE.md) data flow section
2. Look at dependency graph in [MODULES.md](MODULES.md)
3. Draw boxes and arrows on paper

**How to implement something:**
1. Check if similar pattern exists in another module
2. Read the module's README.md
3. Look at test examples
4. Reference [PHASE-1-FOUNDATION.md](plans/PHASE-1-FOUNDATION.md) task details

**Why a decision was made:**
1. Check [DECISIONS.md](DECISIONS.md) ADRs
2. Read rationale and alternatives
3. If still unclear, document your question

**How to test something:**
1. Look at existing tests in same module
2. Check [MODULES.md](MODULES.md) testing section
3. Start with simplest case, add complexity

**Git worktree behavior:**
1. Read [git worktree documentation](https://git-scm.com/docs/git-worktree)
2. Experiment in a test repo:
   ```bash
   mkdir /tmp/test-worktree && cd /tmp/test-worktree
   git init && git commit --allow-empty -m "Initial"
   git worktree add ../test-wt -b feature
   git worktree list --porcelain
   ```

**Tmux behavior:**
1. Read [tmux manual](https://man.openbsd.org/tmux.1)
2. Experiment:
   ```bash
   tmux new-session -d -s test -c /tmp
   tmux has-session -t test && echo "exists"
   tmux kill-session -t test
   ```

### When to Ask for Help

**Do your research first:**
- Read relevant documentation
- Search error messages
- Try debugging techniques above

**Then ask with context:**
- What you're trying to do
- What you've tried
- Error messages / unexpected behavior
- Relevant code snippets

**Good question format:**
```
I'm implementing Task 1.7 (Worktree Manager).

Goal: Create a new worktree from an existing branch

Problem: WorktreeAdd returns error "branch already checked out"

What I've tried:
1. Checked git worktree list - branch not listed
2. Tried with different branch - same error
3. Added -f flag - no effect

Code:
[paste relevant snippet]

Error:
[paste full error]

Question: Should I check for existing worktrees before calling WorktreeAdd?
```

---

## Success Metrics

### Phase 1 Complete When:

- [ ] `go build` produces working binary
- [ ] All unit tests pass: `go test ./...`
- [ ] Integration tests pass: `go test -tags=integration ./...`
- [ ] Manual workflow works:
  ```bash
  swarm create test-repo feature/test --from main
  # Creates worktree directory
  swarm list test-repo
  # Shows feature/test
  swarm open test-repo feature/test
  # Creates/attaches tmux session
  swarm remove test-repo feature/test
  # Removes cleanly
  ```
- [ ] Code is formatted: `go fmt ./...`
- [ ] No lint warnings: `golangci-lint run`
- [ ] README has basic usage examples
- [ ] All modules have README.md

### Overall Project Complete When:

- [ ] All three phases done
- [ ] TUI works smoothly
- [ ] Safety checks prevent data loss
- [ ] Performance acceptable (<2s for common operations)
- [ ] Documentation complete
- [ ] User feedback incorporated

---

## Additional Resources

### Go Resources

- [Go by Example](https://gobyexample.com/)
- [Effective Go](https://go.dev/doc/effective_go)
- [Go Testing](https://go.dev/doc/tutorial/add-a-test)
- [Testify Package](https://github.com/stretchr/testify)

### Domain-Specific

- [Git Worktree Tutorial](https://git-scm.com/docs/git-worktree)
- [Tmux Cheat Sheet](https://tmuxcheatsheet.com/)
- [Cobra CLI Guide](https://github.com/spf13/cobra/blob/master/user_guide.md)
- [Bubble Tea Tutorial](https://github.com/charmbracelet/bubbletea/tree/master/tutorials)

### Project Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) - System design
- [MODULES.md](MODULES.md) - Module contracts
- [DECISIONS.md](DECISIONS.md) - Why we made certain choices
- [PHASE-1-FOUNDATION.md](plans/PHASE-1-FOUNDATION.md) - Detailed task breakdown

---

## Final Thoughts

### Philosophy Reminders

1. **Keep it simple** - Don't add features "just in case"
2. **Test as you go** - Don't wait until the end
3. **Read before coding** - Understand the contracts
4. **Ask questions** - Better than going down wrong path
5. **Iterate** - First version doesn't need to be perfect

### Motivation

Building Swarm teaches you:
- Go project structure and idioms
- CLI tool development
- TUI programming
- Git internals
- Process management (tmux)
- Testing strategies
- Modular design

By the end, you'll have:
- A useful tool you can actually use
- Deep understanding of worktrees and tmux
- Experience with production-quality Go code
- Portfolio project to showcase

**You've got this! Start with Task 1.1 in [Phase 1](plans/PHASE-1-FOUNDATION.md).**

---

**Questions?** Document them and discuss with team lead.

**Stuck?** Review the "Getting Unstuck" section above.

**Making progress?** Commit frequently, celebrate small wins! 🎉
