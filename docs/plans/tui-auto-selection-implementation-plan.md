# TUI Auto-Selection Behavior Implementation Plan

**Document Version:** 1.0
**Created:** 2025-11-11
**Completed:** 2025-11-11
**Target Directory:** `swarm/internal/tui/`
**Estimated Effort:** 4-6 hours for junior developer
**Actual Time:** ~2 hours with AI assistance
**Status:** ✅ COMPLETED

---

## Implementation Summary

All planned features have been successfully implemented and tested:

1. ✅ **Auto-update on repo navigation** - Worktrees now load automatically when cursor moves in repos list
2. ✅ **Enter key changes focus** - Pressing Enter in repos panel now switches focus to worktrees panel
3. ✅ **Clipboard copy functionality** - Added 'c' key for path copy and 'b' key for branch name copy
4. ✅ **Context-sensitive status bar** - Status bar now shows appropriate shortcuts based on focused panel
5. ✅ **Updated help dialog** - Help text now documents all new features and shortcuts

### Code Quality
- ✅ All checks pass (`make check`)
- ✅ All tests pass (`make test`)
- ✅ Binary builds successfully (`make build`)
- ✅ No linting errors or warnings
- ✅ Follows project coding standards

### Files Modified
- `internal/tui/update.go` - Added auto-load logic and copy handlers
- `internal/tui/actions.go` - Added clipboard functionality and updated help
- `internal/tui/view.go` - Updated status bar with context-sensitive shortcuts
- `go.mod` & `go.sum` - Added clipboard dependency

### Post-Implementation Corrections

After initial implementation, two issues were discovered and fixed:

#### Issue 1: Initial Repo Not Loading Worktrees on Startup ✅ FIXED
**Problem**: When TUI starts, the first repo appears selected but its worktrees don't load until user moves cursor.

**Root Cause**: The `checkRepoSelectionChanged` function only triggers on keyboard input. On initial load, repos populate with index 0 selected, but no key was pressed.

**Solution**: Modified `reposLoadedMsg` handler in `internal/tui/update.go` (lines 46-50) to explicitly load worktrees for first repo:
```go
// Auto-load worktrees for first repo if repos exist
if len(msg.repos) > 0 {
    m.selectedRepo = &msg.repos[0]
    return m, loadWorktreesCmd(m.wtManager, m.orphanDetector, m.selectedRepo)
}
```

#### Issue 2: Auto-Select Not Working in Worktrees Panel ✅ FIXED
**Problem**: Moving cursor in worktrees list doesn't update `selectedWT`, requiring Enter press before copy operations work.

**Root Cause**: Worktrees panel handler didn't implement selection change detection like repos panel.

**Solution**:
1. Added `checkWorktreeSelectionChanged` function in `internal/tui/update.go` (lines 205-227) mirroring repos panel pattern
2. Modified worktrees panel handler (lines 172-175) to track selection changes:
```go
case PanelWorktrees:
    previousIndex := m.worktreeList.Index()
    m.worktreeList, cmd = m.worktreeList.Update(msg)
    return m.checkWorktreeSelectionChanged(previousIndex, cmd)
```

**Result**: Both panels now have consistent auto-selection behavior, enabling immediate clipboard operations without Enter.

---

## Overview

This plan details the implementation of improved TUI navigation behavior for the Swarm worktree manager. The changes make the interface more responsive by automatically updating content on cursor movement rather than requiring explicit Enter key presses.

### Current Behavior (Before Changes)

1. **Repo Selection**: User navigates repos list → presses Enter → worktrees load
2. **Focus Management**: Tab cycles through panels (Repos → Worktrees → Details)
3. **No Copy Features**: No clipboard copy functionality exists

### Target Behavior (After Changes)

1. **Auto-Update on Movement**: Moving cursor in repos list → automatically loads worktrees for that repo
2. **Enter Changes Focus**: Pressing Enter on a repo → switches focus to Worktrees panel
3. **Copy Functionality**:
   - In Repos panel: Option to copy repo path (keyboard shortcut 'c')
   - In Worktrees panel: Options to copy worktree path (keyboard shortcut 'c') and branch name (keyboard shortcut 'b')

---

## Prerequisites

### Understanding Required

Before starting implementation, ensure you understand:

1. **Bubble Tea Framework Basics**:
   - The Elm Architecture pattern (Model-View-Update)
   - Message passing for asynchronous operations
   - How keyboard input flows through the system

2. **Current Codebase Structure**:
   - `model.go`: State management and data structures
   - `update.go`: Message handling and state updates
   - `view.go`: UI rendering
   - `actions.go`: Asynchronous command execution
   - `items.go`: List item implementations

