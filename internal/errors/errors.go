package errors

import "errors"

// Sentinel errors for programmatic error handling
var (
	ErrNotGitRepo         = errors.New("not a git repository")
	ErrTmuxNotRunning     = errors.New("tmux server not running")
	ErrSessionNotFound    = errors.New("tmux session not found")
	ErrWindowNotFound     = errors.New("tmux window not found")
	ErrInvalidWindowName  = errors.New("invalid window name format")
	ErrReposDirNotFound   = errors.New("repos directory not found")
	ErrGhCliNotFound      = errors.New("gh CLI not installed")
	ErrGhNotAuthenticated = errors.New("gh CLI not authenticated")
)
