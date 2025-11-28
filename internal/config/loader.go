package config

import (
	"fmt"
	"os"

	"github.com/microsoft/amplifier/swarm/internal/errors"
)

type Loader struct{}

func NewLoader() *Loader {
	return &Loader{}
}

func (l *Loader) Load() (*Config, error) {
	reposDir := os.Getenv("REPOS_DIR")
	if reposDir == "" {
		return nil, fmt.Errorf("%w: REPOS_DIR environment variable must be set", errors.ErrReposDirNotFound)
	}

	cfg := NewConfig(reposDir)
	if err := cfg.Validate(); err != nil {
		return nil, err
	}

	return cfg, nil
}
