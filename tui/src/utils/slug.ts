/**
 * Branch-name-to-filesystem-slug conversion utility.
 *
 * Ports the Go `internal/worktree/slug.go` logic. Converts git branch
 * names like "feature/auth-flow" into filesystem-safe slugs like
 * "feature_auth-flow", handling collisions with numeric suffixes.
 */

/** Characters considered unsafe for filesystem slugs. */
const SLUG_UNSAFE_REGEX = /[^a-zA-Z0-9_-]+/g

/** Collapse repeated underscores into one. */
const MULTI_UNDERSCORE_REGEX = /_+/g

/** Clean up underscore-dash adjacency (e.g. "a_-b" or "a-_b"). */
const UNDERSCORE_DASH_REGEX = /_-|-_/g

/** Maximum slug length before truncation. */
const MAX_SLUG_LENGTH = 80

/**
 * Generate a filesystem-safe slug from a git branch name.
 *
 * Transformation steps:
 * 1. Replace `/` with `_`
 * 2. Remove unsafe characters
 * 3. Collapse multiple underscores
 * 4. Clean underscore-dash adjacencies
 * 5. Trim leading/trailing underscores
 * 6. Truncate to 80 characters
 *
 * @example
 * generateSlug("feature/auth-flow")  // "feature_auth-flow"
 * generateSlug("fix/bug///extra")    // "fix_bug_extra"
 */
export function generateSlug(branch: string): string {
  let slug = branch.replaceAll("/", "_")
  slug = slug.replace(SLUG_UNSAFE_REGEX, "_")
  slug = slug.replace(MULTI_UNDERSCORE_REGEX, "_")
  slug = slug.replace(UNDERSCORE_DASH_REGEX, "-")
  slug = slug.replace(/^_+|_+$/g, "")

  if (slug.length > MAX_SLUG_LENGTH) {
    slug = slug.slice(0, MAX_SLUG_LENGTH).replace(/_+$/, "")
  }

  return slug
}

/**
 * Generate a unique slug, handling collisions with existing slugs.
 *
 * If the slug already exists for the same branch, it is reused.
 * If it collides with a different branch, a numeric suffix (_2, _3, ...)
 * is appended until a unique slug is found.
 *
 * @param branch   - The branch name to slugify.
 * @param existing - Map of existing slug -> branch name.
 */
export function generateUniqueSlug(branch: string, existing: Map<string, string>): string {
  const base = generateSlug(branch)

  // Reuse slug if it already maps to the same branch
  const existingBranch = existing.get(base)
  if (existingBranch === branch) {
    return base
  }

  // Find a collision-free slug
  let slug = base
  let suffix = 2
  while (true) {
    const mapped = existing.get(slug)
    if (mapped === undefined || mapped === branch) {
      break
    }
    slug = `${base}_${suffix}`
    suffix++
  }

  return slug
}
