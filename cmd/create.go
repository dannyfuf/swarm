package cmd

import (
	"fmt"

	"github.com/microsoft/amplifier/swarm/internal/config"
	"github.com/microsoft/amplifier/swarm/internal/git"
	"github.com/microsoft/amplifier/swarm/internal/prompt"
	"github.com/microsoft/amplifier/swarm/internal/repo"
	"github.com/microsoft/amplifier/swarm/internal/state"
	"github.com/microsoft/amplifier/swarm/internal/tmux"
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
	from     string
	onExists string
}

func init() {
	rootCmd.AddCommand(createCmd)
	createCmd.Flags().StringVar(&createFlags.from, "from", "", "Base branch to create from (default: repo's default branch)")
	createCmd.Flags().StringVar(&createFlags.onExists, "on-exists", "prompt", "Action when branch exists: prompt|use|recreate|fail")
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

	// Check if branch already exists
	branchInfo, err := gitClient.GetBranchInfo(r.Path, branch)
	if err != nil {
		return fmt.Errorf("checking branch: %w", err)
	}

	// Debug output
	fmt.Printf("Debug: Branch '%s' exists=%v, commits=%d\n", branch, branchInfo.Exists, branchInfo.CommitCount)

	var newBranch bool
	var useExisting bool

	if branchInfo.Exists {
		// Branch exists - handle based on flag/prompt
		action := createFlags.onExists

		if action == "prompt" && !prompt.IsInteractive() {
			action = "fail" // Non-interactive defaults to fail
		}

		switch action {
		case "use":
			useExisting = true
			newBranch = false
			fmt.Printf("Using existing branch '%s'\n", branch)

		case "recreate":
			// Delete and recreate
			fmt.Printf("⚠️  Deleting existing branch '%s'\n", branch)

			// Show branch info
			if branchInfo.HasCommits {
				fmt.Println(formatBranchInfo(branchInfo))
				if !confirmDestructive() {
					return fmt.Errorf("cancelled by user")
				}
			}

			if err := gitClient.DeleteBranch(r.Path, branch, true); err != nil {
				return fmt.Errorf("deleting existing branch: %w", err)
			}
			newBranch = true
			useExisting = false

		case "fail":
			return fmt.Errorf("branch '%s' already exists (use --on-exists to handle)", branch)

		case "prompt":
			// Show branch info
			fmt.Printf("\n⚠️  Branch '%s' already exists\n\n", branch)
			fmt.Println(formatBranchInfo(branchInfo))

			options := []string{
				"Use existing branch (checkout existing work)",
				"Delete and recreate (⚠️  will lose commits)",
				"Cancel",
			}

			choice, err := prompt.Choice("What would you like to do?", options, 1)
			if err != nil {
				return fmt.Errorf("getting user choice: %w", err)
			}

			switch choice {
			case 0: // Use existing
				useExisting = true
				newBranch = false
			case 1: // Recreate
				if err := gitClient.DeleteBranch(r.Path, branch, true); err != nil {
					return fmt.Errorf("deleting branch: %w", err)
				}
				newBranch = true
				useExisting = false
			case 2: // Cancel
				return fmt.Errorf("cancelled by user")
			}

		default:
			return fmt.Errorf("invalid --on-exists value: %s", action)
		}
	} else {
		// Branch doesn't exist - create new
		newBranch = true
		useExisting = false
	}

	// Determine base branch
	baseBranch := createFlags.from
	if useExisting {
		// For existing branch, don't specify base branch
		baseBranch = ""
	} else if baseBranch == "" {
		baseBranch = r.DefaultBranch
	}

	// Create worktree
	opts := worktree.CreateOptions{
		Branch:     branch,
		BaseBranch: baseBranch,
		NewBranch:  newBranch,
	}

	wt, err := wtManager.Create(r, opts)
	if err != nil {
		return fmt.Errorf("creating worktree: %w", err)
	}

	fmt.Printf("✓ Created worktree for %s/%s\n", repoName, branch)
	fmt.Printf("  Path: %s\n", wt.Path)
	fmt.Printf("  Slug: %s\n", wt.Slug)

	// Create tmux session if configured
	if cfg.CreateSessionOnCreate {
		tmuxClient := tmux.NewClient()
		sessionName := fmt.Sprintf("%s-%s", repoName, wt.Slug)

		if err := tmuxClient.CreateSession(sessionName, wt.Path); err != nil {
			fmt.Printf("  Warning: failed to create tmux session: %v\n", err)
		} else {
			fmt.Printf("  ✓ Created tmux session: %s\n", sessionName)

			// Update state with session name
			st, _ := stateStore.Load()
			if repoState := st.Repos[repoName]; repoState != nil {
				if wtState := repoState.Worktrees[wt.Slug]; wtState != nil {
					wtState.TmuxSession = sessionName
					stateStore.Save(st)
				}
			}
		}
	}

	return nil
}

func formatBranchInfo(info *git.BranchInfo) string {
	var output string
	output += "  Branch info:\n"

	if info.CommitCount > 0 {
		output += fmt.Sprintf("    • %d commit(s)\n", info.CommitCount)

		if info.LastCommit != nil {
			output += fmt.Sprintf("    • Last commit: %s\n",
				info.LastCommit.Date.Format("2006-01-02"))
		}
	} else {
		output += "    • No commits\n"
	}

	if info.IsMerged {
		output += "    • Merged into main\n"
	} else {
		output += "    • Not merged\n"
	}

	return output
}

func confirmDestructive() bool {
	confirmed, err := prompt.Confirm("Are you sure?", false)
	if err != nil {
		return false
	}
	return confirmed
}