3. **Key Concepts**:
   - Focus management via `focusedPanel` enum
   - List navigation handled by `bubbles/list` component
   - Async operations return `tea.Cmd` functions

### Environment Setup

```bash
# Ensure you're in the swarm directory
cd /Users/danny/amplifier/ai_working/swarm

# Install dependencies
go mod download

# Verify build works
make build

# Run tests to ensure baseline functionality
make test
```

---

## Architecture Context

### Current TUI Structure

The TUI uses the Bubble Tea framework with the following flow:

```
User Input (KeyMsg)
    ↓
Update() function in update.go
    ↓
handleKeyMsg() dispatches to specific handlers
    ↓
Handlers modify Model and return tea.Cmd
    ↓
Commands execute async (load repos, load worktrees, etc.)
    ↓
Commands return messages (reposLoadedMsg, worktreesLoadedMsg, etc.)
    ↓
Update() processes messages and updates Model
    ↓
View() renders current Model state
```

### Key Files and Their Roles

| File | Purpose | Lines of Code |
|------|---------|---------------|
| `model.go` | State structure, initialization | ~137 lines |
| `update.go` | Message handling, keyboard input | ~271 lines |
| `view.go` | UI rendering, styling | ~190 lines |
| `actions.go` | Async command execution | ~369 lines |
| `items.go` | List item implementations | ~50-100 lines |

---

## Implementation Plan

### Phase 1: Auto-Update on Repo Navigation

**Goal**: Automatically load worktrees when cursor moves in repos list

#### Step 1.1: Understand Current Repo Selection

**File**: `update.go`, lines 166-189

Current behavior in `handleEnter()`:
```go
case PanelRepos:
    // Load worktrees for selected repo
    if item := m.repoList.SelectedItem(); item != nil {
        repoItem := item.(repoItem)
        m.selectedRepo = &repoItem.repo
        m.statusMessage = fmt.Sprintf("Loading worktrees for %s...", m.selectedRepo.Name)
        return m, loadWorktreesCmd(m.wtManager, m.orphanDetector, m.selectedRepo)
    }
```

**Key Insight**: The `loadWorktreesCmd()` call is what triggers worktree loading. We need to call this when cursor moves, not just on Enter.

#### Step 1.2: Add Auto-Load Logic

**File to Modify**: `update.go`

**Location**: In `handleKeyMsg()` function, around lines 151-164

**Current Code Structure**:
```go
// Delegate to focused list
var cmd tea.Cmd
switch m.focusedPanel {
case PanelRepos:
    m.repoList, cmd = m.repoList.Update(msg)
    return m, cmd

case PanelWorktrees:
    m.worktreeList, cmd = m.worktreeList.Update(msg)
    return m, cmd
}
```

**Changes Needed**:

Add a new helper function to check if repo selection changed:

```go
// Add this new function at the end of update.go (around line 271)

// checkRepoSelectionChanged checks if the selected repo has changed and loads worktrees
func (m Model) checkRepoSelectionChanged(previousSelectedIndex int, cmd tea.Cmd) (Model, tea.Cmd) {
    // Only check if we're in the repos panel
    if m.focusedPanel != PanelRepos {
        return m, cmd
    }

    // Get current selected index
    currentIndex := m.repoList.Index()

    // If selection changed, load worktrees for new repo
    if currentIndex != previousSelectedIndex && currentIndex >= 0 && currentIndex < len(m.repos) {
        item := m.repoList.SelectedItem()
        if item != nil {
            repoItem := item.(repoItem)
            m.selectedRepo = &repoItem.repo
            m.statusMessage = fmt.Sprintf("Loading worktrees for %s...", m.selectedRepo.Name)

            // Return batch command: original cmd + load worktrees
            return m, tea.Batch(cmd, loadWorktreesCmd(m.wtManager, m.orphanDetector, m.selectedRepo))
        }
    }

    return m, cmd
}
```

**Modify the delegation logic** in `handleKeyMsg()`:

```go
// Replace the existing delegation code (lines 151-164) with:

// Delegate to focused list and check for repo selection changes
var cmd tea.Cmd
switch m.focusedPanel {
case PanelRepos:
    previousIndex := m.repoList.Index()
    m.repoList, cmd = m.repoList.Update(msg)
    // Check if repo selection changed after update
    return m.checkRepoSelectionChanged(previousIndex, cmd)

case PanelWorktrees:
    m.worktreeList, cmd = m.worktreeList.Update(msg)
    return m, cmd
}
```

