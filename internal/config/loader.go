package config

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/viper"
)

type Loader struct {
	viper *viper.Viper
}

func NewLoader() *Loader {
	v := viper.New()

	// Set defaults
	v.SetDefault("ai_working_dir", getDefaultAIWorkingDir())
	v.SetDefault("default_base_branch", "main")
	v.SetDefault("worktree_pattern", "patternA")
	v.SetDefault("create_session_on_create", true)
	v.SetDefault("status_cache_ttl", "30s")
	v.SetDefault("auto_prune_on_remove", true)

	// Environment variables (with SWARM_ prefix)
	v.SetEnvPrefix("SWARM")
	v.AutomaticEnv()

	return &Loader{viper: v}
}

func (l *Loader) Load() (*Config, error) {
	// Try user config
	configHome := os.Getenv("XDG_CONFIG_HOME")
	if configHome == "" {
		home, _ := os.UserHomeDir()
		configHome = filepath.Join(home, ".config")
	}

	configPath := filepath.Join(configHome, "swarm")
	l.viper.AddConfigPath(configPath)
	l.viper.SetConfigName("config")
	l.viper.SetConfigType("yaml")

	// Read config (ignore error if file doesn't exist)
	_ = l.viper.ReadInConfig()

	// Build Config struct
	cfg := &Config{
		AIWorkingDir:          l.viper.GetString("ai_working_dir"),
		DefaultBaseBranch:     l.viper.GetString("default_base_branch"),
		WorktreePattern:       l.viper.GetString("worktree_pattern"),
		CreateSessionOnCreate: l.viper.GetBool("create_session_on_create"),
		TmuxLayoutScript:      l.viper.GetString("tmux_layout_script"),
		StatusCacheTTL:        l.viper.GetDuration("status_cache_ttl"),
		PreferFzf:             l.viper.GetBool("prefer_fzf"),
		AutoPruneOnRemove:     l.viper.GetBool("auto_prune_on_remove"),
	}

	// Validate
	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("invalid config: %w", err)
	}

	return cfg, nil
}

func getDefaultAIWorkingDir() string {
	// Check environment
	if dir := os.Getenv("AI_WORKING_DIR"); dir != "" {
		return dir
	}

	// Default: ~/amplifier/ai_working
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "amplifier", "ai_working")
}
