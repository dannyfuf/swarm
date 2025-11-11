# Start Here - Swarm Implementation

Welcome! This document will guide you through implementing Swarm from the comprehensive plans created.

---

## What You Have

A complete set of implementation documents for building **Swarm**, a Git worktree + tmux session manager:

### 📚 Core Documentation

1. **[README.md](../README.md)** - Project overview, features, usage examples
2. **[IMPLEMENTATION_GUIDE.md](IMPLEMENTATION_GUIDE.md)** - **Start here!** Complete guide for junior developers
3. **[ARCHITECTURE.md](ARCHITECTURE.md)** - System design, data flow, module structure
4. **[MODULES.md](MODULES.md)** - Detailed module specifications ("bricks and studs")
5. **[DECISIONS.md](DECISIONS.md)** - Architecture Decision Records (why we chose what we chose)
6. **[TESTING_STRATEGY.md](TESTING_STRATEGY.md)** - Comprehensive testing approach

### 📋 Implementation Plans

1. **[plans/PHASE-1-FOUNDATION.md](plans/PHASE-1-FOUNDATION.md)** - Detailed task breakdown (2-3 weeks)
   - Task 1.1: Project scaffolding
   - Task 1.2: Config module
   - Task 1.3: Git module
   - Task 1.4: State module
   - Task 1.5: Repo module
   - Task 1.6: Worktree slug generation
   - (More tasks continue in the document)

2. **Phase 2 Brief** (in IMPLEMENTATION_GUIDE.md) - TUI, safety checks, tmux integration (1-2 weeks)
3. **Phase 3 Brief** (in IMPLEMENTATION_GUIDE.md) - Refinement and polish (1 week)

### 🛠️ Build System

- **[Makefile](../Makefile)** - Build, test, install commands

---

## Quick Start Path

### Step 1: Read the Philosophy (15 minutes)

Understand the "why" before the "how":

1. Read sections in [IMPLEMENTATION_GUIDE.md](IMPLEMENTATION_GUIDE.md):
   - Project Philosophy Review
   - Implementation Approach
   - Common Implementation Patterns

2. Skim [ARCHITECTURE.md](ARCHITECTURE.md):
   - Overview section
   - Module Overview diagram
   - Data Flow examples

### Step 2: Set Up Environment (30 minutes)

```bash
# 1. Navigate to project
cd ~/amplifier/ai_working/swarm

# 2. Check prerequisites
make doctor

# 3. Set up development environment
make dev-setup

# 4. Initialize Go module
go mod init github.com/microsoft/amplifier/swarm

# 5. Add initial dependencies
go get github.com/spf13/cobra@latest
go get github.com/spf13/viper@latest
go get github.com/gofrs/flock@latest
go get github.com/stretchr/testify@latest

# 6. Verify setup
go mod tidy
go mod download
```

### Step 3: Start Phase 1 Implementation (Day 1)

Open [plans/PHASE-1-FOUNDATION.md](plans/PHASE-1-FOUNDATION.md) and start with:

**Task 1.1: Project Scaffolding** (2-3 hours)
- Create directory structure
- Set up main.go and root command
- Build and test basic CLI

Follow the detailed steps in the plan. Each task includes:
- Objective
- Step-by-step instructions
- Complete code examples
- Testing instructions
- Validation checklist

### Step 4: Continue Phase 1 (Week 1-3)

Work through tasks in order:
- 1.2: Config Module (4-6 hours)
- 1.3: Git Module (6-8 hours)
- 1.4: State Module (4-6 hours)
- 1.5: Repo Module (3-4 hours)
- 1.6: Worktree Module - Slug (2-3 hours)
- 1.7-1.13: Continue with remaining tasks

**Daily workflow:**
1. Pick next task
2. Read task description thoroughly
3. Implement with tests
4. Run tests frequently
5. Commit when tests pass

---

## Document Navigation Guide

### When You Need...

**To understand the overall system:**
→ [ARCHITECTURE.md](ARCHITECTURE.md)

**Detailed step-by-step implementation:**
→ [plans/PHASE-1-FOUNDATION.md](plans/PHASE-1-FOUNDATION.md)

**Module specifications and contracts:**
→ [MODULES.md](MODULES.md)