**Why This Works**:
- Capture the index BEFORE updating the list
- Let the list component handle the navigation
- Compare old vs new index to detect changes
- If changed, batch the worktree load command with any existing command
- Uses `tea.Batch()` to execute multiple commands

#### Step 1.3: Test Auto-Load

**Manual Testing Steps**:

```bash
# Build the TUI
cd /Users/danny/amplifier/ai_working/swarm
go build -o bin/swarm ./cmd/swarm

# Run the TUI
./bin/swarm tui

# Test Cases:
# 1. Use arrow keys to move between repos
#    Expected: Worktrees panel updates automatically
# 2. Move quickly through repos
#    Expected: Updates should queue and process
# 3. Filter repos and move through filtered list
#    Expected: Auto-load still works
```

**Common Issues to Watch For**:
- Race conditions if moving too fast (commands queue up)
- Memory leaks if old commands don't complete
- UI lag if worktree loading is slow

**Debugging Tips**:
```go
// Add logging to understand behavior
fmt.Fprintf(os.Stderr, "Previous index: %d, Current index: %d\n", previousIndex, currentIndex)
```

---

### Phase 2: Enter Key Changes Focus

**Goal**: When pressing Enter on a repo, switch focus to worktrees panel instead of loading worktrees (since they auto-load now)

#### Step 2.1: Modify handleEnter Behavior

**File**: `update.go`, lines 166-189

**Current Code**:
```go
func (m Model) handleEnter() (tea.Model, tea.Cmd) {
    m.errorMessage = ""

    switch m.focusedPanel {
    case PanelRepos:
        // Load worktrees for selected repo
        if item := m.repoList.SelectedItem(); item != nil {
            repoItem := item.(repoItem)
            m.selectedRepo = &repoItem.repo
            m.statusMessage = fmt.Sprintf("Loading worktrees for %s...", m.selectedRepo.Name)
            return m, loadWorktreesCmd(m.wtManager, m.orphanDetector, m.selectedRepo)
        }

    case PanelWorktrees:
        // Select worktree for detail view
        if item := m.worktreeList.SelectedItem(); item != nil {
            wtItem := item.(worktreeItem)
            m.selectedWT = &wtItem.worktree
            m.detailView = renderDetail(m.selectedWT, m)
        }
    }

    return m, nil
}
```

**Replace with**:
```go
func (m Model) handleEnter() (tea.Model, tea.Cmd) {
    m.errorMessage = ""

    switch m.focusedPanel {
    case PanelRepos:
        // Switch focus to worktrees panel
        // (Worktrees already loaded by auto-update)
        if m.selectedRepo != nil && len(m.worktrees) > 0 {
            m.focusedPanel = PanelWorktrees
            m.statusMessage = fmt.Sprintf("Focus: Worktrees (%d items)", len(m.worktrees))
        } else if m.selectedRepo != nil {
            m.errorMessage = "No worktrees available for this repository"
        } else {
            m.errorMessage = "No repository selected"
        }

    case PanelWorktrees:
        // Select worktree for detail view (unchanged)
        if item := m.worktreeList.SelectedItem(); item != nil {
            wtItem := item.(worktreeItem)
            m.selectedWT = &wtItem.worktree
            m.detailView = renderDetail(m.selectedWT, m)
            m.statusMessage = fmt.Sprintf("Selected: %s", wtItem.worktree.Branch)
        }
    }

    return m, nil
}
```

**Key Changes**:
1. PanelRepos case: Changes focus instead of loading worktrees
2. Added validation: Only change focus if worktrees exist
3. Added helpful error messages for edge cases
4. PanelWorktrees case: Unchanged (already correct behavior)

#### Step 2.2: Test Focus Changes

**Manual Testing**:

```bash
./bin/swarm tui

# Test Cases:
# 1. Navigate to a repo with worktrees
#    - Press Enter
#    - Expected: Focus moves to worktrees panel (blue border)
#
# 2. Navigate to a repo without worktrees
#    - Press Enter
#    - Expected: Error message shown
#
# 3. From worktrees panel, press Tab
#    - Expected: Focus moves to details panel
#
# 4. Press Shift+Tab
#    - Expected: Focus moves backward through panels
```

---

### Phase 3: Add Copy Functionality

**Goal**: Add keyboard shortcuts to copy paths and branch names to clipboard

#### Step 3.1: Add Clipboard Dependency

**File**: `go.mod`

Add the clipboard library:
```bash
cd /Users/danny/amplifier/ai_working/swarm
go get github.com/atotto/clipboard
```

This adds a cross-platform clipboard library that works on macOS, Linux, and Windows.

