package directory

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/microsoft/amplifier/swarm/internal/errors"
)

type Scanner struct {
	config Config
}

func NewScanner(config Config) *Scanner {
	return &Scanner{config: config}
}

// GetReposDir returns the configured repositories directory
func (s *Scanner) GetReposDir() string {
	return s.config.ReposDir
}

// SetReposDir updates the repositories directory
func (s *Scanner) SetReposDir(path string) error {
	// Validate path exists and is a directory
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("%w: %s", errors.ErrReposDirNotFound, path)
		}
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("path is not a directory: %s", path)
	}
	s.config.ReposDir = path
	return nil
}

// ScanForRepos scans the configured directory for all subdirectories
func (s *Scanner) ScanForRepos() ([]ScanResult, error) {
	entries, err := os.ReadDir(s.config.ReposDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("%w: %s", errors.ErrReposDirNotFound, s.config.ReposDir)
		}
		return nil, err
	}

	var results []ScanResult
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}

		repoPath := filepath.Join(s.config.ReposDir, entry.Name())
		result := ScanResult{
			Path: repoPath,
			Name: entry.Name(),
		}

		// Check for .git directory
		gitDir := filepath.Join(repoPath, ".git")
		if _, err := os.Stat(gitDir); err == nil {
			result.IsGitRepo = true
		}

		results = append(results, result)
	}

	return results, nil
}

// ListGitRepos returns only directories that are git repositories
// This is a convenience method that filters ScanForRepos results
func (s *Scanner) ListGitRepos() ([]ScanResult, error) {
	allResults, err := s.ScanForRepos()
	if err != nil {
		return nil, err
	}

	var gitRepos []ScanResult
	for _, result := range allResults {
		if result.IsGitRepo {
			gitRepos = append(gitRepos, result)
		}
	}

	return gitRepos, nil
}
