package tui

import (
	"github.com/charmbracelet/lipgloss"
)

// Dialog represents a confirmation dialog
type Dialog struct {
	title    string
	message  string
	buttons  []string
	selected int
}

// View renders the dialog
func (d Dialog) View(width, height int) string {
	titleStyle := lipgloss.NewStyle().
		Bold(true).
		Foreground(lipgloss.Color("63")).
		Padding(1, 2)

	messageStyle := lipgloss.NewStyle().
		Foreground(lipgloss.Color("252")).
		Padding(1, 2)

	buttonStyle := lipgloss.NewStyle().
		Foreground(lipgloss.Color("240")).
		Padding(0, 2).
		Border(lipgloss.RoundedBorder())

	selectedButtonStyle := buttonStyle.Copy().
		Foreground(lipgloss.Color("15")).
		BorderForeground(lipgloss.Color("69"))

	// Render buttons
	var buttons []string
	for i, btn := range d.buttons {
		style := buttonStyle
		if i == d.selected {
			style = selectedButtonStyle
		}
		buttons = append(buttons, style.Render(btn))
	}

	buttonsRow := lipgloss.JoinHorizontal(lipgloss.Center, buttons...)

	helpText := lipgloss.NewStyle().
		Foreground(lipgloss.Color("240")).
		Padding(0, 2).
		Render("Use ← → or h l to navigate, Enter to confirm, Esc to cancel")

	content := lipgloss.JoinVertical(lipgloss.Center,
		titleStyle.Render(d.title),
		messageStyle.Render(d.message),
		"",
		buttonsRow,
		"",
		helpText,
	)

	// Center in screen
	boxStyle := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color("63")).
		Padding(1, 2).
		Width(width / 2).
		AlignHorizontal(lipgloss.Center)

	return boxStyle.Render(content)
}

// showConfirmDialog creates a confirmation dialog
func showConfirmDialog(title, message string) Dialog {
	return Dialog{
		title:    title,
		message:  message,
		buttons:  []string{"Cancel", "Confirm"},
		selected: 0,
	}
}