#### Step 3.2: Implement Copy Helper

**File**: `actions.go` (add at end, around line 369)

```go
import (
    // ... existing imports ...
    "github.com/atotto/clipboard"
)

// copyToClipboard copies text to clipboard and returns a message
func copyToClipboard(text string, label string) tea.Cmd {
    return func() tea.Msg {
        err := clipboard.WriteAll(text)
        if err != nil {
            return errorMsg{fmt.Errorf("failed to copy %s: %w", label, err)}
        }
        return clipboardCopiedMsg{
            text:  text,
            label: label,
        }
    }
}

// clipboardCopiedMsg indicates successful clipboard copy
type clipboardCopiedMsg struct {
    text  string
    label string
}
```

#### Step 3.3: Add Copy Handlers

**File**: `actions.go` (add after copyToClipboard function)

```go
// handleCopyRepoPath copies the current repo path to clipboard
func (m Model) handleCopyRepoPath() (tea.Model, tea.Cmd) {
    if m.selectedRepo == nil {
        m.errorMessage = "No repository selected"
        return m, nil
    }

    m.errorMessage = ""
    return m, copyToClipboard(m.selectedRepo.Path, "repo path")
}

// handleCopyWorktreePath copies the current worktree path to clipboard
func (m Model) handleCopyWorktreePath() (tea.Model, tea.Cmd) {
    if m.selectedWT == nil {
        m.errorMessage = "No worktree selected"
        return m, nil
    }

    m.errorMessage = ""
    return m, copyToClipboard(m.selectedWT.Path, "worktree path")
}

// handleCopyBranchName copies the current worktree branch name to clipboard
func (m Model) handleCopyBranchName() (tea.Model, tea.Cmd) {
    if m.selectedWT == nil {
        m.errorMessage = "No worktree selected"
        return m, nil
    }

    m.errorMessage = ""
    return m, copyToClipboard(m.selectedWT.Branch, "branch name")
}
```

#### Step 3.4: Wire Up Keyboard Shortcuts

**File**: `update.go`, in `handleKeyMsg()` function (around line 116-149)

**Add new cases** after the existing keyboard shortcuts:

```go
case "c":
    return m.handleCopy()

case "b":
    return m.handleCopyBranch()
```

**Add the handler functions** at the end of `update.go`:

```go
// handleCopy handles the 'c' key - copies path based on focused panel
func (m Model) handleCopy() (tea.Model, tea.Cmd) {
    switch m.focusedPanel {
    case PanelRepos:
        return m.handleCopyRepoPath()
    case PanelWorktrees:
        return m.handleCopyWorktreePath()
    default:
        m.errorMessage = "Copy not available in this panel"
        return m, nil
    }
}

// handleCopyBranch handles the 'b' key - copies branch name (worktrees panel only)
func (m Model) handleCopyBranch() (tea.Model, tea.Cmd) {
    if m.focusedPanel != PanelWorktrees {
        m.errorMessage = "Branch copy only available in worktrees panel"
        return m, nil
    }
    return m.handleCopyBranchName()
}
```

#### Step 3.5: Handle Copy Success Message

**File**: `update.go`, in `Update()` function (around line 10-114)

Add a new message case after the other messages (around line 107):

```go
case clipboardCopiedMsg:
    m.statusMessage = fmt.Sprintf("✓ Copied %s to clipboard: %s", msg.label, msg.text)
    m.errorMessage = ""
    return m, nil
```

#### Step 3.6: Update Status Bar with New Shortcuts

**File**: `view.go`, in `renderStatusBar()` function (around line 120-144)

**Current status bar text** (line 126):
```go
keys := "q: quit | tab: switch | enter: select | n: new | o: open | d: delete | r: refresh | ?: help"
```

**Update to include copy shortcuts**:
```go
// Build keys string based on focused panel
var keys string
switch m.focusedPanel {
case PanelRepos:
    keys = "q: quit | tab: switch | enter: focus worktrees | c: copy path | n: new | r: refresh | ?: help"
case PanelWorktrees:
    keys = "q: quit | tab: switch | enter: select | c: copy path | b: copy branch | o: open | d: delete | ?: help"
default:
    keys = "q: quit | tab: switch | ?: help"
}
```

**Why This Matters**: Contextual help shows users which shortcuts are available in their current panel.

#### Step 3.7: Update Help Dialog

**File**: `actions.go`, in `handleHelp()` function (around line 337-368)

**Update the help message** to include copy functionality:

```go
helpMsg := `Swarm TUI Keyboard Shortcuts:

