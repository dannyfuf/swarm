package tmux

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestWindowNameFormat(t *testing.T) {
	tests := []struct {
		name     string
		wn       WindowName
		expected string
	}{
		{
			name: "standard format",
			wn: WindowName{
				Repo:     "my-repo",
				Worktree: "feature_foo",
				Name:     "editor",
			},
			expected: "my-repo:feature_foo:editor",
		},
		{
			name: "with special characters",
			wn: WindowName{
				Repo:     "repo-name",
				Worktree: "fix_bug_123",
				Name:     "test",
			},
			expected: "repo-name:fix_bug_123:test",
		},
		{
			name: "minimal names",
			wn: WindowName{
				Repo:     "r",
				Worktree: "w",
				Name:     "n",
			},
			expected: "r:w:n",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := tt.wn.Format()
			assert.Equal(t, tt.expected, result)
		})
	}
}

func TestParseWindowName(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    *WindowName
		wantErr bool
	}{
		{
			name:  "valid format",
			input: "my-repo:feature_foo:editor",
			want: &WindowName{
				Repo:     "my-repo",
				Worktree: "feature_foo",
				Name:     "editor",
			},
			wantErr: false,
		},
		{
			name:  "with special characters",
			input: "repo-name:fix_bug_123:test",
			want: &WindowName{
				Repo:     "repo-name",
				Worktree: "fix_bug_123",
				Name:     "test",
			},
			wantErr: false,
		},
		{
			name:    "too few parts",
			input:   "my-repo:feature_foo",
			wantErr: true,
		},
		{
			name:    "too many parts",
			input:   "my-repo:feature_foo:editor:extra",
			wantErr: true,
		},
		{
			name:    "empty string",
			input:   "",
			wantErr: true,
		},
		{
			name:    "single part",
			input:   "my-repo",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseWindowName(tt.input)
			if tt.wantErr {
				require.Error(t, err)
			} else {
				require.NoError(t, err)
				assert.Equal(t, tt.want, got)
			}
		})
	}
}

func TestWindowNameRoundTrip(t *testing.T) {
	tests := []struct {
		name string
		wn   WindowName
	}{
		{
			name: "standard",
			wn: WindowName{
				Repo:     "my-repo",
				Worktree: "feature_foo",
				Name:     "editor",
			},
		},
		{
			name: "with dashes",
			wn: WindowName{
				Repo:     "my-repo-name",
				Worktree: "feature_bug_fix",
				Name:     "test-runner",
			},
		},
		{
			name: "short names",
			wn: WindowName{
				Repo:     "r",
				Worktree: "w",
				Name:     "n",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Format to string
			formatted := tt.wn.Format()

			// Parse back
			parsed, err := ParseWindowName(formatted)
			require.NoError(t, err)

			// Should match original
			assert.Equal(t, &tt.wn, parsed)
		})
	}
}

func TestWindowNameValidation(t *testing.T) {
	t.Run("empty Repo", func(t *testing.T) {
		wn := WindowName{
			Repo:     "",
			Worktree: "feature_foo",
			Name:     "editor",
		}
		formatted := wn.Format()
		parsed, err := ParseWindowName(formatted)
		require.NoError(t, err)
		assert.Empty(t, parsed.Repo)
	})

	t.Run("empty Worktree", func(t *testing.T) {
		wn := WindowName{
			Repo:     "my-repo",
			Worktree: "",
			Name:     "editor",
		}
		formatted := wn.Format()
		parsed, err := ParseWindowName(formatted)
		require.NoError(t, err)
		assert.Empty(t, parsed.Worktree)
	})

	t.Run("empty Name", func(t *testing.T) {
		wn := WindowName{
			Repo:     "my-repo",
			Worktree: "feature_foo",
			Name:     "",
		}
		formatted := wn.Format()
		parsed, err := ParseWindowName(formatted)
		require.NoError(t, err)
		assert.Empty(t, parsed.Name)
	})
}
