package cmd

import (
	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:   "swarm",
	Short: "Git worktree + tmux window manager",
	Long: `Swarm manages Git worktrees with tmux windows
for parallel development workflows.`,
	// No RunE - require subcommand usage
}

func Execute() error {
	return rootCmd.Execute()
}

func init() {
	// Global flags
	rootCmd.PersistentFlags().String("repos-dir", "",
		"Override REPOS_DIR location")
	rootCmd.PersistentFlags().String("session-name", "swarm",
		"Tmux session name (default: swarm)")
}
