package status

// Badge represents a visual status indicator
type Badge struct {
	Symbol string
	Color  string
	Hint   string
}

// GetBadges returns visual indicators for status
func (s *Status) GetBadges() []Badge {
	var badges []Badge

	if s.HasChanges {
		badges = append(badges, Badge{
			Symbol: "●",
			Color:  "yellow",
			Hint:   "uncommitted changes",
		})
	}

	if s.HasUnpushed {
		badges = append(badges, Badge{
			Symbol: "↑",
			Color:  "cyan",
			Hint:   "unpushed commits",
		})
	}

	if s.BranchMerged != nil && *s.BranchMerged {
		badges = append(badges, Badge{
			Symbol: "✓",
			Color:  "green",
			Hint:   "merged",
		})
	}

	if s.IsOrphaned {
		badges = append(badges, Badge{
			Symbol: "⚠",
			Color:  "red",
			Hint:   "orphaned",
		})
	}

	return badges
}