Navigation:
  Tab       - Switch between panels
  ↑/k       - Move up in list
  ↓/j       - Move down in list
  Enter     - Select/focus (auto-loads worktrees on movement)

Actions:
  n         - Create new worktree
  o         - Open worktree in tmux
  d         - Delete worktree
  p         - Prune orphaned worktrees
  r         - Refresh worktree list

Copy (context-sensitive):
  c         - Copy path (repo path or worktree path)
  b         - Copy branch name (worktrees panel only)

General:
  ?         - Show this help
  q/Ctrl+C  - Quit
`
```

#### Step 3.8: Test Copy Functionality

**Manual Testing**:

```bash
./bin/swarm tui

# Test Cases for Repos Panel:
# 1. Focus on repos panel
#    - Press 'c'
#    - Expected: Status shows "✓ Copied repo path to clipboard: /path/to/repo"
#    - Verify: Paste somewhere to confirm (Cmd+V / Ctrl+V)
#
# 2. Press 'b' in repos panel
#    - Expected: Error "Branch copy only available in worktrees panel"

# Test Cases for Worktrees Panel:
# 1. Tab to worktrees panel
#    - Select a worktree
#    - Press 'c'
#    - Expected: Status shows "✓ Copied worktree path to clipboard: /path/to/worktree"
#    - Verify: Paste the path
#
# 2. Press 'b' in worktrees panel
#    - Expected: Status shows "✓ Copied branch name to clipboard: feature/my-branch"
#    - Verify: Paste the branch name

# Test Error Cases:
# 1. No repo selected + press 'c'
#    - Expected: Error "No repository selected"
#
# 2. No worktree selected + press 'c' or 'b'
#    - Expected: Error "No worktree selected"
```

**Clipboard Verification**:
```bash
# On macOS/Linux terminal:
pbpaste  # macOS
xclip -o # Linux

# Or just Cmd+V / Ctrl+V in any text editor
```

---

## Testing Strategy

### Unit Testing Approach

**File to Create**: `update_test.go`

```go
package tui

import (
    "testing"

    "github.com/charmbracelet/bubbles/list"
    tea "github.com/charmbracelet/bubbletea"
    "github.com/microsoft/amplifier/swarm/internal/repo"
)

func TestRepoSelectionAutoLoad(t *testing.T) {
    // Create test model with mock data
    m := createTestModel()

    // Simulate moving cursor in repos list
    keyMsg := tea.KeyMsg{Type: tea.KeyDown}

    previousIndex := m.repoList.Index()
    m.repoList, _ = m.repoList.Update(keyMsg)
    currentIndex := m.repoList.Index()

    // Verify selection changed
    if currentIndex == previousIndex {
        t.Error("Expected index to change")
    }

    // Verify checkRepoSelectionChanged would trigger load
    newModel, cmd := m.checkRepoSelectionChanged(previousIndex, nil)

    if cmd == nil {
        t.Error("Expected command to load worktrees")
    }

    if newModel.selectedRepo == nil {
        t.Error("Expected repo to be selected")
    }
}

func TestEnterChangesFocusInReposPanel(t *testing.T) {
    m := createTestModel()
    m.focusedPanel = PanelRepos
    m.selectedRepo = &repo.Repo{Name: "test-repo"}
    m.worktrees = []worktree.Worktree{{Branch: "main"}}

    newModel, _ := m.handleEnter()

    if newModel.focusedPanel != PanelWorktrees {
        t.Errorf("Expected focus to be PanelWorktrees, got %v", newModel.focusedPanel)
    }
}

func TestCopyRepoPath(t *testing.T) {
    m := createTestModel()
    m.selectedRepo = &repo.Repo{
        Name: "test-repo",
        Path: "/path/to/repo",
    }

    newModel, cmd := m.handleCopyRepoPath()

    if cmd == nil {
        t.Error("Expected copy command")
    }

    if newModel.errorMessage != "" {
        t.Errorf("Expected no error, got: %s", newModel.errorMessage)
    }

    // Execute command and verify message
    msg := cmd()
    copiedMsg, ok := msg.(clipboardCopiedMsg)
    if !ok {
        t.Error("Expected clipboardCopiedMsg")
    }

    if copiedMsg.text != "/path/to/repo" {
        t.Errorf("Expected path to be copied, got: %s", copiedMsg.text)
    }
}

// Helper to create test model
func createTestModel() Model {
    // Create minimal model for testing
    return Model{
        repos: []repo.Repo{
            {Name: "repo1", Path: "/path/to/repo1"},
            {Name: "repo2", Path: "/path/to/repo2"},
        },
        repoList:     list.New([]list.Item{}, list.NewDefaultDelegate(), 40, 20),
        worktreeList: list.New([]list.Item{}, list.NewDefaultDelegate(), 40, 20),
        focusedPanel: PanelRepos,
    }
}
```

