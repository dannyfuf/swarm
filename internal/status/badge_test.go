package status

import (
	"testing"
)

func TestGetBadges(t *testing.T) {
	tests := []struct {
		name   string
		status Status
		want   int // number of badges
	}{
		{
			name:   "no status",
			status: Status{},
			want:   0,
		},
		{
			name: "has changes",
			status: Status{
				HasChanges: true,
			},
			want: 1,
		},
		{
			name: "has unpushed",
			status: Status{
				HasUnpushed: true,
			},
			want: 1,
		},
		{
			name: "is merged",
			status: Status{
				BranchMerged: boolPtr(true),
			},
			want: 1,
		},
		{
			name: "is not merged",
			status: Status{
				BranchMerged: boolPtr(false),
			},
			want: 0,
		},
		{
			name: "is orphaned",
			status: Status{
				IsOrphaned: true,
			},
			want: 1,
		},
		{
			name: "multiple statuses",
			status: Status{
				HasChanges:   true,
				HasUnpushed:  true,
				BranchMerged: boolPtr(true),
				IsOrphaned:   true,
			},
			want: 4,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			badges := tt.status.GetBadges()
			if len(badges) != tt.want {
				t.Errorf("GetBadges() returned %d badges, want %d", len(badges), tt.want)
			}
		})
	}
}

func TestBadgeContent(t *testing.T) {
	status := Status{
		HasChanges:   true,
		HasUnpushed:  true,
		BranchMerged: boolPtr(true),
		IsOrphaned:   true,
	}

	badges := status.GetBadges()

	// Verify each badge has required fields
	for i, badge := range badges {
		if badge.Symbol == "" {
			t.Errorf("badge %d missing symbol", i)
		}
		if badge.Color == "" {
			t.Errorf("badge %d missing color", i)
		}
		if badge.Hint == "" {
			t.Errorf("badge %d missing hint", i)
		}
	}

	// Verify specific badge content
	expectedSymbols := map[string]bool{"●": true, "↑": true, "✓": true, "⚠": true}
	expectedColors := map[string]bool{"yellow": true, "cyan": true, "green": true, "red": true}

	for _, badge := range badges {
		if !expectedSymbols[badge.Symbol] {
			t.Errorf("unexpected symbol: %s", badge.Symbol)
		}
		if !expectedColors[badge.Color] {
			t.Errorf("unexpected color: %s", badge.Color)
		}
	}
}

func TestBadgeOrder(t *testing.T) {
	status := Status{
		HasChanges:   true,
		HasUnpushed:  true,
		BranchMerged: boolPtr(true),
		IsOrphaned:   true,
	}

	badges := status.GetBadges()

	// Verify badges appear in expected order
	if len(badges) != 4 {
		t.Fatalf("expected 4 badges, got %d", len(badges))
	}

	if badges[0].Hint != "uncommitted changes" {
		t.Errorf("first badge should be changes, got %s", badges[0].Hint)
	}

	if badges[1].Hint != "unpushed commits" {
		t.Errorf("second badge should be unpushed, got %s", badges[1].Hint)
	}

	if badges[2].Hint != "merged" {
		t.Errorf("third badge should be merged, got %s", badges[2].Hint)
	}

	if badges[3].Hint != "orphaned" {
		t.Errorf("fourth badge should be orphaned, got %s", badges[3].Hint)
	}
}

func boolPtr(b bool) *bool {
	return &b
}
