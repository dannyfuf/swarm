package tmux

import (
	"fmt"
	"os/exec"
	"strings"
)

type Client struct{}

func NewClient() *Client {
	return &Client{}
}

// HasSession checks if a tmux session exists
func (c *Client) HasSession(name string) (bool, error) {
	cmd := exec.Command("tmux", "has-session", "-t", name)
	err := cmd.Run()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			// Exit code 1 means session doesn't exist
			if exitErr.ExitCode() == 1 {
				return false, nil
			}
		}
		return false, err
	}
	return true, nil
}

// CreateSession creates a new tmux session
func (c *Client) CreateSession(name, path string) error {
	cmd := exec.Command("tmux", "new-session", "-d", "-s", name, "-c", path)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("creating tmux session: %w\nOutput: %s", err, output)
	}
	return nil
}

// AttachSession attaches to an existing tmux session
func (c *Client) AttachSession(name string) error {
	// Check if we're already in a tmux session
	if isInsideTmux() {
		// Switch to the session instead of attaching
		cmd := exec.Command("tmux", "switch-client", "-t", name)
		output, err := cmd.CombinedOutput()
		if err != nil {
			return fmt.Errorf("switching to tmux session: %w\nOutput: %s", err, output)
		}
		return nil
	}

	// Not in tmux, so attach
	cmd := exec.Command("tmux", "attach-session", "-t", name)
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("attaching to tmux session: %w", err)
	}

	return nil
}

// KillSession kills a tmux session
func (c *Client) KillSession(name string) error {
	cmd := exec.Command("tmux", "kill-session", "-t", name)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("killing tmux session: %w\nOutput: %s", err, output)
	}
	return nil
}

// ListSessions lists all tmux sessions
func (c *Client) ListSessions() ([]string, error) {
	cmd := exec.Command("tmux", "list-sessions", "-F", "#{session_name}")
	output, err := cmd.CombinedOutput()
	if err != nil {
		// If no sessions exist, return empty list
		if strings.Contains(string(output), "no server running") {
			return []string{}, nil
		}
		return nil, fmt.Errorf("listing tmux sessions: %w\nOutput: %s", err, output)
	}

	sessions := strings.Split(strings.TrimSpace(string(output)), "\n")
	if len(sessions) == 1 && sessions[0] == "" {
		return []string{}, nil
	}
	return sessions, nil
}

// ListSessionsDetailed returns detailed information about all tmux sessions
func (c *Client) ListSessionsDetailed() ([]Session, error) {
	// Get session list with name, path, and attached status
	cmd := exec.Command("tmux", "list-sessions", "-F", "#{session_name}|#{session_path}|#{session_attached}")
	output, err := cmd.CombinedOutput()
	if err != nil {
		// If no sessions exist, return empty list
		if strings.Contains(string(output), "no server running") {
			return []Session{}, nil
		}
		return nil, fmt.Errorf("listing tmux sessions: %w\nOutput: %s", err, output)
	}

	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	if len(lines) == 1 && lines[0] == "" {
		return []Session{}, nil
	}

	var sessions []Session
	for _, line := range lines {
		parts := strings.Split(line, "|")
		if len(parts) < 3 {
			continue
		}

		session := Session{
			Name:     parts[0],
			Path:     parts[1],
			Attached: parts[2] == "1",
		}

		// Get windows for this session
		windowsCmd := exec.Command("tmux", "list-windows", "-t", session.Name, "-F", "#{window_name}")
		windowsOutput, err := windowsCmd.Output()
		if err == nil {
			windowNames := strings.Split(strings.TrimSpace(string(windowsOutput)), "\n")
			if !(len(windowNames) == 1 && windowNames[0] == "") {
				session.Windows = windowNames
			}
		}

		sessions = append(sessions, session)
	}

	return sessions, nil
}

// CreateOrAttach creates a session if it doesn't exist, or attaches to it if it does
func (c *Client) CreateOrAttach(name, path string) error {
	exists, err := c.HasSession(name)
	if err != nil {
		return err
	}

	if !exists {
		if err := c.CreateSession(name, path); err != nil {
			return err
		}
	}

	return c.AttachSession(name)
}

