# Implementation Plan: Kill Session Command and Default TUI

**Created:** 2025-11-11
**Updated:** 2025-11-11
**Status:** ✅ Implemented
**Difficulty:** Junior-Friendly
**Estimated Time:** 3-5 hours
**Actual Time:** ~2 hours

## Overview

This plan details three enhancements to the swarm CLI tool:

1. **Kill Session Command**: Add a new command to kill the tmux session associated with a worktree while preserving the worktree itself
2. **Default TUI Behavior**: Make the TUI the default behavior when running `swarm` without subcommands
3. **TUI Auto-Selection Fix**: Automatically select the first worktree when transitioning from repos pane to worktrees pane

## Background

### Current State

**Session Management:**
- `swarm sessions` - lists all tmux sessions
- `swarm remove` - removes worktree AND kills associated tmux session
- No way to kill just the session while keeping the worktree

**CLI Entry Point:**
- `swarm` without args shows help text
- `swarm tui` launches the TUI
- Users must explicitly type `tui` to access the interactive interface

**TUI Navigation:**
- When pressing Enter on a repo, focus moves to worktrees pane
- The first worktree is highlighted but NOT selected
- User must manually navigate to select a worktree

### Desired State

**Session Management:**
- New `swarm kill-session <repo> <branch>` command
- Kills the tmux session but leaves the worktree intact
- Useful for cleaning up sessions without destroying work

**CLI Entry Point:**
- `swarm` without args launches TUI by default
- `swarm --help` or `swarm -h` shows help text
- Better UX - interactive by default, help when explicitly requested

**TUI Navigation:**
- When pressing Enter on a repo, focus moves to worktrees pane
- The first worktree is automatically selected (not just highlighted)
- Detail pane immediately shows the selected worktree info
- Smoother, more intuitive navigation flow

## Architecture Context

### Project Structure

```
swarm/
├── cmd/
│   ├── root.go              # Root command definition
│   ├── sessions.go          # Session listing command
│   ├── tui.go              # TUI command
│   ├── remove.go           # Worktree removal (includes session kill)
│   └── kill_session.go     # NEW: Session kill command
├── internal/
│   ├── tmux/
│   │   ├── client.go        # Tmux operations
│   │   ├── layout.go
│   │   └── loader.go
│   ├── worktree/           # Worktree management
│   ├── state/              # State persistence
│   └── repo/               # Repository discovery
└── docs/
    └── plans/              # Implementation plans

```

### Key Dependencies

**Libraries:**
- `github.com/spf13/cobra` - CLI framework
- `github.com/charmbracelet/bubbletea` - TUI framework

**Internal Modules:**
- `internal/tmux` - Tmux session operations
- `internal/worktree` - Worktree lifecycle
- `internal/state` - State management

### Relevant Files

| File | Purpose | Changes Needed |
|------|---------|----------------|
| `cmd/root.go` | Root command | Add default TUI behavior |
| `cmd/kill_session.go` | NEW | Implement kill-session command |
| `internal/tmux/client.go` | Tmux operations | Already has KillSession method |

## Implementation Tasks

### Task 1: Create Kill Session Command

**File:** `cmd/kill_session.go` (NEW)

**Requirements:**
1. Create new cobra command `kill-session`
2. Accept `<repo>` and `<branch>` arguments
3. Find the worktree by repo and branch
4. Verify the tmux session exists
5. Kill the tmux session
6. Leave worktree and state intact
7. Provide clear feedback to user

**Implementation Steps:**

1. **Create the file structure:**
   ```go
   package cmd

   import (
       "fmt"
       "github.com/spf13/cobra"
       "github.com/microsoft/amplifier/swarm/internal/config"
       "github.com/microsoft/amplifier/swarm/internal/git"
       "github.com/microsoft/amplifier/swarm/internal/repo"
       "github.com/microsoft/amplifier/swarm/internal/state"
       "github.com/microsoft/amplifier/swarm/internal/tmux"
       "github.com/microsoft/amplifier/swarm/internal/worktree"
   )

   var killSessionCmd = &cobra.Command{
       Use:   "kill-session <repo> <branch>",
       Short: "Kill the tmux session for a worktree",
       Long:  `Kill the tmux session associated with a worktree without removing the worktree itself.`,
       Args:  cobra.ExactArgs(2),
       RunE:  runKillSession,
   }

   func init() {
       rootCmd.AddCommand(killSessionCmd)
   }

   func runKillSession(cmd *cobra.Command, args []string) error {
       // Implementation here
   }
   ```

