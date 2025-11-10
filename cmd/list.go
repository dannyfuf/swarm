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

var listCmd = &cobra.Command{
	Use:   "list [repo]",
	Short: "List worktrees",
	Long:  `List all worktrees for a repository, or all repositories if no repo specified.`,
	Args:  cobra.MaximumNArgs(1),
	RunE:  runList,
}

func init() {
	rootCmd.AddCommand(listCmd)
}

func runList(cmd *cobra.Command, args []string) error {
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

	// If repo specified, list its worktrees
	if len(args) > 0 {
		repoName := args[0]
		r, err := discovery.FindByName(repoName)
		if err != nil {
			return fmt.Errorf("finding repo: %w", err)
		}

		worktrees, err := wtManager.List(r)
		if err != nil {
			return fmt.Errorf("listing worktrees: %w", err)
		}

		if len(worktrees) == 0 {
			fmt.Printf("No worktrees for %s\n", repoName)
			return nil
		}

		fmt.Printf("Worktrees for %s:\n", repoName)
		for _, wt := range worktrees {
			fmt.Printf("  %s → %s\n", wt.Slug, wt.Branch)
			fmt.Printf("    Path: %s\n", wt.Path)
		}

		return nil
	}

	// List all repos and their worktrees
	repos, err := discovery.ScanAll()
	if err != nil {
		return fmt.Errorf("scanning repos: %w", err)
	}

	if len(repos) == 0 {
		fmt.Println("No repositories found")
		return nil
	}

	for _, r := range repos {
		worktrees, err := wtManager.List(&r)
		if err != nil {
			fmt.Printf("Error listing worktrees for %s: %v\n", r.Name, err)
			continue
		}

		if len(worktrees) > 0 {
			fmt.Printf("\n%s:\n", r.Name)
			for _, wt := range worktrees {
				fmt.Printf("  %s → %s\n", wt.Slug, wt.Branch)
			}
		}
	}

	return nil
}
