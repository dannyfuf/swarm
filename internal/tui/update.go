package tui

import (
	"fmt"

	tea "github.com/charmbracelet/bubbletea"
)

// Update handles messages and updates the model
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	// Handle dialog interactions first
	if m.showDialog {
		return m.updateDialog(msg)
	}

	// Handle text input mode
	if m.inputMode != InputModeNone {
		return m.updateInput(msg)
	}

	// Handle normal mode
	switch msg := msg.(type) {
	case tea.KeyMsg:
		return m.handleKeyMsg(msg)

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height

		// Update list sizes
		colWidth := (m.width - 6) / 3
		listHeight := m.height - 5

		m.repoList.SetSize(colWidth-4, listHeight)
		m.worktreeList.SetSize(colWidth-4, listHeight)

		return m, nil

	case reposLoadedMsg:
		m.repos = msg.repos
		colWidth := (m.width - 6) / 3
		listHeight := m.height - 5
		m.repoList = createRepoList(msg.repos, colWidth-4, listHeight)
		m.statusMessage = fmt.Sprintf("Loaded %d repositories", len(msg.repos))

		// Auto-load worktrees for first repo if repos exist
		if len(msg.repos) > 0 {
			m.selectedRepo = &msg.repos[0]
			return m, loadWorktreesCmd(m.wtManager, m.orphanDetector, m.selectedRepo)
		}

		return m, nil

	case worktreesLoadedMsg:
		m.worktrees = msg.worktrees
		colWidth := (m.width - 6) / 3
		listHeight := m.height - 5
		m.worktreeList = createWorktreeList(msg.worktrees, colWidth-4, listHeight)
		m.selectedWT = nil
		m.statusMessage = fmt.Sprintf("Loaded %d worktrees", len(msg.worktrees))
		return m, nil

	case worktreeCreatedMsg:
		m.statusMessage = fmt.Sprintf("Created worktree: %s", msg.worktree.Branch)
		// Refresh the worktree list
		if m.selectedRepo != nil {
			return m, loadWorktreesCmd(m.wtManager, m.orphanDetector, m.selectedRepo)
		}
		return m, nil

	case worktreeOpenedMsg:
		m.statusMessage = fmt.Sprintf("Opened worktree: %s", msg.worktree.Branch)
		// Note: In a real implementation, we might want to exit the TUI here
		// or handle the tmux attachment differently
		return m, tea.Quit

	case worktreeRemovedMsg:
		m.statusMessage = fmt.Sprintf("Removed worktree: %s", msg.worktree.Branch)
		// Refresh the worktree list
		if m.selectedRepo != nil {
			return m, loadWorktreesCmd(m.wtManager, m.orphanDetector, m.selectedRepo)
		}
		return m, nil

	case removalSafetyCheckedMsg:
		// Show confirmation dialog with safety check results
		message := fmt.Sprintf("Delete worktree '%s'?\n\n", msg.worktree.Branch)

		if msg.result.Safe {
			message += "✓ Safe to remove (no uncommitted changes)\n"
		} else {
			message += "⚠ Warning:\n"
			for _, warning := range msg.result.Warnings {
				message += fmt.Sprintf("  • %s\n", warning)
			}
		}

		m.dialog = showConfirmDialog("Confirm Deletion", message)
		m.showDialog = true
		m.dialogType = DialogTypeDelete
		m.confirmForce = !msg.result.Safe
		m.statusMessage = ""

		return m, nil

	case orphansPrunedMsg:
		m.statusMessage = fmt.Sprintf("Pruned %d orphaned worktree(s)", msg.count)
		// Refresh the worktree list
		if m.selectedRepo != nil {
			return m, loadWorktreesCmd(m.wtManager, m.orphanDetector, m.selectedRepo)
		}
		return m, nil

	case clipboardCopiedMsg:
		m.statusMessage = fmt.Sprintf("✓ Copied %s to clipboard: %s", msg.label, msg.text)
		m.errorMessage = ""
		return m, nil

	case errorMsg:
		m.errorMessage = msg.err.Error()
		m.statusMessage = ""
		return m, nil
	}

	return m, nil
}

