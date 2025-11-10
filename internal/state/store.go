package state

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/gofrs/flock"
)

type Store struct {
	filePath string
	lockPath string
}

func NewStore(aiWorkingDir string) *Store {
	filePath := filepath.Join(aiWorkingDir, ".swarm-state.json")
	lockPath := filepath.Join(aiWorkingDir, ".swarm-state.lock")
	return &Store{
		filePath: filePath,
		lockPath: lockPath,
	}
}

func (s *Store) Load() (*State, error) {
	// Check if file exists
	if _, err := os.Stat(s.filePath); os.IsNotExist(err) {
		// Return empty state
		return &State{
			Version:   1,
			UpdatedAt: time.Now(),
			Repos:     make(map[string]*RepoState),
		}, nil
	}

	// Read file
	data, err := os.ReadFile(s.filePath)
	if err != nil {
		return nil, fmt.Errorf("reading state file: %w", err)
	}

	// Parse JSON
	var state State
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, fmt.Errorf("parsing state file: %w", err)
	}

	return &state, nil
}

func (s *Store) Save(state *State) error {
	// Acquire lock
	lock := flock.New(s.lockPath)
	if err := lock.Lock(); err != nil {
		return fmt.Errorf("acquiring lock: %w", err)
	}
	defer lock.Unlock()

	// Update timestamp
	state.UpdatedAt = time.Now()

	// Marshal to JSON
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return fmt.Errorf("marshaling state: %w", err)
	}

	// Atomic write: write to temp file, then rename
	tmpPath := s.filePath + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0644); err != nil {
		return fmt.Errorf("writing temp file: %w", err)
	}

	if err := os.Rename(tmpPath, s.filePath); err != nil {
		os.Remove(tmpPath) // Clean up
		return fmt.Errorf("renaming temp file: %w", err)
	}

	return nil
}

func (s *Store) UpdateWorktree(repoName string, wt *WorktreeState) error {
	// Load current state
	state, err := s.Load()
	if err != nil {
		return err
	}

	// Ensure repo exists
	if state.Repos[repoName] == nil {
		state.Repos[repoName] = &RepoState{
			Worktrees: make(map[string]*WorktreeState),
		}
	}

	// Update worktree
	state.Repos[repoName].Worktrees[wt.Slug] = wt

	// Save
	return s.Save(state)
}

func (s *Store) RemoveWorktree(repoName, slug string) error {
	state, err := s.Load()
	if err != nil {
		return err
	}

	if state.Repos[repoName] != nil {
		delete(state.Repos[repoName].Worktrees, slug)
	}

	return s.Save(state)
}
