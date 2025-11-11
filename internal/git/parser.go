package git

import (
	"strings"
	"time"
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

func (p *Parser) ParseCommits(output string) ([]Commit, error) {
	var commits []Commit

	lines := strings.Split(output, "\n")
	for _, line := range lines {
		if line == "" {
			continue
		}

		parts := strings.Split(line, "|")
		if len(parts) < 4 {
			continue
		}

		date, _ := time.Parse("2006-01-02 15:04:05 -0700", parts[3])

		commits = append(commits, Commit{
			Hash:    parts[0],
			Message: parts[1],
			Author:  parts[2],
			Date:    date,
		})
	}

	return commits, nil
}
