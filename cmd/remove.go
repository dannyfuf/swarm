package cmd

import (
	"fmt"

	"github.com/microsoft/amplifier/swarm/internal/config"
	"github.com/microsoft/amplifier/swarm/internal/git"
	"github.com/microsoft/amplifier/swarm/internal/prompt"
	"github.com/microsoft/amplifier/swarm/internal/repo"
	"github.com/microsoft/amplifier/swarm/internal/safety"
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
	force  bool
	branch string
}

func init() {
	rootCmd.AddCommand(removeCmd)
	removeCmd.Flags().BoolVarP(&removeFlags.force, "force", "f", false, "Force removal even if there are uncommitted changes")
	removeCmd.Flags().StringVar(&removeFlags.branch, "branch", "prompt", "Branch handling: prompt|keep|delete")
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
	stateStore := state.NewStore(cfg.ReposDir)
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

	// Safety checks (unless --force)
	if !removeFlags.force {
		checker := safety.NewChecker(gitClient)
		result, err := checker.CheckRemoval(targetWt)
		if err != nil {
			return fmt.Errorf("safety check failed: %w", err)
		}

		if !result.Safe {
			// Print blockers
			fmt.Println(safety.FormatResult(result, true))
			fmt.Println("\nUse --force to remove anyway")
			return fmt.Errorf("removal blocked by safety checks")
		}

		// Print warnings but allow to continue
		if len(result.Warnings) > 0 {
			fmt.Println(safety.FormatResult(result, true))
			fmt.Print("\nContinue? [y/N]: ")

			var response string
			fmt.Scanln(&response)
			if response != "y" && response != "Y" {
				return fmt.Errorf("removal cancelled by user")
			}
		}
	}

	// Remove worktree
	if err := wtManager.Remove(targetWt, removeFlags.force); err != nil {
		return fmt.Errorf("removing worktree: %w", err)
	}

	fmt.Printf("✓ Removed worktree for %s/%s\n", repoName, branch)

	// Handle branch deletion
	if err := handleBranchCleanup(gitClient, r.Path, branch); err != nil {
		fmt.Printf("Warning: %v\n", err)
		// Don't fail the command - worktree is already removed
	}

	return nil
}

func handleBranchCleanup(gitClient *git.Client, repoPath, branch string) error {
	action := removeFlags.branch

	// Debug: Show what we're doing
	isInteractive := prompt.IsInteractive()

	if action == "prompt" && !isInteractive {
		action = "keep" // Non-interactive defaults to keep
		fmt.Printf("  (Non-interactive mode detected, keeping branch)\n")
	}

	switch action {
	case "keep":
		// Do nothing, branch remains
		fmt.Printf("  Branch '%s' kept\n", branch)
		return nil

	case "delete":
		// Delete without prompting
		if err := deleteBranchWithCheck(gitClient, repoPath, branch); err != nil {
			return err
		}
		fmt.Printf("  ✓ Deleted branch '%s'\n", branch)
		return nil

	case "prompt":
		// Get branch info and prompt user
		branchInfo, err := gitClient.GetBranchInfo(repoPath, branch)
		if err != nil {
			return fmt.Errorf("checking branch: %w", err)
		}

		if !branchInfo.Exists {
			// Branch already deleted somehow
			return nil
		}

		// Show branch status
		fmt.Println()
		fmt.Printf("Branch '%s' status:\n", branch)
		if branchInfo.CommitCount == 0 {
			fmt.Println("  • No commits (empty branch)")
		} else {
			fmt.Printf("  • %d commit(s)\n", branchInfo.CommitCount)

			// Check unpushed
			unpushed, err := gitClient.UnpushedCommits(repoPath, branch)
			if err == nil && len(unpushed) > 0 {
				fmt.Printf("  • %d unpushed commit(s) ⚠️\n", len(unpushed))
			}

			if branchInfo.IsMerged {
				fmt.Println("  • Merged into main ✓")
			} else {
				fmt.Println("  • Not merged ⚠️")
			}
		}

		fmt.Println()

		options := []string{
			"Keep branch (preserve work for later)",
			"Delete branch",
		}

		// Suggest delete for merged branches or empty branches
		defaultChoice := 1
		if branchInfo.IsMerged || branchInfo.CommitCount == 0 {
			defaultChoice = 2
		}

		choice, err := prompt.Choice("Delete the branch?", options, defaultChoice)
		if err != nil {
			return fmt.Errorf("getting user choice: %w", err)
		}

		if choice == 1 { // Delete
			if err := deleteBranchWithCheck(gitClient, repoPath, branch); err != nil {
				return err
			}
			fmt.Printf("  ✓ Deleted branch '%s'\n", branch)
		} else {
			fmt.Printf("  Branch '%s' kept\n", branch)
		}

		return nil

	default:
		return fmt.Errorf("invalid --branch value: %s", action)
	}
}

func deleteBranchWithCheck(gitClient *git.Client, repoPath, branch string) error {
	// Try safe delete first
	err := gitClient.DeleteBranch(repoPath, branch, false)
	if err == nil {
		return nil
	}

	// If safe delete fails, it's probably unmerged
	// Ask for confirmation before force delete
	if prompt.IsInteractive() {
		fmt.Println("⚠️  Branch is not fully merged")
		confirmed, err := prompt.Confirm("Force delete anyway?", false)
		if err != nil || !confirmed {
			return fmt.Errorf("branch deletion cancelled")
		}
	}

	return gitClient.DeleteBranch(repoPath, branch, true)
}
