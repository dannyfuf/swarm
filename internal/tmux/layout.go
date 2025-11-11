package tmux

import (
	"fmt"
	"os/exec"
)

// Layout defines tmux window/pane structure
type Layout struct {
	Windows []Window
}

// Window represents a tmux window
type Window struct {
	Name    string
	Command string // Initial command to run
	Panes   []Pane
}

// Pane represents a split within a window
type Pane struct {
	Command   string
	Direction string // "horizontal" or "vertical"
	Size      int    // Percentage (e.g., 50 for 50%)
}

// DefaultLayout returns standard 3-window layout
func DefaultLayout() *Layout {
	return &Layout{
		Windows: []Window{
			{
				Name:    "editor",
				Command: "nvim .",
				Panes:   []Pane{},
			},
			{
				Name:    "shell",
				Command: "",
				Panes:   []Pane{},
			},
			{
				Name:    "tests",
				Command: "make test",
				Panes: []Pane{
					{
						Command:   "make watch",
						Direction: "vertical",
						Size:      50,
					},
				},
			},
		},
	}
}

// Apply applies layout to existing session
func (l *Layout) Apply(sessionName string) error {
	for i, window := range l.Windows {
		windowNum := i + 1
		windowTarget := fmt.Sprintf("%s:%d", sessionName, windowNum)

		// Create window (first window already exists)
		if i > 0 {
			cmd := exec.Command("tmux", "new-window",
				"-t", sessionName,
				"-n", window.Name)
			if err := cmd.Run(); err != nil {
				return fmt.Errorf("creating window %d: %w", windowNum, err)
			}
		} else {
			// Rename first window
			cmd := exec.Command("tmux", "rename-window",
				"-t", windowTarget, window.Name)
			if err := cmd.Run(); err != nil {
				return fmt.Errorf("renaming window 1: %w", err)
			}
		}

		// Run initial command in main pane
		if window.Command != "" {
			cmd := exec.Command("tmux", "send-keys",
				"-t", windowTarget, window.Command, "Enter")
			if err := cmd.Run(); err != nil {
				return fmt.Errorf("sending command to window %d: %w", windowNum, err)
			}
		}

		// Create additional panes
		for j, pane := range window.Panes {
			splitFlag := "-h" // horizontal
			if pane.Direction == "vertical" {
				splitFlag = "-v"
			}

			splitCmd := []string{"split-window", splitFlag, "-t", windowTarget}
			if pane.Size > 0 {
				splitCmd = append(splitCmd, "-p", fmt.Sprintf("%d", pane.Size))
			}

			cmd := exec.Command("tmux", splitCmd...)
			if err := cmd.Run(); err != nil {
				return fmt.Errorf("creating pane %d in window %d: %w", j+1, windowNum, err)
			}

			// Run command in pane
			if pane.Command != "" {
				paneTarget := fmt.Sprintf("%s.%d", windowTarget, j+1)
				cmd := exec.Command("tmux", "send-keys",
					"-t", paneTarget, pane.Command, "Enter")
				if err := cmd.Run(); err != nil {
					return fmt.Errorf("sending command to pane: %w", err)
				}
			}
		}
	}

	// Select first window
	cmd := exec.Command("tmux", "select-window", "-t", fmt.Sprintf("%s:1", sessionName))
	cmd.Run()

	return nil
}
