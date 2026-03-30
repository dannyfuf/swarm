/**
 * Domain types for GitHub remote repository discovery.
 *
 * These types model the data returned from GitHub API and the
 * UI state for the repository browser overlay.
 */

/**
 * A repository discovered from GitHub's API.
 */
export interface RemoteRepo {
  fullName: string
  name: string
  cloneUrl: string
  description: string
  isPrivate: boolean
  defaultBranch: string
  updatedAt: string
}

/**
 * The availability status of a remote repo in the local filesystem.
 */
export type RepoAvailability = "installed" | "available" | "cloning"

/**
 * A remote repo combined with its local availability status.
 */
export interface BrowsableRepo {
  remote: RemoteRepo
  availability: RepoAvailability
}