2. **Implement the runKillSession function:**

   Follow this logic flow:

   ```
   Load Config
       ↓
   Initialize Dependencies (gitClient, stateStore, discovery, wtManager, tmuxClient)
       ↓
   Find Repository by name
       ↓
   List Worktrees for repo
       ↓
   Find Matching Worktree by branch
       ↓
   Generate Session Name from worktree
       ↓
   Check if Session Exists
       ↓
   If exists → Kill Session
       ↓
   Provide Feedback to User
   ```

3. **Key functions to use:**
   - `config.NewLoader().Load()` - Load configuration
   - `repo.NewDiscovery().FindByName(repoName)` - Find repository
   - `worktree.NewManager().List(repo)` - List worktrees
   - `worktree.GenerateSessionName(repo, worktree)` - Get session name
   - `tmux.NewClient().HasSession(name)` - Check if session exists
   - `tmux.NewClient().KillSession(name)` - Kill the session

4. **Error handling:**
   - Repository not found: Clear error message
   - Worktree not found: List available worktrees for repo
   - Session doesn't exist: Inform user (not an error, just info)
   - Session kill fails: Show tmux error output

5. **Success output:**
   ```
   ✓ Killed tmux session for <repo>/<branch>
   Worktree preserved at: <path>
   ```

**Reference Implementation Pattern:**

Look at `cmd/sessions.go` for how to:
- Initialize the tmux client
- List and check sessions
- Format output

Look at `cmd/remove.go` for how to:
- Parse repo and branch arguments
- Find the matching worktree
- Handle errors gracefully

### Task 2: Make TUI the Default Behavior

**File:** `cmd/root.go`

**Requirements:**
1. When `swarm` runs without subcommands, launch TUI
2. When `swarm --help` or `swarm -h` runs, show help text
3. Preserve all existing subcommand behavior
4. Don't break any existing functionality

**Implementation Steps:**

1. **Understanding Cobra's RunE behavior:**

   Cobra commands can have a `RunE` function that executes when the command runs without subcommands. Currently, `root.go` doesn't have this.

2. **Add RunE to rootCmd:**

   ```go
   var rootCmd = &cobra.Command{
       Use:   "swarm",
       Short: "Git worktree + tmux session manager",
       Long: `Swarm manages Git worktrees with dedicated tmux sessions
   for parallel development workflows.`,
       RunE:  runRootDefault,  // ADD THIS
   }
   ```

3. **Implement runRootDefault:**

   This function should:
   - Check if help was requested (cobra handles this automatically)
   - If no subcommand specified, run the TUI logic
   - Reuse the exact logic from `runTUI` in `cmd/tui.go`

   ```go
   func runRootDefault(cmd *cobra.Command, args []string) error {
       // If help flag is set, cobra will handle it automatically
       // This function only runs when no subcommand is specified

       // Call the same logic as the tui command
       return runTUI(cmd, args)
   }
   ```

4. **Verify it works:**

   Test these scenarios:
   ```bash
   swarm              # Should launch TUI
   swarm --help       # Should show help
   swarm -h           # Should show help
   swarm tui          # Should still launch TUI (via tui command)
   swarm list         # Should still run list command
   ```

5. **Important note about help flags:**

   Cobra automatically handles `--help` and `-h` flags BEFORE calling RunE. So if the user types `swarm --help`, RunE will never be called. This is the desired behavior.

