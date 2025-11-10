package cmd

import (
	"fmt"

	"github.com/microsoft/amplifier/swarm/internal/config"
	"github.com/microsoft/amplifier/swarm/internal/git"
	"github.com/microsoft/amplifier/swarm/internal/repo"
	"github.com/microsoft/amplifier/swarm/internal/state"
	"github.com/microsoft/amplifier/swarm/internal/worktree"
	"github.com/spf13/cobra"
)

var removeCmd = &cobra.Command{
	Use:   "remove <repo> <branch>",
	Short: "Remove a worktree",
	Long:  `Remove a worktree and clean up its files.`,
	Args:  cobra.ExactArgs(2),
	RunE:  runRemove,
}

var removeFlags struct {
	force bool
}

func init() {
	rootCmd.AddCommand(removeCmd)
	removeCmd.Flags().BoolVarP(&removeFlags.force, "force", "f", false, "Force removal even if there are uncommitted changes")
}

func runRemove(cmd *cobra.Command, args []string) error {
	repoName := args[0]
	branch := args[1]

	// Load config
	loader := config.NewLoader()
	cfg, err := loader.Load()
	if err != nil {
		return fmt.Errorf("loading config: %w", err)
	}

	// Initialize dependencies
	gitClient := git.NewClient()
	stateStore := state.NewStore(cfg.AIWorkingDir)
	discovery := repo.NewDiscovery(cfg, gitClient)
	wtManager := worktree.NewManager(cfg, gitClient, stateStore)

	// Find repo
	r, err := discovery.FindByName(repoName)
	if err != nil {
		return fmt.Errorf("finding repo: %w", err)
	}

	// List worktrees to find the one we want
	worktrees, err := wtManager.List(r)
	if err != nil {
		return fmt.Errorf("listing worktrees: %w", err)
	}

	// Find matching worktree
	var targetWt *worktree.Worktree
	for i := range worktrees {
		if worktrees[i].Branch == branch {
			targetWt = &worktrees[i]
			break
		}
	}

	if targetWt == nil {
		return fmt.Errorf("worktree not found for branch: %s", branch)
	}

	// Remove worktree
	if err := wtManager.Remove(targetWt, removeFlags.force); err != nil {
		return fmt.Errorf("removing worktree: %w", err)
	}

	fmt.Printf("✓ Removed worktree for %s/%s\n", repoName, branch)

	return nil
}
