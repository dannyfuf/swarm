package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/microsoft/amplifier/swarm/internal/worktree"
)

// View renders the TUI
func (m Model) View() string {
	if m.width == 0 {
		return "Loading..."
	}

	// Show dialog if active
	if m.showDialog {
		dialogView := m.dialog.View(m.width, m.height)
		return lipgloss.Place(m.width, m.height, lipgloss.Center, lipgloss.Center, dialogView, lipgloss.WithWhitespaceChars(" "), lipgloss.WithWhitespaceForeground(lipgloss.Color("0")))
	}

	// Show text input if active
	if m.inputMode != InputModeNone {
		return m.renderInputView()
	}

	return m.renderMainView()
}

func (m Model) renderMainView() string {
	// Layout: three columns
	colWidth := (m.width - 6) / 3 // Account for borders

	repoPanel := renderPanel("Repositories", m.repoList.View(),
		colWidth, m.height-3, m.focusedPanel == PanelRepos)

	wtPanel := renderPanel("Worktrees", m.worktreeList.View(),
		colWidth, m.height-3, m.focusedPanel == PanelWorktrees)

	detailPanel := renderPanel("Details", m.detailView,
		colWidth, m.height-3, m.focusedPanel == PanelDetail)

	mainView := lipgloss.JoinHorizontal(lipgloss.Top,
		repoPanel, wtPanel, detailPanel)

	statusBar := renderStatusBar(m)

	return lipgloss.JoinVertical(lipgloss.Left, mainView, statusBar)
}

func (m Model) renderInputView() string {
	var title string
	switch m.inputMode {
	case InputModeCreate:
		title = "Create Worktree"
	default:
		title = "Input"
	}

	titleStyle := lipgloss.NewStyle().
		Bold(true).
		Foreground(lipgloss.Color("63")).
		Padding(1, 2)

	promptStyle := lipgloss.NewStyle().
		Foreground(lipgloss.Color("252")).
		Padding(0, 2)

	inputStyle := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color("69")).
		Padding(1, 2).
		Width(m.width / 2)

	content := lipgloss.JoinVertical(lipgloss.Left,
		titleStyle.Render(title),
		promptStyle.Render("Branch name:"),
		"",
		m.textInput.View(),
		"",
		promptStyle.Render("Press Enter to confirm, Esc to cancel"),
	)

	centered := lipgloss.Place(m.width, m.height,
		lipgloss.Center, lipgloss.Center,
		inputStyle.Render(content))

	return centered
}

func renderPanel(title, content string, width, height int, focused bool) string {
	borderStyle := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color("240")).
		Width(width).
		Height(height).
		Padding(0, 1)

	if focused {
		borderStyle = borderStyle.
			BorderForeground(lipgloss.Color("69"))
	}

	titleStyle := lipgloss.NewStyle().
		Bold(true).
		Foreground(lipgloss.Color("63"))

	header := titleStyle.Render(title)

	return borderStyle.Render(
		lipgloss.JoinVertical(lipgloss.Left,
			header,
			"",
			content,
		),
	)
}

func renderStatusBar(m Model) string {
	style := lipgloss.NewStyle().
		Foreground(lipgloss.Color("240")).
		Background(lipgloss.Color("235")).
		Padding(0, 1)

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

	statusText := keys
	if m.errorMessage != "" {
		errorStyle := lipgloss.NewStyle().
			Foreground(lipgloss.Color("196")).
			Background(lipgloss.Color("235")).
			Padding(0, 1)
		statusText = errorStyle.Render("Error: "+m.errorMessage) + "  " + keys
	} else if m.statusMessage != "" {
		msgStyle := lipgloss.NewStyle().
			Foreground(lipgloss.Color("35")).
			Background(lipgloss.Color("235")).
			Padding(0, 1)
		statusText = msgStyle.Render(m.statusMessage) + "  " + keys
	}

	return style.Width(m.width).Render(statusText)
}

func renderDetail(wt *worktree.Worktree, m Model) string {
	if wt == nil {
		return "Select a worktree to view details"
	}

	var lines []string

	lines = append(lines, fmt.Sprintf("Branch: %s", wt.Branch))
	lines = append(lines, fmt.Sprintf("Slug: %s", wt.Slug))
	lines = append(lines, fmt.Sprintf("Path: %s", wt.Path))
	lines = append(lines, fmt.Sprintf("Repository: %s", wt.RepoName))
	lines = append(lines, "")

	// Compute status if available
	if m.statusComputer != nil && m.gitClient != nil && m.selectedRepo != nil {
		opts := struct {
			RepoPath      string
			DefaultBranch string
		}{
			RepoPath:      m.selectedRepo.Path,
			DefaultBranch: m.selectedRepo.DefaultBranch,
		}
		status, err := m.statusComputer.Compute(m.gitClient, wt, opts)
		if err == nil {
			lines = append(lines, "Status:")
			badges := status.GetBadges()
			if len(badges) == 0 {
				lines = append(lines, "  ✓ Clean")
			} else {
				for _, badge := range badges {
					lines = append(lines, fmt.Sprintf("  %s %s", badge.Symbol, badge.Hint))
				}
			}
			lines = append(lines, "")
		}
	}

	lines = append(lines, fmt.Sprintf("Created: %s", wt.CreatedAt.Format("2006-01-02 15:04")))
	if !wt.LastOpenedAt.IsZero() {
		lines = append(lines, fmt.Sprintf("Last opened: %s", wt.LastOpenedAt.Format("2006-01-02 15:04")))
	}

	return strings.Join(lines, "\n")
}
