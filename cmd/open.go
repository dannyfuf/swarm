package cmd

import (
	"fmt"
	"time"

	"github.com/microsoft/amplifier/swarm/internal/config"
	"github.com/microsoft/amplifier/swarm/internal/git"
	"github.com/microsoft/amplifier/swarm/internal/repo"
	"github.com/microsoft/amplifier/swarm/internal/state"
	"github.com/microsoft/amplifier/swarm/internal/tmux"
	"github.com/microsoft/amplifier/swarm/internal/worktree"
	"github.com/spf13/cobra"
)

var openCmd = &cobra.Command{
	Use:   "open <repo> <branch>",
	Short: "Open a worktree in a tmux session",
	Long:  `Open a worktree by creating or attaching to its tmux session.`,
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
	stateStore := state.NewStore(cfg.ReposDir)
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
		return fmt.Errorf("worktree not found for branch: %s", branch)
	}

	// Generate session name
	sessionName := fmt.Sprintf("%s-%s", repoName, targetWt.Slug)

	// Check if session already exists
	exists, err := tmuxClient.HasSession(sessionName)
	if err != nil {
		return fmt.Errorf("checking tmux session: %w", err)
	}

	if exists {
		// Just attach to existing session
		fmt.Printf("Attaching to existing tmux session: %s\n", sessionName)
		if err := tmuxClient.AttachSession(sessionName); err != nil {
			return fmt.Errorf("attaching to tmux session: %w", err)
		}
	} else {
		// Create new session with layout
		fmt.Printf("Creating new tmux session with layout: %s\n", sessionName)

		// Load layout
		layout, err := tmux.LoadLayout(cfg.TmuxLayoutScript)
		if err != nil {
			fmt.Printf("Warning: failed to load layout, using default: %v\n", err)
			layout = tmux.DefaultLayout()
		}

		// Create session
		if err := tmuxClient.CreateSession(sessionName, targetWt.Path); err != nil {
			return fmt.Errorf("creating tmux session: %w", err)
		}

		// Apply layout
		if err := layout.Apply(sessionName); err != nil {
			fmt.Printf("Warning: failed to apply layout: %v\n", err)
			// Continue anyway - session is created
		}

		// Attach to session
		if err := tmuxClient.AttachSession(sessionName); err != nil {
			return fmt.Errorf("attaching to tmux session: %w", err)
		}
	}

	// Update last opened time in state
	st, err := stateStore.Load()
	if err != nil {
		return fmt.Errorf("loading state: %w", err)
	}

	if repoState := st.Repos[repoName]; repoState != nil {
		if wtState := repoState.Worktrees[targetWt.Slug]; wtState != nil {
			wtState.LastOpenedAt = time.Now()
			wtState.TmuxSession = sessionName
			if err := stateStore.Save(st); err != nil {
				// Non-fatal - just log
				fmt.Printf("Warning: failed to update state: %v\n", err)
			}
		}
	}

	return nil
}
