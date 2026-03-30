/**
 * Resolves stable repo identities used for container config and Docker resources.
 */

import { createHash } from "node:crypto"
import { basename } from "node:path"
import type { RepoIdentity } from "../types/container.js"

export class RepoIdentityService {
  fromRepoPath(repoPath: string): RepoIdentity {
    const name = sanitizeName(basename(repoPath))
    const pathHash = createHash("sha256").update(repoPath).digest("hex").slice(0, 12)

    return {
      name,
      path: repoPath,
      pathHash,
      key: name,
    }
  }
}

function sanitizeName(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

  return sanitized || "repo"
}
