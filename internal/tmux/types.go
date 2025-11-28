package tmux

import (
	"fmt"
	"strings"

	"github.com/microsoft/amplifier/swarm/internal/errors"
)

// WindowName represents the structured naming convention
type WindowName struct {
	Repo     string
	Worktree string
	Name     string
}

// Format returns the formatted window name
func (w WindowName) Format() string {
	return fmt.Sprintf("%s:%s:%s", w.Repo, w.Worktree, w.Name)
}

// ParseWindowName extracts components from a window name
func ParseWindowName(name string) (*WindowName, error) {
	parts := strings.Split(name, ":")
	if len(parts) != 3 {
		return nil, fmt.Errorf("%w: %s (expected repo:worktree:name)", errors.ErrInvalidWindowName, name)
	}
	return &WindowName{
		Repo:     parts[0],
		Worktree: parts[1],
		Name:     parts[2],
	}, nil
}

// Window represents a tmux window
type Window struct {
	ID     string     // tmux window ID
	Name   WindowName // Structured name
	Index  int
	Active bool
	Path   string
}

// Session represents a tmux session with details
type Session struct {
	Name     string
	Path     string
	Windows  []string
	Attached bool
}

// WindowInfo represents a tmux window (legacy, kept for compatibility)
type WindowInfo struct {
	Index  int
	Name   string
	Active bool
}
