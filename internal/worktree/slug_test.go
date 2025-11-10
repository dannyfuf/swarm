package worktree

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestGenerateSlug(t *testing.T) {
	tests := []struct {
		name   string
		branch string
		want   string
	}{
		{
			name:   "simple",
			branch: "main",
			want:   "main",
		},
		{
			name:   "with slash",
			branch: "feature/foo",
			want:   "feature_foo",
		},
		{
			name:   "with multiple slashes",
			branch: "feature/sub/bar",
			want:   "feature_sub_bar",
		},
		{
			name:   "with special chars",
			branch: "bug/fix-#123",
			want:   "bug_fix-123",
		},
		{
			name:   "with spaces",
			branch: "feature with spaces",
			want:   "feature_with_spaces",
		},
		{
			name:   "collapse underscores",
			branch: "feature///foo",
			want:   "feature_foo",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := GenerateSlug(tt.branch)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestGenerateUniqueSlug(t *testing.T) {
	// Existing slugs
	existing := map[string]string{
		"feature_foo":   "feature/foo",
		"feature_foo_2": "feature/foo-v2",
	}

	tests := []struct {
		name   string
		branch string
		want   string
	}{
		{
			name:   "no collision",
			branch: "feature/bar",
			want:   "feature_bar",
		},
		{
			name:   "reuse existing slug for same branch",
			branch: "feature/foo",
			want:   "feature_foo",
		},
		{
			name:   "no collision with suffix",
			branch: "feature/foo-v3",
			want:   "feature_foo-v3",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := GenerateUniqueSlug(tt.branch, existing)
			assert.Equal(t, tt.want, got)
		})
	}
}
