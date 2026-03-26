import { describe, expect, test } from "bun:test"
import { generateSlug, generateUniqueSlug } from "../../utils/slug.js"

describe("generateSlug", () => {
  test("converts forward slashes to underscores", () => {
    expect(generateSlug("feature/auth-flow")).toBe("feature_auth-flow")
  })

  test("collapses multiple slashes into single underscore", () => {
    expect(generateSlug("fix/bug///extra")).toBe("fix_bug_extra")
  })

  test("removes unsafe characters", () => {
    expect(generateSlug("feat@#$%name")).toBe("feat_name")
  })

  test("trims leading and trailing underscores", () => {
    expect(generateSlug("/leading/")).toBe("leading")
  })

  test("handles simple branch names", () => {
    expect(generateSlug("main")).toBe("main")
    expect(generateSlug("develop")).toBe("develop")
  })

  test("preserves hyphens", () => {
    expect(generateSlug("fix-bug-123")).toBe("fix-bug-123")
  })

  test("cleans underscore-dash adjacency", () => {
    // "a_-b" has underscore-dash adjacency, collapses to "a-b"
    expect(generateSlug("a_-b")).toBe("a-b")
  })

  test("truncates to 80 characters", () => {
    const long = "a".repeat(100)
    const slug = generateSlug(long)
    expect(slug.length).toBeLessThanOrEqual(80)
  })

  test("cleans trailing underscores after truncation", () => {
    // Create a string that when truncated at 80 chars would end with underscore
    const branch = `${"a".repeat(79)}/b`
    const slug = generateSlug(branch)
    expect(slug).not.toMatch(/_$/)
    expect(slug.length).toBeLessThanOrEqual(80)
  })

  test("handles empty string", () => {
    expect(generateSlug("")).toBe("")
  })
})

describe("generateUniqueSlug", () => {
  test("returns base slug when no collisions", () => {
    const existing = new Map<string, string>()
    expect(generateUniqueSlug("feature/auth", existing)).toBe("feature_auth")
  })

  test("reuses slug when mapped to same branch", () => {
    const existing = new Map([["feature_auth", "feature/auth"]])
    expect(generateUniqueSlug("feature/auth", existing)).toBe("feature_auth")
  })

  test("appends _2 suffix on first collision", () => {
    const existing = new Map([["feature_auth", "feature/other"]])
    expect(generateUniqueSlug("feature/auth", existing)).toBe("feature_auth_2")
  })

  test("increments suffix for multiple collisions", () => {
    const existing = new Map([
      ["feature_auth", "feature/other"],
      ["feature_auth_2", "feature/another"],
    ])
    expect(generateUniqueSlug("feature/auth", existing)).toBe("feature_auth_3")
  })

  test("handles empty existing map", () => {
    const existing = new Map<string, string>()
    expect(generateUniqueSlug("main", existing)).toBe("main")
  })
})