**Run Unit Tests**:
```bash
cd /Users/danny/amplifier/ai_working/swarm/internal/tui
go test -v
```

### Integration Testing

**File to Create**: `integration_test.go`

```go
package tui

import (
    "testing"
    "time"

    tea "github.com/charmbracelet/bubbletea"
)

func TestFullNavigationFlow(t *testing.T) {
    // This tests the full flow: repos → auto-load → focus change → copy

    m := createTestModel()

    // Step 1: Navigate repos (should auto-load)
    downKey := tea.KeyMsg{Type: tea.KeyDown}
    m, cmd := m.Update(downKey)

    // Execute async load command
    if cmd != nil {
        msg := cmd()
        m, _ = m.Update(msg)
    }

    // Step 2: Press Enter (should change focus)
    enterKey := tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'\r'}}
    m, _ = m.Update(enterKey)

    if m.focusedPanel != PanelWorktrees {
        t.Error("Expected focus to change to worktrees")
    }

    // Step 3: Copy worktree path
    copyKey := tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'c'}}
    m, cmd = m.Update(copyKey)

    if cmd == nil {
        t.Error("Expected copy command")
    }
}
```

### Manual Testing Checklist

Create this file: `/Users/danny/amplifier/ai_working/swarm/docs/plans/TESTING_CHECKLIST.md`

```markdown
# TUI Changes Testing Checklist

## Auto-Load on Navigation

- [ ] Arrow keys up/down in repos list triggers worktree load
- [ ] j/k vim keys in repos list triggers worktree load
- [ ] Filtering repos still works with auto-load
- [ ] Fast navigation doesn't cause crashes or race conditions
- [ ] Error handling works if worktree load fails
- [ ] Worktrees panel updates with correct data

## Focus Changes on Enter

- [ ] Enter in repos panel changes focus to worktrees
- [ ] Error message shown if no worktrees exist
- [ ] Error message shown if no repo selected
- [ ] Enter in worktrees panel still shows detail view
- [ ] Tab/Shift+Tab still cycles panels correctly
- [ ] Visual feedback (blue border) shows focused panel

## Copy Functionality

### Repos Panel
- [ ] 'c' copies repo path to clipboard
- [ ] Pasted path is correct and complete
- [ ] Status message confirms copy
- [ ] Error if no repo selected

### Worktrees Panel
- [ ] 'c' copies worktree path to clipboard
- [ ] 'b' copies branch name to clipboard
- [ ] Both paste correctly
- [ ] Status messages confirm copies
- [ ] Errors if no worktree selected

### Status Bar
- [ ] Context-appropriate shortcuts shown
- [ ] Shortcuts change based on focused panel
- [ ] Help text is clear and accurate

### Help Dialog
- [ ] '?' shows updated help text
- [ ] All new shortcuts documented
- [ ] Explanation of auto-load behavior
- [ ] Help dialog dismisses with Esc or OK

## Edge Cases

- [ ] Empty repos list (no repos found)
- [ ] Repo with no worktrees
- [ ] Clipboard unavailable (headless environment)
- [ ] Very long paths (truncation/wrapping)
- [ ] Special characters in branch names
- [ ] Rapid key presses (no crashes)

## Cross-Platform

- [ ] Works on macOS
- [ ] Works on Linux
- [ ] Works on Windows (if applicable)
- [ ] Clipboard works on all platforms

## Regression Testing

- [ ] All existing functionality still works
- [ ] Create worktree (n) still works
- [ ] Open worktree (o) still works
- [ ] Delete worktree (d) still works
- [ ] Refresh (r) still works
- [ ] Prune (p) still works
- [ ] Quit (q) still works
```

---

## Troubleshooting Guide

### Common Issues and Solutions

#### Issue 1: "Too many worktree load requests"

**Symptom**: Worktrees panel flickers or loads multiple times when navigating repos

**Cause**: Auto-load triggering too frequently

**Solution**: Add debouncing logic

