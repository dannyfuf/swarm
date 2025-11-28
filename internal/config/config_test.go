package config

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestConfigValidate(t *testing.T) {
	tmpDir := t.TempDir()

	tests := []struct {
		name    string
		cfg     *Config
		wantErr bool
		errMsg  string
	}{
		{
			name: "valid config",
			cfg: &Config{
				ReposDir:          tmpDir,
				SessionName:       "swarm",
				DefaultBaseBranch: "main",
			},
			wantErr: false,
		},
		{
			name: "empty ReposDir",
			cfg: &Config{
				ReposDir:          "",
				SessionName:       "swarm",
				DefaultBaseBranch: "main",
			},
			wantErr: true,
			errMsg:  "ReposDir is required",
		},
		{
			name: "empty SessionName uses default",
			cfg: &Config{
				ReposDir:          tmpDir,
				SessionName:       "",
				DefaultBaseBranch: "main",
			},
			wantErr: false,
		},
		{
			name: "empty DefaultBaseBranch uses default",
			cfg: &Config{
				ReposDir:          tmpDir,
				SessionName:       "swarm",
				DefaultBaseBranch: "",
			},
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.cfg.Validate()
			if tt.wantErr {
				require.Error(t, err)
				if tt.errMsg != "" {
					assert.Contains(t, err.Error(), tt.errMsg)
				}
			} else {
				require.NoError(t, err)
			}
		})
	}
}

func TestConfigValidateReposDir(t *testing.T) {
	tmpDir := t.TempDir()

	t.Run("ReposDir doesn't exist", func(t *testing.T) {
		cfg := &Config{
			ReposDir:          filepath.Join(tmpDir, "nonexistent"),
			SessionName:       "swarm",
			DefaultBaseBranch: "main",
		}
		err := cfg.Validate()
		require.Error(t, err)
		assert.Contains(t, err.Error(), "repos directory not found")
	})

	t.Run("ReposDir is a file not directory", func(t *testing.T) {
		testFile := filepath.Join(tmpDir, "testfile")
		err := os.WriteFile(testFile, []byte("test"), 0644)
		require.NoError(t, err)

		cfg := &Config{
			ReposDir:          testFile,
			SessionName:       "swarm",
			DefaultBaseBranch: "main",
		}
		err = cfg.Validate()
		require.Error(t, err)
		assert.Contains(t, err.Error(), "ReposDir is not a directory")
	})

	t.Run("ReposDir is valid directory", func(t *testing.T) {
		validDir := filepath.Join(tmpDir, "valid")
		err := os.MkdirAll(validDir, 0755)
		require.NoError(t, err)

		cfg := &Config{
			ReposDir:          validDir,
			SessionName:       "swarm",
			DefaultBaseBranch: "main",
		}
		err = cfg.Validate()
		require.NoError(t, err)
	})
}

func TestConfigDefaults(t *testing.T) {
	tmpDir := t.TempDir()

	t.Run("applies default SessionName", func(t *testing.T) {
		cfg := &Config{
			ReposDir:          tmpDir,
			SessionName:       "",
			DefaultBaseBranch: "main",
		}
		err := cfg.Validate()
		require.NoError(t, err)
		assert.Equal(t, "swarm", cfg.SessionName)
	})

	t.Run("applies default DefaultBaseBranch", func(t *testing.T) {
		cfg := &Config{
			ReposDir:          tmpDir,
			SessionName:       "swarm",
			DefaultBaseBranch: "",
		}
		err := cfg.Validate()
		require.NoError(t, err)
		assert.Equal(t, "main", cfg.DefaultBaseBranch)
	})

	t.Run("preserves custom SessionName", func(t *testing.T) {
		cfg := &Config{
			ReposDir:          tmpDir,
			SessionName:       "custom",
			DefaultBaseBranch: "main",
		}
		err := cfg.Validate()
		require.NoError(t, err)
		assert.Equal(t, "custom", cfg.SessionName)
	})

	t.Run("preserves custom DefaultBaseBranch", func(t *testing.T) {
		cfg := &Config{
			ReposDir:          tmpDir,
			SessionName:       "swarm",
			DefaultBaseBranch: "develop",
		}
		err := cfg.Validate()
		require.NoError(t, err)
		assert.Equal(t, "develop", cfg.DefaultBaseBranch)
	})
}
