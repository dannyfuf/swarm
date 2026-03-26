/**
 * Resolves repo/worktree context for directory-local container CLI commands.
 */

import type { Services } from "../state/AppContext.js"
import type { Repo } from "../types/repo.js"
import type { Worktree } from "../types/worktree.js"

export interface ResolvedCliContext {
  repo: Repo
  worktree: Worktree | null
}

export async function resolveContextFromCwd(
  cwd: string,
  services: Services,
): Promise<ResolvedCliContext> {
  const repos = services.repo.scanAll()
  const directRepo = repos.find(
    (candidate) => cwd === candidate.path || cwd.startsWith(`${candidate.path}/`),
  )

  if (directRepo) {
    const worktrees = await services.worktree.list(directRepo)
    const worktree = worktrees.find(
      (candidate) => cwd === candidate.path || cwd.startsWith(`${candidate.path}/`),
    )

    return { repo: directRepo, worktree: worktree ?? null }
  }

  for (const repo of repos) {
    const worktrees = await services.worktree.list(repo)
    const worktree = worktrees.find(
      (candidate) => cwd === candidate.path || cwd.startsWith(`${candidate.path}/`),
    )

    if (worktree) {
      return { repo, worktree }
    }
  }

  throw new Error(`Could not infer a managed repo or worktree from cwd: ${cwd}`)
}
