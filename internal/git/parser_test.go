package git

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseWorktreeList(t *testing.T) {
	output := `worktree /path/to/repo
HEAD abc123def456
branch refs/heads/main

worktree /path/to/repo__wt__feature_foo
HEAD def789ghi012
branch refs/heads/feature/foo

worktree /path/to/repo__wt__detached
HEAD 111222333444
detached
`

	parser := &Parser{}
	worktrees, err := parser.ParseWorktreeList(output)

	require.NoError(t, err)
	assert.Len(t, worktrees, 3)

	// First worktree
	assert.Equal(t, "/path/to/repo", worktrees[0].Path)
	assert.Equal(t, "main", worktrees[0].Branch)
	assert.False(t, worktrees[0].Detached)

	// Second worktree
	assert.Equal(t, "feature/foo", worktrees[1].Branch)
	assert.False(t, worktrees[1].Detached)

	// Third worktree
	assert.True(t, worktrees[2].Detached)
}

func TestParseStatus(t *testing.T) {
	output := ` M file1.txt
A  file2.txt
 D file3.txt
?? untracked.txt
`

	parser := &Parser{}
	status, err := parser.ParseStatus(output)

	require.NoError(t, err)
	assert.Contains(t, status.Modified, "file1.txt")
	assert.Contains(t, status.Added, "file2.txt")
	assert.Contains(t, status.Deleted, "file3.txt")
	assert.Contains(t, status.Untracked, "untracked.txt")
}