func (m Model) handleKeyMsg(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "ctrl+c":
		return m, tea.Quit

	case "tab":
		m.focusedPanel = (m.focusedPanel + 1) % 3
		return m, nil

	case "shift+tab":
		m.focusedPanel = (m.focusedPanel + 2) % 3 // Go backwards
		return m, nil

	case "enter":
		return m.handleEnter()

	case "n":
		return m.handleNew()

	case "d":
		return m.handleDelete()

	case "o":
		return m.handleOpen()

	case "r":
		return m.handleRefresh()

	case "p":
		return m.handlePrune()

	case "?":
		return m.handleHelp()

	case "c":
		return m.handleCopy()

	case "b":
		return m.handleCopyBranch()
	}

	// Delegate to focused list and check for repo selection changes
	var cmd tea.Cmd
	switch m.focusedPanel {
	case PanelRepos:
		previousIndex := m.repoList.Index()
		m.repoList, cmd = m.repoList.Update(msg)
		// Check if repo selection changed after update
		return m.checkRepoSelectionChanged(previousIndex, cmd)

	case PanelWorktrees:
		previousIndex := m.worktreeList.Index()
		m.worktreeList, cmd = m.worktreeList.Update(msg)
		// Check if worktree selection changed after update
		return m.checkWorktreeSelectionChanged(previousIndex, cmd)
	}

	return m, nil
}

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

// checkWorktreeSelectionChanged checks if the selected worktree has changed and updates selectedWT
func (m Model) checkWorktreeSelectionChanged(previousSelectedIndex int, cmd tea.Cmd) (Model, tea.Cmd) {
	// Only check if we're in the worktrees panel
	if m.focusedPanel != PanelWorktrees {
		return m, cmd
	}

	// Get current selected index
	currentIndex := m.worktreeList.Index()

	// If selection changed, update selectedWT
	if currentIndex != previousSelectedIndex && currentIndex >= 0 && currentIndex < len(m.worktrees) {
		item := m.worktreeList.SelectedItem()
		if item != nil {
			wtItem := item.(worktreeItem)
			m.selectedWT = &wtItem.worktree
			m.detailView = renderDetail(m.selectedWT, m)
			m.statusMessage = fmt.Sprintf("Selected: %s", m.selectedWT.Branch)
		}
	}

	return m, cmd
}

func (m Model) handleEnter() (tea.Model, tea.Cmd) {
	m.errorMessage = ""

	switch m.focusedPanel {
	case PanelRepos:
		// Switch focus to worktrees panel
		// (Worktrees already loaded by auto-update)
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
				m.worktreeList.Select(0)
			}
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

func (m Model) updateInput(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "enter":
			value := m.textInput.Value()
			m.textInput.SetValue("")
			m.textInput.Blur()

			if value != "" {
				switch m.inputMode {
				case InputModeCreate:
					return m.handleCreateSubmit(value)
				}
			}

			m.inputMode = InputModeNone
			return m, nil

		case "esc":
			m.textInput.SetValue("")
			m.textInput.Blur()
			m.inputMode = InputModeNone
			return m, nil
		}
	}

	var cmd tea.Cmd
	m.textInput, cmd = m.textInput.Update(msg)
	return m, cmd
}

func (m Model) updateDialog(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "left", "h":
			if m.dialog.selected > 0 {
				m.dialog.selected--
			}
			return m, nil

		case "right", "l":
			if m.dialog.selected < len(m.dialog.buttons)-1 {
				m.dialog.selected++
			}
			return m, nil

		case "enter":
			// Check which button is selected
			if m.dialog.selected == 1 || len(m.dialog.buttons) == 1 {
				// Confirmed or OK button
				switch m.dialogType {
				case DialogTypeDelete:
					m.showDialog = false
					return m.handleDeleteConfirmed()
				case DialogTypeOrphanCleanup:
					m.showDialog = false
					return m.handleOrphanCleanupConfirmed()
				case DialogTypePruneOrphans:
					m.showDialog = false
					return m.handlePruneConfirmed()
				default:
					// Help or other dialogs - just close
					m.showDialog = false
					return m, nil
				}
			}
			// Cancelled
			m.showDialog = false
			return m, nil

		case "esc":
			m.showDialog = false
			return m, nil
		}
	}

	return m, nil
}
