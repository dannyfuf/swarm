/**
 * GitHub API service for remote repository discovery.
 *
 * Uses the git credential helper to obtain a GitHub token, then
 * fetches the list of accessible repositories via the REST API.
 */

import type { RemoteRepo } from "../types/github.js"
import { exec as execAsync } from "../utils/shell.js"

const GITHUB_API_BASE = "https://api.github.com"
const REPOS_PER_PAGE = 100
/** Maximum time in ms to wait for a credential helper response. */
const CREDENTIAL_TIMEOUT_MS = 5_000

export class GitHubService {
  /**
   * List all repositories the authenticated user has access to.
   *
   * Fetches repos where the user is owner, collaborator, or organization member.
   */
  async listAccessibleRepos(): Promise<RemoteRepo[]> {
    const token = await this.getGitHubToken()
    if (!token) {
      throw new Error(
        "No GitHub credentials found. Run 'gh auth login' or configure git credentials for github.com.",
      )
    }

    const repos = await this.fetchAllRepos(token)
    return repos.sort((a, b) => a.fullName.localeCompare(b.fullName))
  }

  /**
   * Clone a repository to the target directory.
   */
  async cloneRepo(cloneUrl: string, targetDir: string): Promise<void> {
    const result = await execAsync("git", ["clone", cloneUrl, targetDir])
    if (!result.success) {
      throw new Error(`git clone failed: ${result.stderr}`)
    }
  }

  /**
   * Get a GitHub personal access token.
   *
   * Tries `git credential fill` first (works with any configured credential
   * helper), then falls back to `gh auth token` for users who have the GitHub
   * CLI installed but haven't run `gh auth setup-git`.
   *
   * Both methods use a timeout to avoid hanging on interactive prompts.
   */
  private async getGitHubToken(): Promise<string | null> {
    // Try git credential fill — works with osxkeychain, credential-store,
    // gh's credential helper, etc.
    const credResult = await execCredentialFill({
      protocol: "https",
      host: "github.com",
    })

    if (credResult.success) {
      const passwordMatch = credResult.stdout.match(/^password=(.+)$/m)
      if (passwordMatch?.[1]) {
        return passwordMatch[1]
      }
    }

    // Fall back to gh CLI — covers the common case where gh is installed
    // and logged in but its credential helper isn't registered with git.
    const ghResult = await execAsync("gh", ["auth", "token"]).catch(() => null)
    if (ghResult?.success && ghResult.stdout.trim()) {
      return ghResult.stdout.trim()
    }

    return null
  }

  /**
   * Fetch all repos from GitHub API with pagination.
   */
  private async fetchAllRepos(token: string): Promise<RemoteRepo[]> {
    const allRepos: RemoteRepo[] = []
    let page = 1

    while (true) {
      const pageRepos = await this.fetchReposPage(token, page)
      if (pageRepos.length === 0) {
        break
      }
      allRepos.push(...pageRepos)
      if (pageRepos.length < REPOS_PER_PAGE) {
        break
      }
      page++
    }

    return allRepos
  }

  /**
   * Fetch a single page of repos from GitHub API.
   */
  private async fetchReposPage(token: string, page: number): Promise<RemoteRepo[]> {
    const url = new URL(`${GITHUB_API_BASE}/user/repos`)
    url.searchParams.set("per_page", String(REPOS_PER_PAGE))
    url.searchParams.set("page", String(page))
    url.searchParams.set("sort", "updated")
    url.searchParams.set("affiliation", "owner,collaborator,organization_member")

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "swarm-tui",
      },
    })

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error("GitHub authentication failed. Check your credentials.")
      }
      if (response.status === 403) {
        throw new Error("GitHub API rate limit exceeded. Try again later.")
      }
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`)
    }

    const data = await response.json()
    return parseGitHubReposResponse(data)
  }
}

/**
 * Parse the GitHub API response into RemoteRepo objects.
 */
function parseGitHubReposResponse(data: unknown): RemoteRepo[] {
  if (!Array.isArray(data)) {
    return []
  }

  return data
    .filter((repo): repo is Record<string, unknown> => typeof repo === "object" && repo !== null)
    .map((repo) => {
      const fullName = typeof repo.full_name === "string" ? repo.full_name : ""
      const name = typeof repo.name === "string" ? repo.name : ""
      const cloneUrl = typeof repo.clone_url === "string" ? repo.clone_url : ""
      const description = typeof repo.description === "string" ? repo.description : ""
      const isPrivate = repo.private === true
      const defaultBranch = typeof repo.default_branch === "string" ? repo.default_branch : "main"
      const updatedAt = typeof repo.updated_at === "string" ? repo.updated_at : ""

      return {
        fullName,
        name,
        cloneUrl,
        description,
        isPrivate,
        defaultBranch,
        updatedAt,
      }
    })
    .filter((repo) => repo.fullName && repo.cloneUrl)
}

/**
 * Execute `git credential fill` with stdin input and a timeout.
 *
 * The timeout prevents the TUI from freezing when the credential helper
 * spawns an interactive or GUI prompt that cannot be answered.
 */
async function execCredentialFill(
  fields: Record<string, string>,
): Promise<{ stdout: string; stderr: string; success: boolean }> {
  const stdin = `${Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n\n`

  const proc = Bun.spawn(["git", "credential", "fill"], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
  })

  proc.stdin.write(stdin)
  await proc.stdin.end()

  const result = await Promise.race([
    (async () => {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      const exitCode = await proc.exited
      return { stdout: stdout.trim(), stderr: stderr.trim(), success: exitCode === 0 }
    })(),
    new Promise<{ stdout: string; stderr: string; success: boolean }>((resolve) => {
      setTimeout(() => {
        proc.kill()
        resolve({ stdout: "", stderr: "credential helper timed out", success: false })
      }, CREDENTIAL_TIMEOUT_MS)
    }),
  ])

  return result
}
