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

var openCmd = &cobra.Command{
	Use:   "open <repo> <branch>",
	Short: "Open a worktree (change directory to it)",
	Long:  `Open a worktree by changing to its directory.`,
	Args:  cobra.ExactArgs(2),
	RunE:  runOpen,
}

func init() {
	rootCmd.AddCommand(openCmd)
}

func runOpen(cmd *cobra.Command, args []string) error {
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

	// Print the path (in a real shell, this would need special handling)
	fmt.Printf("Worktree path: %s\n", targetWt.Path)
	fmt.Printf("To change directory, run: cd %s\n", targetWt.Path)

	return nil
}
