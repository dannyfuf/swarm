import { describe, expect, test } from "bun:test"
import { buildComposeArgs, ContainerBuildService } from "../../services/ContainerBuildService.js"
import type { Repo } from "../../types/repo.js"
import type { Worktree } from "../../types/worktree.js"

const repo: Repo = {
  name: "repo",
  path: "/repo",
  defaultBranch: "main",
  lastScanned: new Date(),
}

const worktree: Worktree = {
  slug: "feature-x",
  branch: "feature/x",
  path: "/repo__wt__feature-x",
  repoName: "repo",
  createdAt: new Date(),
  lastOpenedAt: new Date(),
  tmuxSession: "repo--wt--feature-x",
  isOrphaned: false,
}

describe("ContainerBuildService", () => {
  test("plans worktree compose metadata", async () => {
    const service = new ContainerBuildService(
      {
        loadForRepo: async () => ({
          path: "/config/docker-compose.yml",
          identity: { name: "repo", path: "/repo", pathHash: "abc123", key: "repo" },
          config: {
            dockerizationDir: "/config/repo",
            composeFilePath: "/config/repo/docker-compose.yml",
            envFilePath: "/config/repo/.env",
            startupScriptPath: null,
          },
        }),
      } as never,
      {
        generateArtifacts: async () => ({
          artifacts: {
            buildDir: "/build/repo/feature-x",
            generatedOverridePath: "/build/repo/feature-x/docker-compose.override.yml",
            generatedEnvPath: "/build/repo/feature-x/.env.worktree",
            composePlanPath: "/build/repo/feature-x/compose-plan.json",
          },
          metadata: {
            projectName: "swarm-repo-feature-x",
            dockerizationDir: "/config/repo",
            composeFiles: [
              "/config/repo/docker-compose.yml",
              "/build/repo/feature-x/docker-compose.override.yml",
            ],
            activeProfiles: ["proxy"],
            generatedOverridePath: "/build/repo/feature-x/docker-compose.override.yml",
            generatedEnvPath: "/build/repo/feature-x/.env.worktree",
            publishedPorts: { APP_PORT: 4301 },
            primaryService: "app",
            primaryUrl: "http://127.0.0.1:4301",
          },
        }),
      } as never,
      {
        allocatePublishedPorts: async () => ({ APP_PORT: 4301 }),
      } as never,
      async () => ({ stdout: "", stderr: "", exitCode: 0, success: true }),
    )

    const plan = await service.planForWorktree(repo, worktree)

    expect(plan.metadata.projectName).toBe("swarm-repo-feature-x")
    expect(plan.metadata.publishedPorts).toEqual({ APP_PORT: 4301 })
  })

  test("buildComposeArgs includes files, project, and env file", () => {
    const args = buildComposeArgs(
      {
        repoIdentity: { name: "repo", path: "/repo", pathHash: "abc123", key: "repo" },
        dockerization: {
          dockerizationDir: "/config/repo",
          composeFilePath: "/config/repo/docker-compose.yml",
          envFilePath: "/config/repo/.env",
          startupScriptPath: null,
        },
        metadata: {
          projectName: "swarm-repo-feature-x",
          dockerizationDir: "/config/repo",
          composeFiles: [
            "/config/repo/docker-compose.yml",
            "/build/repo/feature-x/docker-compose.override.yml",
          ],
          activeProfiles: ["proxy"],
          generatedOverridePath: "/build/repo/feature-x/docker-compose.override.yml",
          generatedEnvPath: "/build/repo/feature-x/.env.worktree",
          publishedPorts: { APP_PORT: 4301 },
          primaryService: "app",
          primaryUrl: "http://127.0.0.1:4301",
        },
        artifacts: {
          buildDir: "/build/repo/feature-x",
          generatedOverridePath: "/build/repo/feature-x/docker-compose.override.yml",
          generatedEnvPath: "/build/repo/feature-x/.env.worktree",
          composePlanPath: "/build/repo/feature-x/compose-plan.json",
        },
        warning: null,
      },
      ["build"],
    )

    expect(args).toEqual([
      "compose",
      "--profile",
      "proxy",
      "-f",
      "/config/repo/docker-compose.yml",
      "-f",
      "/build/repo/feature-x/docker-compose.override.yml",
      "--project-name",
      "swarm-repo-feature-x",
      "--env-file",
      "/build/repo/feature-x/.env.worktree",
      "build",
    ])
  })
})