**Why a decision was made:**
→ [DECISIONS.md](DECISIONS.md)

**How to test:**
→ [TESTING_STRATEGY.md](TESTING_STRATEGY.md)

**General guidance and patterns:**
→ [IMPLEMENTATION_GUIDE.md](IMPLEMENTATION_GUIDE.md)

**Usage examples:**
→ [README.md](../README.md)

**Build commands:**
→ [Makefile](../Makefile) or run `make help`

---

## Key Concepts to Understand

### 1. Bricks and Studs Philosophy

From [MODULAR_DESIGN_PHILOSOPHY.md](../../ai_context/MODULAR_DESIGN_PHILOSOPHY.md):

- **Brick** = self-contained module (e.g., `worktree` module)
- **Stud** = public interface (e.g., `WorktreeManager` interface)
- Modules can be **regenerated** from their specifications
- Contracts (studs) remain **stable**

**Example:**
```go
// Stud (contract) - stable
type WorktreeManager interface {
    Create(repo *Repo, opts CreateOptions) (*Worktree, error)
}

// Brick (implementation) - can be regenerated
type Manager struct {
    git   GitClient
    state StateStore
}

func (m *Manager) Create(repo *Repo, opts CreateOptions) (*Worktree, error) {
    // Implementation can change without breaking contract
}
```

### 2. Module Dependencies

From [ARCHITECTURE.md](ARCHITECTURE.md):

```
         config (no deps)
         /    \
      repo    state
        \      /  \
       worktree   \
        /  \  \    \
     git  tmux  safety
```

**Implementation order:**
1. Foundation: config, git (no dependencies)
2. Persistence: state (needs config)
3. Logic: repo, worktree (need git, state)
4. UI: CLI, TUI (use everything)

### 3. Directory Pattern A (Default)

From [DECISIONS.md](DECISIONS.md) ADR-002:

```
ai_working/
├── my-project/                   # Base repo
├── my-project__wt__main/         # Worktree for main
├── my-project__wt__feature_foo/  # Worktree for feature/foo
└── .swarm-state.json               # State file
```

**Why:** First-class visibility for AI tools, easy discovery

### 4. State as Cache, Git as Truth

From [DECISIONS.md](DECISIONS.md) ADR-004:

- Git is **authoritative** (`git worktree list`)
- State file is **cache** (for metadata and performance)
- Always **reconcile** state with git reality

---

## Success Criteria

### Phase 1 Complete When:

- [ ] `make build` produces working binary
- [ ] All tests pass: `make test-all`
- [ ] Manual workflow works:
  ```bash
  swarm create test-repo feature/test --from main
  swarm list test-repo
  swarm open test-repo feature/test
  swarm remove test-repo feature/test
  ```
- [ ] Code quality: `make check` passes
- [ ] Documentation: All modules have README.md

### Project Complete When:

- [ ] All three phases implemented
- [ ] TUI works (Phase 2)
- [ ] All features working (Phase 3)
- [ ] Test coverage >80%
- [ ] User documentation complete

---

## Development Workflow

### Daily Routine

**Morning:**
1. Review yesterday's progress
2. Pick next task from Phase 1 plan
3. Read task requirements
4. Review relevant module spec in MODULES.md

**During Implementation:**
1. Write tests first (or alongside code)
2. Implement minimal version
3. Run tests: `go test ./...`
4. Iterate until tests pass
5. Format: `go fmt ./...`
6. Commit with clear message

**End of Day:**
1. Run full test suite: `make test`
2. Check code quality: `make check`
3. Document any decisions or blockers
4. Commit work in progress

### Testing Workflow

```bash
# Quick unit test while developing
go test ./internal/worktree/ -v

# Test specific function
go test ./internal/worktree/ -run TestGenerateSlug -v

# Full test suite
make test

# With coverage
make coverage
# Opens coverage.html in browser

# Integration tests (requires git + tmux)
make test-integration
```

### Build Workflow

```bash
# Development build
make build
./bin/swarm --help

# Install for testing
make install
swarm --help

# Clean and rebuild
make clean
make build
```

---

## Common Commands Reference

### Make Commands

