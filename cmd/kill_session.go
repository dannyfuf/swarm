package cmd

import (
	"fmt"

	"github.com/microsoft/amplifier/swarm/internal/config"
	"github.com/microsoft/amplifier/swarm/internal/git"
	"github.com/microsoft/amplifier/swarm/internal/repo"
	"github.com/microsoft/amplifier/swarm/internal/state"
	"github.com/microsoft/amplifier/swarm/internal/tmux"
	"github.com/microsoft/amplifier/swarm/internal/worktree"
	"github.com/spf13/cobra"
)

var killSessionCmd = &cobra.Command{
	Use:   "kill-session <repo> <branch>",
	Short: "Kill the tmux session for a worktree",
	Long:  `Kill the tmux session associated with a worktree without removing the worktree itself.`,
	Args:  cobra.ExactArgs(2),
	RunE:  runKillSession,
}

func init() {
	rootCmd.AddCommand(killSessionCmd)
}

func runKillSession(cmd *cobra.Command, args []string) error {
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
	tmuxClient := tmux.NewClient()

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
		// Show available worktrees for this repo
		if len(worktrees) == 0 {
			return fmt.Errorf("no worktrees found for repo: %s", repoName)
		}
		fmt.Printf("Worktree not found for branch: %s\n\n", branch)
		fmt.Printf("Available worktrees for %s:\n", repoName)
		for _, wt := range worktrees {
			fmt.Printf("  • %s\n", wt.Branch)
		}
		return fmt.Errorf("worktree not found")
	}

	// Generate session name (same pattern as open command)
	sessionName := fmt.Sprintf("%s-%s", repoName, targetWt.Slug)

	// Check if session exists
	exists, err := tmuxClient.HasSession(sessionName)
	if err != nil {
		return fmt.Errorf("checking tmux session: %w", err)
	}

	if !exists {
		fmt.Printf("No tmux session found for %s/%s\n", repoName, branch)
		fmt.Printf("Worktree preserved at: %s\n", targetWt.Path)
		return nil
	}

	// Kill the session
	if err := tmuxClient.KillSession(sessionName); err != nil {
		return fmt.Errorf("killing tmux session: %w", err)
	}

	fmt.Printf("✓ Killed tmux session for %s/%s\n", repoName, branch)
	fmt.Printf("Worktree preserved at: %s\n", targetWt.Path)

	return nil
}
