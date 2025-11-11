package cmd

import (
	"fmt"
	"strings"

	"github.com/microsoft/amplifier/swarm/internal/tmux"
	"github.com/spf13/cobra"
)

var sessionsCmd = &cobra.Command{
	Use:   "sessions",
	Short: "List all tmux sessions",
	Long:  `Show all active tmux sessions managed by swarm.`,
	RunE:  runSessions,
}

var sessionsFlags struct {
	all bool
}

func init() {
	rootCmd.AddCommand(sessionsCmd)
	sessionsCmd.Flags().BoolVar(&sessionsFlags.all, "all", false,
		"Show all tmux sessions (not just swarm)")
}

func runSessions(cmd *cobra.Command, args []string) error {
	tmuxClient := tmux.NewClient()

	sessions, err := tmuxClient.ListSessionsDetailed()
	if err != nil {
		return fmt.Errorf("listing sessions: %w", err)
	}

	if len(sessions) == 0 {
		fmt.Println("No active tmux sessions")
		return nil
	}

	// Filter to swarm sessions (contain "__wt__") unless --all
	var displaySessions []tmux.Session
	for _, session := range sessions {
		if sessionsFlags.all || strings.Contains(session.Name, "__wt__") {
			displaySessions = append(displaySessions, session)
		}
	}

	if len(displaySessions) == 0 {
		fmt.Println("No swarm tmux sessions found (use --all to see all sessions)")
		return nil
	}

	fmt.Printf("Active sessions (%d):\n\n", len(displaySessions))
	for _, session := range displaySessions {
		status := " "
		if session.Attached {
			status = "●"
		}

		fmt.Printf("  %s %s\n", status, session.Name)
		fmt.Printf("    Path: %s\n", session.Path)
		fmt.Printf("    Windows: %d", len(session.Windows))
		if len(session.Windows) > 0 {
			fmt.Printf(" (%s)", strings.Join(session.Windows, ", "))
		}
		fmt.Println()
		if session.Attached {
			fmt.Printf("    Status: attached\n")
		}
		fmt.Println()
	}

	return nil
}
