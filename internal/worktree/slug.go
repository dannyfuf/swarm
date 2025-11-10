package worktree

import (
	"fmt"
	"regexp"
	"strings"
)

var (
	slugRegex     = regexp.MustCompile(`[^a-zA-Z0-9_-]+`)
	maxSlugLength = 80
)

// GenerateSlug creates filesystem-safe slug from branch name
func GenerateSlug(branch string) string {
	// Replace / with _
	slug := strings.ReplaceAll(branch, "/", "_")

	// Remove unsafe characters
	slug = slugRegex.ReplaceAllString(slug, "_")

	// Collapse multiple underscores
	slug = regexp.MustCompile(`_+`).ReplaceAllString(slug, "_")

	// Clean up underscores adjacent to dashes
	slug = regexp.MustCompile(`_-|-_`).ReplaceAllString(slug, "-")

	// Trim leading/trailing underscores
	slug = strings.Trim(slug, "_")

	// Truncate if too long
	if len(slug) > maxSlugLength {
		slug = slug[:maxSlugLength]
		slug = strings.TrimRight(slug, "_")
	}

	return slug
}

// GenerateUniqueSlug generates slug and handles collisions
func GenerateUniqueSlug(branch string, existing map[string]string) string {
	base := GenerateSlug(branch)

	// Check if slug exists for same branch (reuse it)
	if existingBranch, ok := existing[base]; ok && existingBranch == branch {
		return base
	}

	// Check collision with different branch
	slug := base
	suffix := 2
	for {
		if existingBranch, ok := existing[slug]; !ok || existingBranch == branch {
			break
		}
		slug = fmt.Sprintf("%s_%d", base, suffix)
		suffix++
	}

	return slug
}
