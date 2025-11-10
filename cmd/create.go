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

var createCmd = &cobra.Command{
	Use:   "create <repo> <branch>",
	Short: "Create a new worktree",
	Long:  `Create a new Git worktree for the specified repository and branch.`,
	Args:  cobra.ExactArgs(2),
	RunE:  runCreate,
}

var createFlags struct {
	from string
}

func init() {
	rootCmd.AddCommand(createCmd)
	createCmd.Flags().StringVar(&createFlags.from, "from", "", "Base branch to create from (default: repo's default branch)")
}

func runCreate(cmd *cobra.Command, args []string) error {
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

	// Determine base branch
	baseBranch := createFlags.from
	if baseBranch == "" {
		baseBranch = r.DefaultBranch
	}

	// Create worktree
	opts := worktree.CreateOptions{
		Branch:     branch,
		BaseBranch: baseBranch,
		NewBranch:  true,
	}

	wt, err := wtManager.Create(r, opts)
	if err != nil {
		return fmt.Errorf("creating worktree: %w", err)
	}

	fmt.Printf("✓ Created worktree for %s/%s\n", repoName, branch)
	fmt.Printf("  Path: %s\n", wt.Path)
	fmt.Printf("  Slug: %s\n", wt.Slug)

	return nil
}
