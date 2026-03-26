/**
 * Domain types for long-running TUI activities.
 *
 * These activity records drive concurrent spinner rendering and scoped UI hints.
 */

export type ActivityKind =
  | "build-container-image"
  | "clone-repo"
  | "create-and-start-worktree"
  | "create-worktree"
  | "delete-worktree"
  | "refresh"
  | "start-container"

export type ActivityPriority = "background" | "foreground"

export interface ActivityScope {
  repoPath: string
  worktreePath?: string
  branch?: string
}

export interface ActivityDraft {
  kind: ActivityKind
  label: string
  scope: ActivityScope
  priority: ActivityPriority
}

export interface ActiveOperation extends ActivityDraft {
  id: string
  startedAt: Date
}
