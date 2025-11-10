package repo

import "time"

// Repo represents a base repository
type Repo struct {
	Name          string
	Path          string
	DefaultBranch string
	LastScanned   time.Time
}
