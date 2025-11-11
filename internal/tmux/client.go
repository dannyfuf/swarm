package tmux

import (
	"fmt"
	"os/exec"
	"strings"
)

type Client struct{}

// Session represents a tmux session with details
type Session struct {
	Name     string
	Path     string
	Windows  []string
	Attached bool
}

// Window represents a tmux window
type WindowInfo struct {
	Index  int
	Name   string
	Active bool
}

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