```go
// In model.go, add to Model struct:
lastRepoLoadTime time.Time

// In update.go, checkRepoSelectionChanged:
func (m Model) checkRepoSelectionChanged(previousSelectedIndex int, cmd tea.Cmd) (Model, tea.Cmd) {
    if m.focusedPanel != PanelRepos {
        return m, cmd
    }

    currentIndex := m.repoList.Index()

    // Debounce: Don't load if we loaded within last 100ms
    if time.Since(m.lastRepoLoadTime) < 100*time.Millisecond {
        return m, cmd
    }

    if currentIndex != previousSelectedIndex && currentIndex >= 0 && currentIndex < len(m.repos) {
        item := m.repoList.SelectedItem()
        if item != nil {
            repoItem := item.(repoItem)
            m.selectedRepo = &repoItem.repo
            m.lastRepoLoadTime = time.Now()
            m.statusMessage = fmt.Sprintf("Loading worktrees for %s...", m.selectedRepo.Name)

            return m, tea.Batch(cmd, loadWorktreesCmd(m.wtManager, m.orphanDetector, m.selectedRepo))
        }
    }

    return m, cmd
}
```

#### Issue 2: "Clipboard copy fails on Linux"

**Symptom**: Error message "failed to copy: clipboard unavailable"

**Cause**: Linux requires X11/Wayland clipboard tools

**Solution**: Add fallback behavior

```go
func copyToClipboard(text string, label string) tea.Cmd {
    return func() tea.Msg {
        err := clipboard.WriteAll(text)
        if err != nil {
            // Fallback: Just show the text in status for manual copy
            return clipboardFallbackMsg{
                text:  text,
                label: label,
            }
        }
        return clipboardCopiedMsg{
            text:  text,
            label: label,
        }
    }
}

// Add new message type
type clipboardFallbackMsg struct {
    text  string
    label string
}

// In update.go Update() function:
case clipboardFallbackMsg:
    m.statusMessage = fmt.Sprintf("Copy %s: %s (clipboard unavailable, please copy manually)", msg.label, msg.text)
    return m, nil
```

#### Issue 3: "Race condition on fast navigation"

**Symptom**: Selected repo and loaded worktrees don't match

**Cause**: Multiple async commands in flight

**Solution**: Cancel previous load when new one starts

```go
// In model.go, add to Model struct:
currentLoadCmd tea.Cmd

// In update.go:
func (m Model) checkRepoSelectionChanged(previousSelectedIndex int, cmd tea.Cmd) (Model, tea.Cmd) {
    // ... existing checks ...

    if currentIndex != previousSelectedIndex && currentIndex >= 0 && currentIndex < len(m.repos) {
        item := m.repoList.SelectedItem()
        if item != nil {
            repoItem := item.(repoItem)

            // Store repo first, so when command completes, we can verify it's still current
            m.selectedRepo = &repoItem.repo
            m.statusMessage = fmt.Sprintf("Loading worktrees for %s...", m.selectedRepo.Name)

            loadCmd := loadWorktreesCmd(m.wtManager, m.orphanDetector, m.selectedRepo)
            m.currentLoadCmd = loadCmd

            return m, tea.Batch(cmd, loadCmd)
        }
    }

    return m, cmd
}

// In update.go, modify worktreesLoadedMsg case:
case worktreesLoadedMsg:
    // Only update if this load is for the currently selected repo
    if m.selectedRepo != nil && msg.repoName == m.selectedRepo.Name {
        m.worktrees = msg.worktrees
        // ... rest of existing code ...
    }
    return m, nil
```

**Note**: This requires modifying `worktreesLoadedMsg` to include repo name.

#### Issue 4: "Status bar text too long"

**Symptom**: Status bar shortcuts cut off or wrap badly

**Solution**: Shorten shortcuts and use abbreviations

```go
// In view.go, renderStatusBar:
var keys string
switch m.focusedPanel {
case PanelRepos:
    keys = "q:quit | ⇥:switch | ↵:focus | c:copy | n:new | r:refresh | ?:help"
case PanelWorktrees:
    keys = "q:quit | ⇥:switch | ↵:select | c:copy-path | b:copy-branch | o:open | d:del | ?:help"
default:
    keys = "q:quit | ⇥:switch | ?:help"
}
```

---

## Code Quality Checklist

Before submitting your changes, verify:

### Code Standards

- [ ] All functions have doc comments
- [ ] Error handling is present and informative
- [ ] No hardcoded values (use constants)
- [ ] Consistent naming conventions
- [ ] No dead code or commented-out sections

### Performance

- [ ] No unnecessary goroutine leaks
- [ ] Commands clean up after themselves
- [ ] No memory leaks from list updates
- [ ] Efficient clipboard operations

### User Experience

- [ ] Clear status messages for all operations
- [ ] Error messages are helpful (not just "failed")
- [ ] Visual feedback for focus changes
- [ ] Keyboard shortcuts are intuitive
- [ ] No confusing state transitions

### Documentation

