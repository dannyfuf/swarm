package directory

type Config struct {
	ReposDir string // Base directory for repositories
}

type ScanResult struct {
	Path          string
	Name          string
	IsGitRepo     bool
	DefaultBranch string
	Error         error
}
