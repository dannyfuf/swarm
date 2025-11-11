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

var pruneCmd = &cobra.Command{
	Use:   "prune [repo]",
	Short: "Clean up stale worktree state",
	Long: `Remove worktrees from state that no longer exist in git.

Examples:
  swarm prune fintoc-rails    # Prune specific repo
  swarm prune --all           # Prune all repos`,
	Args: cobra.MaximumNArgs(1),
	RunE: runPrune,
}

var pruneFlags struct {
	all    bool
	dryRun bool
}

func init() {
	rootCmd.AddCommand(pruneCmd)
	pruneCmd.Flags().BoolVar(&pruneFlags.all, "all", false, "Prune all repos")
	pruneCmd.Flags().BoolVar(&pruneFlags.dryRun, "dry-run", false, "Show what would be pruned")
}

func runPrune(cmd *cobra.Command, args []string) error {
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
	detector := worktree.NewOrphanDetector(gitClient, stateStore)

	// Determine which repos to prune
	var repos []repo.Repo
	if pruneFlags.all {
		repos, err = discovery.ScanAll()
		if err != nil {
			return fmt.Errorf("scanning repos: %w", err)
		}
	} else if len(args) > 0 {
		r, err := discovery.FindByName(args[0])
		if err != nil {
			return fmt.Errorf("finding repo: %w", err)
		}
		repos = []repo.Repo{*r}
	} else {
		return fmt.Errorf("specify repo name or use --all")
	}

	// Prune each repo
	totalOrphans := 0
	for _, r := range repos {
		orphans, err := detector.DetectOrphans(&r)
		if err != nil {
			fmt.Printf("Error detecting orphans in %s: %v\n", r.Name, err)
			continue
		}

		if len(orphans) == 0 {
			fmt.Printf("✓ %s: No orphaned worktrees\n", r.Name)
			continue
		}

		fmt.Printf("\n%s: Found %d orphaned worktree(s)\n", r.Name, len(orphans))
		for _, orphan := range orphans {
			fmt.Printf("  • %s (branch: %s)\n", orphan.Slug, orphan.Branch)
			fmt.Printf("    Path: %s\n", orphan.Path)
			fmt.Printf("    Reason: %s\n", orphan.Reason)
		}

		if !pruneFlags.dryRun {
			if err := detector.CleanOrphans(&r, orphans); err != nil {
				fmt.Printf("Error cleaning orphans: %v\n", err)
				continue
			}
			fmt.Printf("✓ Cleaned %d orphaned worktree(s) from state\n", len(orphans))
		}

		totalOrphans += len(orphans)
	}

	if pruneFlags.dryRun {
		fmt.Printf("\nDry run: Would remove %d orphaned worktree(s)\n", totalOrphans)
		fmt.Println("Run without --dry-run to actually clean")
	} else {
		fmt.Printf("\n✓ Pruned %d total orphaned worktree(s)\n", totalOrphans)
	}

	return nil
}