func isInsideTmux() bool {
	cmd := exec.Command("printenv", "TMUX")
	output, err := cmd.Output()
	return err == nil && len(output) > 0
}

// CreateWindow creates a new window with the naming convention
func (c *Client) CreateWindow(sessionName string, wn WindowName, path string) (*Window, error) {
	windowName := wn.Format()
	cmd := exec.Command("tmux", "new-window", "-t", sessionName, "-n", windowName, "-c", path)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("creating window %q in session %q: %w\nOutput: %s", windowName, sessionName, err, output)
	}

	return &Window{
		Name: wn,
		Path: path,
	}, nil
}

// DeleteWindow removes a window by name
func (c *Client) DeleteWindow(sessionName, windowName string) error {
	target := fmt.Sprintf("%s:%s", sessionName, windowName)
	cmd := exec.Command("tmux", "kill-window", "-t", target)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("deleting window %q: %w\nOutput: %s", target, err, output)
	}
	return nil
}

// RenameWindow renames a window, preserving the repo:worktree: prefix
func (c *Client) RenameWindow(sessionName, oldName, newName string) error {
	// Parse old name to preserve prefix
	parsed, err := ParseWindowName(oldName)
	if err != nil {
		return err
	}

	// Update only the name component
	newWindowName := WindowName{
		Repo:     parsed.Repo,
		Worktree: parsed.Worktree,
		Name:     newName,
	}

	target := fmt.Sprintf("%s:%s", sessionName, oldName)
	cmd := exec.Command("tmux", "rename-window", "-t", target, newWindowName.Format())
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("renaming window %q to %q: %w\nOutput: %s", target, newWindowName.Format(), err, output)
	}
	return nil
}

// ListWindows lists windows, optionally filtered by prefix
func (c *Client) ListWindows(sessionName string, prefixFilter string) ([]Window, error) {
	cmd := exec.Command("tmux", "list-windows", "-t", sessionName,
		"-F", "#{window_id}|#{window_name}|#{window_index}|#{window_active}|#{pane_current_path}")
	output, err := cmd.CombinedOutput()
	if err != nil {
		if strings.Contains(string(output), "no server running") {
			return []Window{}, nil
		}
		if strings.Contains(string(output), "session not found") {
			return nil, fmt.Errorf("session not found: %s", sessionName)
		}
		return nil, fmt.Errorf("listing windows in session %q: %w\nOutput: %s", sessionName, err, output)
	}

	var windows []Window
	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	for _, line := range lines {
		if line == "" {
			continue
		}

		parts := strings.Split(line, "|")
		if len(parts) < 5 {
			continue
		}

		windowName := parts[1]

		// Apply prefix filter if specified
		if prefixFilter != "" && !strings.HasPrefix(windowName, prefixFilter) {
			continue
		}

		parsed, _ := ParseWindowName(windowName)
		index := 0
		fmt.Sscanf(parts[2], "%d", &index)

		window := Window{
			ID:     parts[0],
			Index:  index,
			Active: parts[3] == "1",
			Path:   parts[4],
		}
		if parsed != nil {
			window.Name = *parsed
		}

		windows = append(windows, window)
	}

	return windows, nil
}

// SelectWindow switches to a specific window
func (c *Client) SelectWindow(sessionName, windowName string) error {
	target := fmt.Sprintf("%s:%s", sessionName, windowName)
	cmd := exec.Command("tmux", "select-window", "-t", target)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("selecting window %q: %w\nOutput: %s", target, err, output)
	}
	return nil
}

// SendToPane sends keys/command to a pane in a window
func (c *Client) SendToPane(sessionName, windowName string, paneIndex int, command string) error {
	target := fmt.Sprintf("%s:%s.%d", sessionName, windowName, paneIndex)
	cmd := exec.Command("tmux", "send-keys", "-t", target, command, "Enter")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("sending to pane %q: %w\nOutput: %s", target, err, output)
	}
	return nil
}
