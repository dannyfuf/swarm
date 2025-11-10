package git

import (
	"strings"
)

type Parser struct{}

func (p *Parser) ParseWorktreeList(output string) ([]WorktreeInfo, error) {
	var worktrees []WorktreeInfo
	var current *WorktreeInfo

	lines := strings.Split(output, "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			if current != nil {
				worktrees = append(worktrees, *current)
				current = nil
			}
			continue
		}

		parts := strings.SplitN(line, " ", 2)
		key := parts[0]
		var value string
		if len(parts) > 1 {
			value = parts[1]
		}

		if key == "worktree" {
			current = &WorktreeInfo{Path: value}
		} else if current != nil {
			switch key {
			case "HEAD":
				current.Commit = value
			case "branch":
				// refs/heads/feature/foo -> feature/foo
				current.Branch = strings.TrimPrefix(value, "refs/heads/")
			case "detached":
				current.Detached = true
			}
		}
	}

	// Don't forget last one
	if current != nil {
		worktrees = append(worktrees, *current)
	}

	return worktrees, nil
}

func (p *Parser) ParseStatus(output string) (*StatusResult, error) {
	result := &StatusResult{}

	lines := strings.Split(output, "\n")
	for _, line := range lines {
		if len(line) < 4 {
			continue
		}

		status := line[0:2]
		file := strings.TrimSpace(line[3:])

		switch {
		case status[0] == 'M' || status[1] == 'M':
			result.Modified = append(result.Modified, file)
		case status[0] == 'A':
			result.Added = append(result.Added, file)
		case status[0] == 'D' || status[1] == 'D':
			result.Deleted = append(result.Deleted, file)
		case status == "??":
			result.Untracked = append(result.Untracked, file)
		}
	}

	return result, nil
}
