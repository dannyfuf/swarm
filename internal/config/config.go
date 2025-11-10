package config

import (
	"time"
)

// Config represents merged configuration
type Config struct {
	AIWorkingDir          string
	DefaultBaseBranch     string
	WorktreePattern       string
	CreateSessionOnCreate bool
	TmuxLayoutScript      string
	StatusCacheTTL        time.Duration
	PreferFzf             bool
	AutoPruneOnRemove     bool
}

// DefaultConfig provides default values
var DefaultConfig = Config{
	AIWorkingDir:          "", // Will be set from env or home dir
	DefaultBaseBranch:     "main",
	WorktreePattern:       "patternA",
	CreateSessionOnCreate: true,
	TmuxLayoutScript:      "",
	StatusCacheTTL:        30 * time.Second,
	PreferFzf:             false,
	AutoPruneOnRemove:     true,
}
