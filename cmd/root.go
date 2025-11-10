package cmd

import (
	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:   "swarm",
	Short: "Git worktree + tmux session manager",
	Long: `Swarm manages Git worktrees with dedicated tmux sessions
for parallel development workflows.`,
}

func Execute() error {
	return rootCmd.Execute()
}

func init() {
	// Global flags
	rootCmd.PersistentFlags().String("ai-working-dir", "",
		"Override AI_WORKING_DIR location")
	rootCmd.PersistentFlags().Bool("dry-run", false,
		"Show what would be done without doing it")
}