- [ ] Update README if needed
- [ ] Update help dialog with new shortcuts
- [ ] Update status bar with context hints
- [ ] Add comments for complex logic

---

## Philosophy Alignment

This implementation follows the project's core philosophies:

### Ruthless Simplicity (@ai_context/IMPLEMENTATION_PHILOSOPHY.md)

- **Auto-load on navigation**: Removes unnecessary Enter key press
- **Context-sensitive copy**: One key ('c') works in multiple contexts
- **No over-engineering**: Simple index comparison for auto-load detection

### Modular Design (@ai_context/MODULAR_DESIGN_PHILOSOPHY.md)

- **Clear contracts**: Each function has one responsibility
- **Self-contained**: Copy functionality in separate functions
- **Regeneratable**: Logic in small, focused functions

### Changes Are Minimal

- Total lines changed: ~150-200 lines
- Files modified: 3 main files (update.go, actions.go, view.go)
- No architectural changes
- Maintains existing patterns

---

## Verification Steps

After completing all phases:

### 1. Build Verification

```bash
cd /Users/danny/amplifier/ai_working/swarm

# Clean build
make clean
make build

# Should complete without errors
```

### 2. Test Verification

```bash
# Run unit tests
make test

# Should show all tests passing
```

### 3. Lint Verification

```bash
# Run linters
go vet ./...
golangci-lint run

# Should report no issues
```

### 4. Manual Verification

```bash
# Run the TUI
./bin/swarm tui

# Work through the testing checklist
# Verify each feature works as expected
```

### 5. Edge Case Verification

Test these scenarios:

1. **Empty state**: No repos configured
2. **Large repos**: Repo with 50+ worktrees
3. **Slow loads**: Simulate slow network (add time.Sleep in load commands)
4. **Fast navigation**: Press keys rapidly
5. **Special characters**: Repos/branches with spaces, symbols

---

## Success Criteria

The implementation is complete when:

1. ✅ Moving cursor in repos list auto-loads worktrees
2. ✅ Enter key in repos panel changes focus to worktrees
3. ✅ 'c' key copies path (context-sensitive)
4. ✅ 'b' key copies branch name (worktrees panel)
5. ✅ Status bar shows context-appropriate shortcuts
6. ✅ Help dialog documents new behavior
7. ✅ All tests pass
8. ✅ No regressions in existing functionality
9. ✅ Code follows project style and philosophy
10. ✅ Manual testing checklist is complete

---

## Estimated Timeline

For a junior developer:

- **Phase 1 (Auto-load)**: 1.5-2 hours
- **Phase 2 (Focus change)**: 0.5-1 hour
- **Phase 3 (Copy functionality)**: 2-3 hours
- **Testing & debugging**: 1-2 hours
- **Documentation updates**: 0.5 hour

**Total**: 4-6 hours

For an experienced developer: 2-3 hours

---

## Getting Help

If you get stuck:

1. **Check existing code patterns**: Look at how other commands are implemented
2. **Use debugging**: Add `fmt.Fprintf(os.Stderr, ...)` to understand flow
3. **Read Bubble Tea docs**: https://github.com/charmbracelet/bubbletea
4. **Consult project docs**: `swarm/docs/` directory
5. **Ask for review**: Share your progress and specific questions

---

## References

### Key Files

- `swarm/internal/tui/model.go` - State structure
- `swarm/internal/tui/update.go` - Message handling
- `swarm/internal/tui/view.go` - Rendering
- `swarm/internal/tui/actions.go` - Commands
- `swarm/internal/tui/items.go` - List items

### Documentation

- `swarm/docs/ARCHITECTURE.md` - System overview
- `swarm/docs/MODULES.md` - Module details
- `swarm/docs/IMPLEMENTATION_GUIDE.md` - Coding standards

### External Resources

- [Bubble Tea Tutorial](https://github.com/charmbracelet/bubbletea/tree/master/tutorials)
- [Bubbles Components](https://github.com/charmbracelet/bubbles)
- [Lipgloss Styling](https://github.com/charmbracelet/lipgloss)
- [Clipboard Library](https://github.com/atotto/clipboard)

---

## Post-Implementation

After completing the implementation:

1. **Update PHASE-2-COMPLETE.md** with these enhancements
2. **Create a demo video** or screenshots showing the new behavior
3. **Update user-facing docs** if needed
4. **Consider additional improvements**:
   - Copy multiple items at once
   - Show preview before copying
   - Add undo/redo for focus changes
   - Keyboard shortcut customization

---

**Good luck! Remember: Start simple, test frequently, and ask questions when stuck.**