```bash
make help              # Show all available commands
make build             # Build binary
make install           # Build and install to /usr/local/bin
make test              # Run unit tests
make test-all          # Run all tests
make check             # Format, vet, lint, test
make clean             # Remove build artifacts
make doctor            # Check environment setup
```

### Go Commands

```bash
go test ./...                 # All tests
go test ./internal/config/ -v # Specific module
go test -tags=integration ./... # Integration tests
go build -o swarm ./cmd/swarm   # Build
go fmt ./...                  # Format code
go vet ./...                  # Static analysis
```

### Swarm Commands (once built)

```bash
swarm create <repo> <branch> --from <base>
swarm list [repo] [--all] [--json]
swarm open <repo> <branch>
swarm remove <repo> <branch> [--force]
swarm prune <repo|--all>
swarm doctor
```

---

## Getting Help

### When Stuck

1. **Check the docs:**
   - Is there a similar example in the codebase?
   - Does MODULES.md have relevant info?
   - Is there an ADR explaining the decision?

2. **Use the debugging tips** in IMPLEMENTATION_GUIDE.md:
   - Print debugging
   - Run specific tests
   - Check git commands directly

3. **Review test examples:**
   - Look at existing tests in the same module
   - Check TESTING_STRATEGY.md

4. **Ask with context:**
   - What you're trying to do
   - What you've tried
   - Error messages
   - Relevant code snippets

### Resources

- [Go Documentation](https://go.dev/doc/)
- [Git Worktree Docs](https://git-scm.com/docs/git-worktree)
- [Tmux Manual](https://man.openbsd.org/tmux.1)
- [Cobra CLI Guide](https://github.com/spf13/cobra)
- [Testify Package](https://github.com/stretchr/testify)

---

## Next Steps

### Immediate Actions

1. ✅ Read this document (you're doing it!)
2. ⬜ Set up environment: `make doctor` and `make dev-setup`
3. ⬜ Read IMPLEMENTATION_GUIDE.md philosophy sections
4. ⬜ Start Task 1.1 in plans/PHASE-1-FOUNDATION.md

### First Week Goals

- Complete Tasks 1.1-1.3 (Scaffolding, Config, Git)
- Understand module structure
- Get comfortable with test-driven development
- First successful `go build`

### First Month Goals

- Complete Phase 1 (all modules, basic CLI)
- Working worktree lifecycle
- Test coverage >80%
- Ready to start Phase 2 (TUI)

---

## Document Structure Overview

```
swarm/
├── README.md                       # Project overview
├── Makefile                        # Build commands
├── go.mod                          # (you'll create this)
├── docs/
│   ├── START_HERE.md              # This file!
│   ├── IMPLEMENTATION_GUIDE.md    # Complete implementation guide
│   ├── ARCHITECTURE.md            # System architecture
│   ├── MODULES.md                 # Module specifications
│   ├── DECISIONS.md               # Architecture decisions
│   ├── TESTING_STRATEGY.md        # Testing approach
│   └── plans/
│       └── PHASE-1-FOUNDATION.md  # Detailed Phase 1 tasks
├── cmd/swarm/                     # (you'll create)
│   └── main.go
├── internal/                      # (you'll create)
│   ├── config/
│   ├── git/
│   ├── state/
│   ├── repo/
│   ├── worktree/
│   ├── tmux/
│   └── safety/
└── test/                          # (you'll create)
    ├── fixtures/
    └── integration/
```

---

## Final Thoughts

You have everything you need to build Swarm:

✅ **Complete architecture** designed with simplicity in mind
✅ **Detailed implementation plans** with step-by-step instructions
✅ **Module specifications** with clear contracts
✅ **Testing strategy** with examples
✅ **Build system** ready to use
✅ **Design decisions** documented with rationale

**Philosophy reminder:**
- Build simple, focused modules
- Write tests as you go
- Commit frequently
- Ask questions early
- Iterate and refactor

**You've got this!**

Start with [plans/PHASE-1-FOUNDATION.md](plans/PHASE-1-FOUNDATION.md) Task 1.1 and take it one step at a time.

---

**Questions or issues?** Refer back to this guide and the linked documentation.

**Ready to begin?** → [plans/PHASE-1-FOUNDATION.md](plans/PHASE-1-FOUNDATION.md)
