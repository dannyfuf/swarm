package tui

import (
	"fmt"

	"github.com/atotto/clipboard"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/microsoft/amplifier/swarm/internal/git"
	"github.com/microsoft/amplifier/swarm/internal/repo"
	"github.com/microsoft/amplifier/swarm/internal/safety"
	"github.com/microsoft/amplifier/swarm/internal/tmux"
	"github.com/microsoft/amplifier/swarm/internal/worktree"
)

// Message types for actions
type worktreeCreatedMsg struct {
	worktree *worktree.Worktree
}

type worktreeOpenedMsg struct {
	worktree *worktree.Worktree
}

type worktreeRemovedMsg struct {
	worktree *worktree.Worktree
}

type removalSafetyCheckedMsg struct {
	result   *safety.CheckResult
	worktree *worktree.Worktree
}

// handleNew shows the create worktree input
func (m Model) handleNew() (tea.Model, tea.Cmd) {
	if m.selectedRepo == nil {
		m.errorMessage = "Select a repository first"
		return m, nil
	}

	// Show input prompt for branch name
	m.inputMode = InputModeCreate
	m.textInput.Placeholder = "feature/my-branch"
	m.textInput.Focus()
	m.errorMessage = ""

	return m, nil
}

// handleCreateSubmit creates a new worktree
func (m Model) handleCreateSubmit(branchName string) (tea.Model, tea.Cmd) {
	if m.selectedRepo == nil {
		return m, nil
	}

	m.inputMode = InputModeNone
	m.statusMessage = "Creating worktree..."

	return m, createWorktreeCmd(m.wtManager, m.selectedRepo, branchName)
}

// createWorktreeCmd creates a worktree asynchronously
func createWorktreeCmd(manager *worktree.Manager, r *repo.Repo, branch string) tea.Cmd {
	return func() tea.Msg {
		// Check if branch already exists
		gitClient := git.NewClient()
		branchInfo, err := gitClient.GetBranchInfo(r.Path, branch)
		if err != nil {
			return errorMsg{fmt.Errorf("checking branch: %w", err)}
		}

		var newBranch bool
		var useExisting bool

		if branchInfo.Exists {
			// Branch exists - for TUI, always use existing branch
			// (In interactive TUI, user can delete manually if they want to recreate)
			useExisting = true
			newBranch = false
		} else {
			// Branch doesn't exist - create new
			newBranch = true
			useExisting = false
		}

		// Determine base branch
		baseBranch := r.DefaultBranch
		if useExisting {
			// For existing branch, don't specify base branch
			baseBranch = ""
		}

		opts := worktree.CreateOptions{
			Branch:     branch,
			BaseBranch: baseBranch,
			NewBranch:  newBranch,
		}

		wt, err := manager.Create(r, opts)
		if err != nil {
			return errorMsg{err}
		}

		return worktreeCreatedMsg{worktree: wt}
	}
}

// handleOpen opens the selected worktree in tmux
func (m Model) handleOpen() (tea.Model, tea.Cmd) {
	if m.selectedWT == nil {
		m.errorMessage = "Select a worktree first"
		return m, nil
	}

	m.statusMessage = "Opening worktree..."
	m.errorMessage = ""

	return m, openWorktreeCmd(m.tmuxClient, m.selectedWT, m.cfg)
}

// openWorktreeCmd opens a worktree in tmux asynchronously
func openWorktreeCmd(client *tmux.Client, wt *worktree.Worktree, cfg interface{}) tea.Cmd {
	return func() tea.Msg {
		sessionName := fmt.Sprintf("%s--wt--%s", wt.RepoName, wt.Slug)

		// Check if session exists
		exists, err := client.HasSession(sessionName)
		if err != nil {
			return errorMsg{err}
		}

		// Create session if it doesn't exist
		if !exists {
			err = client.CreateSession(sessionName, wt.Path)
			if err != nil {
				return errorMsg{err}
			}
		}

		// Attach to session
		err = client.AttachSession(sessionName)
		if err != nil {
			return errorMsg{err}
		}

		return worktreeOpenedMsg{worktree: wt}
	}
}

// handleDelete initiates the delete workflow with safety check
func (m Model) handleDelete() (tea.Model, tea.Cmd) {
	if m.selectedWT == nil {
		m.errorMessage = "Select a worktree first"
		return m, nil
	}

	// Check if worktree is orphaned
	if m.selectedWT.IsOrphaned {
		// Show orphan cleanup confirmation dialog
		message := fmt.Sprintf("Clean up orphaned worktree '%s'?\n\n", m.selectedWT.Branch)
		message += "⚠ Directory is already gone. This will remove it from state only.\n"

		m.dialog = showConfirmDialog("Confirm Cleanup", message)
		m.showDialog = true
		m.dialogType = DialogTypeOrphanCleanup
		return m, nil
	}

	m.statusMessage = "Checking worktree safety..."
	m.errorMessage = ""

	// Run safety check first
	return m, checkRemovalSafetyCmd(m.safetyChecker, m.selectedWT)
}

// handleDeleteConfirmed performs the actual deletion
func (m Model) handleDeleteConfirmed() (tea.Model, tea.Cmd) {
	if m.selectedWT == nil {
		return m, nil
	}

	m.statusMessage = "Removing worktree..."
	m.showDialog = false

	return m, removeWorktreeCmd(m.wtManager, m.selectedRepo, m.selectedWT, m.confirmForce)
}

