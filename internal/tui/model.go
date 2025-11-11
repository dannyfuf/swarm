package tui

import (
	"github.com/charmbracelet/bubbles/list"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/microsoft/amplifier/swarm/internal/config"
	"github.com/microsoft/amplifier/swarm/internal/git"
	"github.com/microsoft/amplifier/swarm/internal/repo"
	"github.com/microsoft/amplifier/swarm/internal/safety"
	"github.com/microsoft/amplifier/swarm/internal/status"
	"github.com/microsoft/amplifier/swarm/internal/tmux"
	"github.com/microsoft/amplifier/swarm/internal/worktree"
)

// Panel represents which panel is focused
type Panel int

const (
	PanelRepos Panel = iota
	PanelWorktrees
	PanelDetail
)

// InputMode represents the current input mode
type InputMode int

const (
	InputModeNone InputMode = iota
	InputModeCreate
)

// DialogType represents the type of dialog shown
type DialogType int

const (
	DialogTypeNone DialogType = iota
	DialogTypeDelete
	DialogTypeOrphanCleanup
	DialogTypePruneOrphans
)

// Model represents the TUI state
type Model struct {
	// Views
	repoList     list.Model
	worktreeList list.Model
	detailView   string
	textInput    textinput.Model
	dialog       Dialog

	// Data
	repos        []repo.Repo
	worktrees    []worktree.Worktree
	selectedRepo *repo.Repo
	selectedWT   *worktree.Worktree

	// State
	focusedPanel  Panel
	width         int
	height        int
	inputMode     InputMode
	showDialog    bool
	dialogType    DialogType
	confirmForce  bool
	errorMessage  string
	statusMessage string

	// Dependencies
	cfg            *config.Config
	gitClient      *git.Client
	repoDiscovery  *repo.Discovery
	wtManager      *worktree.Manager
	statusComputer *status.Computer
	safetyChecker  *safety.Checker
	tmuxClient     *tmux.Client
	orphanDetector *worktree.OrphanDetector
}

// New creates a new TUI model
func New(
	cfg *config.Config,
	gitClient *git.Client,
	discovery *repo.Discovery,
	wtManager *worktree.Manager,
	statusComputer *status.Computer,
	safetyChecker *safety.Checker,
	tmuxClient *tmux.Client,
	orphanDetector *worktree.OrphanDetector,
) Model {
	// Initialize empty lists with reasonable defaults
	// These will be properly sized when the first WindowSizeMsg arrives
	repoList := list.New([]list.Item{}, list.NewDefaultDelegate(), 40, 20)
	repoList.Title = "Repositories"
	repoList.SetShowStatusBar(false)
	repoList.SetFilteringEnabled(true)

	worktreeList := list.New([]list.Item{}, list.NewDefaultDelegate(), 40, 20)
	worktreeList.Title = "Worktrees"
	worktreeList.SetShowStatusBar(false)
	worktreeList.SetFilteringEnabled(true)

	// Initialize text input for branch name entry
	ti := textinput.New()
	ti.Placeholder = "feature/my-branch"
	ti.CharLimit = 100
	ti.Width = 50

	return Model{
		cfg:            cfg,
		gitClient:      gitClient,
		repoDiscovery:  discovery,
		wtManager:      wtManager,
		statusComputer: statusComputer,
		safetyChecker:  safetyChecker,
		tmuxClient:     tmuxClient,
		orphanDetector: orphanDetector,
		focusedPanel:   PanelRepos,
		inputMode:      InputModeNone,
		showDialog:     false,
		dialogType:     DialogTypeNone,
		repoList:       repoList,
		worktreeList:   worktreeList,
		textInput:      ti,
		dialog:         Dialog{},
		detailView:     "Select a worktree to view details",
	}
}

// Init initializes the model
func (m Model) Init() tea.Cmd {
	return tea.Batch(
		loadReposCmd(m.repoDiscovery),
		tea.EnterAltScreen,
	)
}