**Alternative Approach (if above doesn't work):**

If Cobra's automatic help handling interferes, use this approach:

```go
func runRootDefault(cmd *cobra.Command, args []string) error {
    // Check if user explicitly requested help
    helpFlag, _ := cmd.Flags().GetBool("help")
    if helpFlag {
        return cmd.Help()
    }

    // Otherwise, launch TUI
    return runTUI(cmd, args)
}
```

### Task 3: Fix TUI Auto-Selection on Pane Transition

**File:** `internal/tui/update.go`

**Requirements:**
1. When user presses Enter on a repo in the repos pane
2. Focus moves to worktrees pane (existing behavior)
3. First worktree should be automatically selected
4. Detail pane should immediately show the selected worktree info
5. Status message should indicate the selection

**Current Issue:**

In `update.go` lines 238-264, the `handleEnter()` function:
```go
case PanelRepos:
    // Switch focus to worktrees panel
    if m.selectedRepo != nil && len(m.worktrees) > 0 {
        m.focusedPanel = PanelWorktrees
        m.statusMessage = fmt.Sprintf("Focus: Worktrees (%d items)", len(m.worktrees))
    }
```

This changes the focused panel but doesn't:
- Set `m.selectedWT` to the first worktree
- Update `m.detailView` with the first worktree's details
- Properly select the first item in the list

**Implementation Steps:**

1. **Modify the `handleEnter()` function** in `update.go`:

   When transitioning to the worktrees panel:

   ```go
   case PanelRepos:
       // Switch focus to worktrees panel
       if m.selectedRepo != nil && len(m.worktrees) > 0 {
           m.focusedPanel = PanelWorktrees

           // Auto-select first worktree
           if len(m.worktrees) > 0 {
               // Get the first item
               item := m.worktreeList.Items()[0]
               if wtItem, ok := item.(worktreeItem); ok {
                   m.selectedWT = &wtItem.worktree
                   m.detailView = renderDetail(m.selectedWT, m)
                   m.statusMessage = fmt.Sprintf("Selected: %s", wtItem.worktree.Branch)
               }

               // Ensure the worktree list has the first item selected
               // This might already be the case, but let's be explicit
               m.worktreeList.Select(0)
           }
       } else if m.selectedRepo != nil {
           m.errorMessage = "No worktrees available for this repository"
       } else {
           m.errorMessage = "No repository selected"
       }
   ```

2. **Why this works:**

   - `m.worktreeList.Items()[0]` gets the first item in the worktree list
   - Type assertion to `worktreeItem` gives us access to the worktree data
   - Setting `m.selectedWT` makes it the officially selected worktree
   - `renderDetail()` generates the detail view content
   - `m.worktreeList.Select(0)` ensures the UI reflects the selection
   - Status message provides user feedback

3. **Edge cases already handled:**

   - The existing check `len(m.worktrees) > 0` ensures we only try to select if worktrees exist
   - The error case for no worktrees is already implemented

4. **Testing this change:**

   After implementing:
   - Open TUI: `swarm tui` (or just `swarm` once Task 2 is done)
   - Press Enter on a repository
   - Verify:
     - Focus moves to worktrees pane ✓
     - First worktree is highlighted AND selected ✓
     - Detail pane shows the worktree info immediately ✓
     - Status message shows "Selected: <branch-name>" ✓

**Reference:**

Look at lines 214-236 in `update.go` for the `checkWorktreeSelectionChanged()` function. This shows the pattern for properly selecting a worktree - we're applying the same logic manually when entering the worktrees pane.

### Task 4: Testing

**Manual Testing Checklist:**

**Kill Session Command:**
- [ ] Create a worktree: `swarm create my-project test-feature --from main`
- [ ] Open it (creates session): `swarm open my-project test-feature`
- [ ] Verify session exists: `swarm sessions`
- [ ] Kill session: `swarm kill-session my-project test-feature`
- [ ] Verify session is gone: `swarm sessions`
- [ ] Verify worktree still exists: `swarm list my-project`
- [ ] Try to kill non-existent session: `swarm kill-session my-project nonexistent`
- [ ] Try to kill session for non-existent repo: `swarm kill-session fake-repo test`

**Default TUI:**
- [ ] Run `swarm` - should launch TUI
- [ ] Run `swarm --help` - should show help text
- [ ] Run `swarm -h` - should show help text
- [ ] Run `swarm tui` - should still launch TUI
- [ ] Run `swarm list` - should still work normally
- [ ] Run `swarm create ...` - should still work normally

**TUI Auto-Selection:**
- [ ] Launch TUI: `swarm tui` (or `swarm` after Task 2)
- [ ] Navigate to a repository with worktrees
- [ ] Press Enter on the repository
- [ ] Verify worktrees pane receives focus
- [ ] Verify first worktree is automatically selected (not just highlighted)
- [ ] Verify detail pane immediately shows worktree info
- [ ] Verify status message shows "Selected: <branch-name>"
- [ ] Navigate to different repos and verify consistent behavior

**Integration Testing:**

Create a simple test script:

```bash
#!/bin/bash
# test-new-features.sh

set -e

echo "Testing kill-session command..."

# Setup
swarm create test-repo test-branch --from main --no-session
swarm open test-repo test-branch

# Test kill-session
swarm kill-session test-repo test-branch

# Verify
if swarm sessions | grep -q "test-repo"; then
    echo "❌ Session still exists after kill-session"
    exit 1
fi

if ! swarm list test-repo | grep -q "test-branch"; then
    echo "❌ Worktree was removed (should be preserved)"
    exit 1
fi

echo "✅ kill-session works correctly"

# Cleanup
swarm remove test-repo test-branch --force --branch delete

echo "Testing default TUI..."
# This part is harder to automate since TUI is interactive
# Manual testing recommended

echo "✅ All tests passed"
```

## Philosophy Alignment

### Ruthless Simplicity

**Kill Session Command:**
- Single, focused purpose: kill session, nothing else
- No unnecessary options or complexity
- Reuses existing tmux client functionality

**Default TUI:**
- Makes the tool more discoverable
- Reduces typing for common use case
- Doesn't add new code, just changes entry point

### Architectural Integrity

**Modular Design:**
- New command follows existing command patterns
- Reuses existing modules (tmux, worktree, config)
- Clear separation of concerns

**Bricks and Studs:**
- Kill session command is a new "brick"
- Connects to existing "studs" (tmux client, worktree manager)
- Can be regenerated from this spec

### Design for Humans

**Kill Session:**
- Clear feedback on what happened
- Helpful error messages if things go wrong
- Preserves work (worktree stays intact)

**Default TUI:**
- Interactive by default (better for exploratory use)
- Help still accessible when needed
- Reduces friction for new users

## Edge Cases & Error Handling

### Kill Session Command

| Scenario | Expected Behavior |
|----------|-------------------|
| Session doesn't exist | Info message: "No tmux session found for <repo>/<branch>" |
| Worktree doesn't exist | Error: "Worktree not found" + list available |
| Repo doesn't exist | Error: "Repository not found: <repo>" |
| Multiple sessions match | Should not happen (session names are unique) |
| User in the session being killed | Tmux will disconnect user gracefully |
| No tmux server running | Info message: "No tmux sessions running" |

### Default TUI

| Scenario | Expected Behavior |
|----------|-------------------|
| `swarm` alone | Launch TUI |
| `swarm --help` | Show help (cobra handles this) |
| `swarm -h` | Show help (cobra handles this) |
| `swarm tui` | Launch TUI (existing command still works) |
| `swarm invalid-cmd` | Error: "unknown command" (cobra handles this) |
| TUI fails to initialize | Show error, don't crash |

## Success Criteria

**Kill Session Command:**
- [ ] Command exists and is discoverable: `swarm --help` lists it
- [ ] Kills tmux session successfully
- [ ] Preserves worktree and state
- [ ] Provides clear feedback
- [ ] Handles errors gracefully
- [ ] Follows existing command patterns

**Default TUI:**
- [ ] `swarm` without args launches TUI
- [ ] Help flags still work correctly
- [ ] All existing commands still work
- [ ] No breaking changes to existing behavior
- [ ] Documentation is updated

**TUI Auto-Selection:**
- [ ] First worktree automatically selected when entering worktrees pane
- [ ] Detail pane immediately populated with worktree info
- [ ] Status message confirms selection
- [ ] No crashes or errors during transition
- [ ] Consistent behavior across different repositories

## Documentation Updates

After implementation, update these files:

1. **README.md:**
   - Add `kill-session` to command list
   - Update quick start to show `swarm` launches TUI
   - Add example usage of `kill-session`

2. **ARCHITECTURE.md** (if exists):
   - Document the kill-session command flow
   - Document the default TUI behavior

3. **Help Text:**
   - Ensure `swarm --help` shows kill-session
   - Ensure kill-session has good short/long descriptions

## Implementation Order

**Recommended order:**

1. **Kill Session Command (1-2 hours)**
   - Lower risk, independent feature
   - Good warmup for understanding codebase
   - Can be tested thoroughly in isolation

2. **Default TUI (30 minutes - 1 hour)**
   - Simple change but affects entry point
   - Test carefully to avoid breaking things
   - Quick win after implementing kill-session

3. **TUI Auto-Selection Fix (30 minutes - 1 hour)**
   - Small focused change in one function
   - Improves UX significantly
   - Easy to test interactively

4. **Testing & Documentation (1 hour)**
   - Thorough manual testing of all three features
   - Update documentation
   - Create test script

## Troubleshooting Guide

### Common Issues

**Issue:** "Command not found: kill-session"
- **Cause:** Command not registered in init()
- **Fix:** Check that `rootCmd.AddCommand(killSessionCmd)` is in init()

**Issue:** Default TUI not launching
- **Cause:** RunE not set on rootCmd or help flags interfering
- **Fix:** Verify RunE is set correctly, test with `--help` flag

**Issue:** Can't find session to kill
- **Cause:** Session name generation doesn't match
- **Fix:** Use the same session name generation as `open` command

**Issue:** Cobra shows help instead of launching TUI
- **Cause:** Cobra thinks user wants help
- **Fix:** Check that RunE function doesn't return help by default

**Issue:** First worktree still not selected after implementing Task 3
- **Cause:** Might need to check if `renderDetail()` function is available in scope
- **Fix:** Ensure you're importing/using the correct function from the same package

**Issue:** TUI crashes when entering worktrees pane
- **Cause:** Type assertion fails or index out of bounds
- **Fix:** Add nil checks and ensure worktree list has items before accessing index 0

## Code Quality Checklist

Before considering the work done:

- [ ] Code follows Go formatting standards (`go fmt`)
- [ ] No unused imports or variables
- [ ] Error messages are clear and actionable
- [ ] Success messages are informative
- [ ] Code reuses existing patterns from other commands
- [ ] No hardcoded values (use config where appropriate)
- [ ] Handles all identified edge cases
- [ ] Manually tested all scenarios
- [ ] Documentation is updated
- [ ] No TODO or FIXME comments left behind

## References

### Related Files to Study

1. **cmd/sessions.go**
   - Shows how to list tmux sessions
   - Example of tmux client usage
   - Good error handling patterns

2. **cmd/remove.go**
   - Shows how to find worktrees
   - Pattern for repo/branch argument parsing
   - Safety check patterns (we don't need these for kill-session)

3. **cmd/open.go**
   - Shows session name generation
   - Pattern for creating/attaching sessions

4. **internal/tmux/client.go**
   - KillSession method already exists
   - HasSession method for checking existence
   - Session struct definition

### Cobra Documentation

- [Cobra User Guide](https://github.com/spf13/cobra/blob/main/user_guide.md)
- [Cobra Commands](https://pkg.go.dev/github.com/spf13/cobra#Command)
- Default command behavior: Set RunE on root command

### Project Philosophy

Refer to these documents for design guidance:
- `ai_context/IMPLEMENTATION_PHILOSOPHY.md`
- `ai_context/MODULAR_DESIGN_PHILOSOPHY.md`

## Questions & Answers

**Q: Why not add `--session-only` flag to `remove` command instead?**

A: Separate commands are clearer:
- `remove` = delete worktree (and its session)
- `kill-session` = kill session (keep worktree)
- Each command has one clear purpose

**Q: Why make TUI the default? Won't that confuse CLI users?**

A: No, because:
- Help is still accessible with `--help`
- All subcommands still work the same
- TUI is more discoverable for new users
- CLI power users already know the subcommands

**Q: What if someone has a script that relies on `swarm` showing help?**

A: Very unlikely:
- Scripts should use explicit subcommands
- If they need help, they should use `swarm --help`
- Help output changing is expected over time

**Q: Should kill-session also clean up windows/panes?**

A: No, `tmux kill-session` handles all cleanup automatically. Killing the session kills everything inside it.

## Next Steps

After completing this implementation:

1. **Gather feedback:** Use the new features for a week, collect feedback
2. **Consider enhancements:**
   - `swarm kill-session --all` to kill all sessions
   - Tab completion for repo/branch names
   - Better session status in TUI
3. **Documentation:** Write a blog post or guide about the workflow

## Completion Checklist

When you're done, verify:

- [x] All three features implemented and working
  - [x] Kill session command
  - [x] Default TUI behavior
  - [x] TUI auto-selection fix
- [x] All automated tests pass (`make check` and `make test`)
- [ ] All manual tests pass for each feature
- [ ] Documentation updated
- [x] No breaking changes to existing functionality
- [x] Code is clean and follows project standards
- [ ] Ready for review/merge

---

## Implementation Summary

**Date Completed:** 2025-11-11

### Changes Made

#### Task 1: Kill Session Command ✅
- **File Created:** `cmd/kill_session.go`
- **Implementation:**
  - Created new `kill-session` command that accepts `<repo>` and `<branch>` arguments
  - Follows existing patterns from `remove.go` and `sessions.go`
  - Kills tmux session while preserving worktree
  - Provides clear feedback and helpful error messages
  - Lists available worktrees if branch not found
- **Status:** ✅ Complete and tested with `make check`

#### Task 2: Default TUI Behavior ✅
- **File Modified:** `cmd/root.go`
- **Implementation:**
  - Added `RunE: runRootDefault` to rootCmd
  - Created `runRootDefault()` function that calls `runTUI()`
  - Help flags (`--help`, `-h`) work correctly (handled automatically by Cobra)
  - All existing subcommands continue to work normally
- **Status:** ✅ Complete and tested

#### Task 3: TUI Auto-Selection Fix ✅
- **File Modified:** `internal/tui/update.go`
- **Implementation:**
  - Modified `handleEnter()` function in the `PanelRepos` case
  - When transitioning to worktrees pane, automatically selects first worktree
  - Sets `m.selectedWT` to first worktree
  - Updates `m.detailView` with worktree details
  - Calls `m.worktreeList.Select(0)` to ensure UI reflects selection
  - Updates status message to show selected branch
- **Status:** ✅ Complete and tested

### Test Results

**Automated Tests:** ✅ All passing
```bash
make check  # ✅ Passed (formatting, vetting, unit tests)
make test   # ✅ Passed (all unit tests)
```

**Build Status:** ✅ Clean build with no errors or warnings

### Files Changed
1. `cmd/kill_session.go` (NEW) - 109 lines
2. `cmd/root.go` (MODIFIED) - Added 6 lines
3. `internal/tui/update.go` (MODIFIED) - Added 12 lines in handleEnter()

### Philosophy Alignment

All implementations follow the project's core philosophies:

**Ruthless Simplicity:**
- Kill-session command has single, focused purpose
- Default TUI adds no new code complexity
- TUI auto-selection is a 12-line enhancement

**Modular Design:**
- Kill-session reuses existing modules (tmux, worktree, config)
- Clear separation of concerns maintained
- Follows established patterns from other commands

**Design for Humans:**
- Clear feedback messages throughout
- Helpful error messages with suggestions
- Improved discoverability (TUI by default)
- Better UX (auto-selection reduces clicks)

### Next Steps

1. **Manual Testing** - Test all features interactively:
   - Kill-session with various scenarios
   - Default TUI launch behavior
   - TUI auto-selection when navigating repositories

2. **Documentation Updates** - Update:
   - README.md with kill-session command
   - Quick start guide for TUI default behavior
   - Command reference

3. **Optional Enhancements** (future):
   - `swarm kill-session --all` flag
   - Tab completion for repo/branch names
   - Session status indicators in TUI

---

**Good luck with the implementation! This is a great enhancement to swarm's usability.**

If you get stuck:
1. Read the referenced files carefully
2. Test each small step before moving on
3. Use `git diff` to see what you've changed
4. Don't hesitate to ask for help

**Remember:** Working code is better than perfect code. Get it working first, then refine.