// handleOrphanCleanupConfirmed cleans up orphaned worktree from state
func (m Model) handleOrphanCleanupConfirmed() (tea.Model, tea.Cmd) {
	if m.selectedWT == nil || m.selectedRepo == nil {
		return m, nil
	}

	m.statusMessage = "Cleaning up orphaned worktree..."
	m.showDialog = false

	return m, cleanOrphanCmd(m.orphanDetector, m.selectedRepo, m.selectedWT)
}

// checkRemovalSafetyCmd checks if worktree can be safely removed
func checkRemovalSafetyCmd(checker *safety.Checker, wt *worktree.Worktree) tea.Cmd {
	return func() tea.Msg {
		result, err := checker.CheckRemoval(wt)
		if err != nil {
			return errorMsg{err}
		}
		return removalSafetyCheckedMsg{result: result, worktree: wt}
	}
}

// removeWorktreeCmd removes a worktree asynchronously
func removeWorktreeCmd(manager *worktree.Manager, r *repo.Repo, wt *worktree.Worktree, force bool) tea.Cmd {
	return func() tea.Msg {
		// Remove the worktree
		err := manager.Remove(wt, force)
		if err != nil {
			return errorMsg{err}
		}

		// Handle branch cleanup
		// For TUI, we'll delete the branch if it's merged or empty
		if r != nil {
			gitClient := git.NewClient()
			branchInfo, err := gitClient.GetBranchInfo(r.Path, wt.Branch)
			if err == nil && branchInfo.Exists {
				// Delete if merged or empty
				if branchInfo.IsMerged || branchInfo.CommitCount == 0 {
					// Try safe delete first
					gitClient.DeleteBranch(r.Path, wt.Branch, false)
					// If it fails, that's okay - user can clean up manually
				}
				// If not merged and has commits, keep the branch (safer default)
			}
		}

		return worktreeRemovedMsg{worktree: wt}
	}
}

// cleanOrphanCmd cleans up a single orphaned worktree from state
func cleanOrphanCmd(detector *worktree.OrphanDetector, r *repo.Repo, wt *worktree.Worktree) tea.Cmd {
	return func() tea.Msg {
		orphan := worktree.OrphanedWorktree{
			Slug:   wt.Slug,
			Branch: wt.Branch,
			Path:   wt.Path,
		}
		err := detector.CleanOrphans(r, []worktree.OrphanedWorktree{orphan})
		if err != nil {
			return errorMsg{err}
		}
		return worktreeRemovedMsg{worktree: wt}
	}
}

// handleRefresh refreshes the worktree list
func (m Model) handleRefresh() (tea.Model, tea.Cmd) {
	if m.selectedRepo == nil {
		m.errorMessage = "Select a repository first"
		return m, nil
	}

	m.statusMessage = "Refreshing worktrees..."
	m.errorMessage = ""

	return m, loadWorktreesCmd(m.wtManager, m.orphanDetector, m.selectedRepo)
}

// handlePrune initiates bulk orphan cleanup
func (m Model) handlePrune() (tea.Model, tea.Cmd) {
	if m.selectedRepo == nil {
		m.errorMessage = "Select a repository first"
		return m, nil
	}

	// Count orphaned worktrees
	orphanCount := 0
	for _, wt := range m.worktrees {
		if wt.IsOrphaned {
			orphanCount++
		}
	}

	if orphanCount == 0 {
		m.statusMessage = "No orphaned worktrees to prune"
		return m, nil
	}

	// Show prune confirmation dialog
	message := fmt.Sprintf("Prune %d orphaned worktree(s)?\n\n", orphanCount)
	message += "This will remove all [GONE] worktrees from state.\n"

	m.dialog = showConfirmDialog("Confirm Prune", message)
	m.showDialog = true
	m.dialogType = DialogTypePruneOrphans

	return m, nil
}

// handlePruneConfirmed performs the bulk prune operation
func (m Model) handlePruneConfirmed() (tea.Model, tea.Cmd) {
	if m.selectedRepo == nil {
		return m, nil
	}

	m.statusMessage = "Pruning orphaned worktrees..."
	m.showDialog = false

	return m, pruneOrphansCmd(m.orphanDetector, m.selectedRepo)
}

// pruneOrphansCmd removes all orphaned worktrees for a repo
func pruneOrphansCmd(detector *worktree.OrphanDetector, r *repo.Repo) tea.Cmd {
	return func() tea.Msg {
		orphans, err := detector.DetectOrphans(r)
		if err != nil {
			return errorMsg{err}
		}

		if len(orphans) == 0 {
			return orphansPrunedMsg{count: 0}
		}

		err = detector.CleanOrphans(r, orphans)
		if err != nil {
			return errorMsg{err}
		}

		return orphansPrunedMsg{count: len(orphans)}
	}
}

// orphansPrunedMsg indicates prune operation completed
type orphansPrunedMsg struct {
	count int
}

// handleHelp shows help information
func (m Model) handleHelp() (tea.Model, tea.Cmd) {
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

	m.dialog = Dialog{
		title:    "Help",
		message:  helpMsg,
		buttons:  []string{"OK"},
		selected: 0,
	}
	m.showDialog = true
	m.dialogType = DialogTypeNone

	return m, nil
}

// clipboardCopiedMsg indicates successful clipboard copy
type clipboardCopiedMsg struct {
	text  string
	label string
}

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
