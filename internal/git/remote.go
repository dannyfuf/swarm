package git

import (
	"encoding/json"
	"fmt"
	"os/exec"

	"github.com/microsoft/amplifier/swarm/internal/errors"
)

// GhCliAvailable checks if the GitHub CLI is installed and available
func GhCliAvailable() bool {
	_, err := exec.LookPath("gh")
	return err == nil
}

// GhCliAuthenticated checks if the GitHub CLI is authenticated
func GhCliAuthenticated() error {
	if !GhCliAvailable() {
		return errors.ErrGhCliNotFound
	}

	cmd := exec.Command("gh", "auth", "status")
	output, err := cmd.CombinedOutput()
	if err != nil {
		// gh auth status exits non-zero when not authenticated
		return fmt.Errorf("%w: %s", errors.ErrGhNotAuthenticated, string(output))
	}
	return nil
}

// ghRepoListItem represents a single repo from `gh repo list --json`
type ghRepoListItem struct {
	Name          string `json:"name"`
	NameWithOwner string `json:"nameWithOwner"`
	URL           string `json:"url"`
	Description   string `json:"description"`
	DefaultBranch struct {
		Name string `json:"name"`
	} `json:"defaultBranchRef"`
	IsPrivate bool `json:"isPrivate"`
}

// ListRemoteRepos lists remote repositories the user has access to via gh CLI
//
// Prerequisites:
// - gh CLI must be installed (brew install gh / apt install gh)
// - gh CLI must be authenticated (gh auth login)
//
// Returns:
// - ErrGhCliNotFound if gh is not installed
// - ErrGhNotAuthenticated if gh is not authenticated
func (c *Client) ListRemoteRepos() ([]RemoteRepo, error) {
	// Check prerequisites
	if !GhCliAvailable() {
		return nil, errors.ErrGhCliNotFound
	}

	if err := GhCliAuthenticated(); err != nil {
		return nil, err
	}

	// Execute gh repo list with JSON output
	// --limit 100 is reasonable default, can be made configurable later
	cmd := exec.Command("gh", "repo", "list",
		"--json", "name,nameWithOwner,url,description,defaultBranchRef,isPrivate",
		"--limit", "100")

	output, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("listing remote repos: %w\nOutput: %s", err, output)
	}

	var items []ghRepoListItem
	if err := json.Unmarshal(output, &items); err != nil {
		return nil, fmt.Errorf("parsing gh output: %w", err)
	}

	var repos []RemoteRepo
	for _, item := range items {
		defaultBranch := item.DefaultBranch.Name
		if defaultBranch == "" {
			defaultBranch = "main" // fallback
		}

		repos = append(repos, RemoteRepo{
			Name:          item.Name,
			FullName:      item.NameWithOwner,
			URL:           item.URL,
			Description:   item.Description,
			DefaultBranch: defaultBranch,
			Provider:      "github",
			IsPrivate:     item.IsPrivate,
		})
	}

	return repos, nil
}
