import { describe, expect, test } from "bun:test"
import { ContainerRuntimeService } from "../../services/ContainerRuntimeService.js"
import type { ContainerRuntimeStatus } from "../../types/container.js"
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

describe("ContainerRuntimeService", () => {
  test("starts container with expected docker args", async () => {
    const calls: string[][] = []
    let containerInspectCount = 0
    const service = new ContainerRuntimeService(
      {
        buildForRepo: async () => ({
          repoIdentity: { name: "repo", path: "/repo", pathHash: "abc123", key: "repo--abc123" },
          config: {
            schemaVersion: 1,
            repoPath: "/repo",
            preset: "node-web",
            runtime: { baseImage: "node:22", packages: [] },
            env: { file: null, vars: { NODE_ENV: "development" } },
            build: { install: "bun install" },
            setup: { command: null },
            processes: [{ name: "app", command: "bun run dev", expose: true, internalPort: 3000 }],
          },
          dependencyFingerprint: "fingerprint",
          baseImageTag: "swarm/repo:base-abc123",
          dependencyImageTag: "swarm/repo:deps-abc123-fingerprint",
          artifacts: {
            buildDir: "/build",
            baseDockerfilePath: "/build/Dockerfile.base",
            dependencyDockerfilePath: "/build/variant/Dockerfile",
            dependencyContextDir: "/build/variant",
            entrypointPath: "/build/variant/entrypoint.sh",
            processScriptPaths: [],
          },
          warning: null,
        }),
      } as never,
      {
        allocate: async () => 4301,
      } as never,
      async (_command, args) => {
        calls.push(args)

        if (args[0] === "network" && args[1] === "inspect") {
          return { stdout: "", stderr: "not found", exitCode: 1, success: false }
        }

        if (args[0] === "volume" && args[1] === "inspect") {
          return { stdout: "", stderr: "not found", exitCode: 1, success: false }
        }

        if (args[0] === "network" && args[1] === "create") {
          return { stdout: "created", stderr: "", exitCode: 0, success: true }
        }

        if (args[0] === "volume" && args[1] === "create") {
          return { stdout: "created", stderr: "", exitCode: 0, success: true }
        }

        if (args[0] === "inspect") {
          containerInspectCount += 1
          if (containerInspectCount === 1) {
            return { stdout: "", stderr: "No such object", exitCode: 1, success: false }
          }

          return {
            stdout: JSON.stringify({
              Running: true,
              ExitCode: 0,
              Status: "running",
              Health: { Status: "healthy" },
            }),
            stderr: "",
            exitCode: 0,
            success: true,
          }
        }

        if (args[0] === "run") {
          return { stdout: "container-id", stderr: "", exitCode: 0, success: true }
        }

        return { stdout: "ok", stderr: "", exitCode: 0, success: true }
      },
    )

    const result = await service.start(repo, worktree)
    const runCall = calls.find((args) => args[0] === "run")

    expect(runCall).toBeDefined()
    expect(runCall).toContain("-p")
    expect(runCall).toContain("4301:3000")
    expect(runCall).toContain("-e")
    expect(runCall).toContain("NODE_ENV=development")
    expect(result.metadata.primaryHostPort).toBe(4301)
  })

  test("returns stale warning in live status", async () => {
    const service = new ContainerRuntimeService(
      {
        detectDependencyDrift: async () => "Dependency image is stale.",
      } as never,
      {
        allocate: async () => 4301,
      } as never,
      async (_command, args) => {
        if (args[0] === "inspect") {
          return {
            stdout: JSON.stringify({
              Running: true,
              ExitCode: 0,
              Status: "running",
              Health: { Status: "healthy" },
            }),
            stderr: "",
            exitCode: 0,
            success: true,
          }
        }

        return { stdout: "", stderr: "", exitCode: 0, success: true }
      },
    )

    const status = (await service.getStatus(repo, {
      ...worktree,
      container: {
        primaryHostPort: 4301,
        containerName: "container",
        networkName: "network",
        dataVolumeNames: ["vol"],
        baseImageTag: "swarm/repo:base-abc123",
        dependencyImageTag: "swarm/repo:deps-abc123-oldfingerprint",
        dependencyFingerprint: "oldfingerprint",
      },
    })) as ContainerRuntimeStatus

    expect(status.warning).toBe("Dependency image is stale.")
  })
})

describe("ContainerRuntimeService.removeEnvironment", () => {
  test("handles already-removed container gracefully", async () => {
    const service = new ContainerRuntimeService(
      {} as never,
      {} as never,
      async (_command, args) => {
        if (args[0] === "rm") {
          return {
            stdout: "",
            stderr: "Error: No such container: container-name",
            exitCode: 1,
            success: false,
          }
        }
        return { stdout: "", stderr: "", exitCode: 0, success: true }
      },
    )

    const worktreeWithContainer = {
      ...worktree,
      container: {
        primaryHostPort: 4301,
        containerName: "container-name",
        networkName: "network-name",
        dataVolumeNames: ["vol-data"],
        baseImageTag: "swarm/repo:base",
        dependencyImageTag: "swarm/repo:deps",
        dependencyFingerprint: "fp",
      },
    }

    await expect(service.removeEnvironment(worktreeWithContainer)).resolves.toBeUndefined()
  })

  test("handles already-removed network gracefully", async () => {
    const service = new ContainerRuntimeService(
      {} as never,
      {} as never,
      async (_command, args) => {
        if (args[0] === "network" && args[1] === "rm") {
          return {
            stdout: "",
            stderr: "Error: No such network: network-name",
            exitCode: 1,
            success: false,
          }
        }
        return { stdout: "", stderr: "", exitCode: 0, success: true }
      },
    )

    const worktreeWithContainer = {
      ...worktree,
      container: {
        primaryHostPort: 4301,
        containerName: "container-name",
        networkName: "network-name",
        dataVolumeNames: ["vol-data"],
        baseImageTag: "swarm/repo:base",
        dependencyImageTag: "swarm/repo:deps",
        dependencyFingerprint: "fp",
      },
    }

    await expect(service.removeEnvironment(worktreeWithContainer)).resolves.toBeUndefined()
  })

  test("handles already-removed volume gracefully", async () => {
    const service = new ContainerRuntimeService(
      {} as never,
      {} as never,
      async (_command, args) => {
        if (args[0] === "volume" && args[1] === "rm") {
          return {
            stdout: "",
            stderr: "Error: No such volume: vol-data",
            exitCode: 1,
            success: false,
          }
        }
        return { stdout: "", stderr: "", exitCode: 0, success: true }
      },
    )

    const worktreeWithContainer = {
      ...worktree,
      container: {
        primaryHostPort: 4301,
        containerName: "container-name",
        networkName: "network-name",
        dataVolumeNames: ["vol-data"],
        baseImageTag: "swarm/repo:base",
        dependencyImageTag: "swarm/repo:deps",
        dependencyFingerprint: "fp",
      },
    }

    await expect(service.removeEnvironment(worktreeWithContainer)).resolves.toBeUndefined()
  })

  test("throws on real Docker failure", async () => {
    const service = new ContainerRuntimeService(
      {} as never,
      {} as never,
      async (_command, args) => {
        if (args[0] === "rm") {
          return { stdout: "", stderr: "Error: permission denied", exitCode: 1, success: false }
        }
        return { stdout: "", stderr: "", exitCode: 0, success: true }
      },
    )

    const worktreeWithContainer = {
      ...worktree,
      container: {
        primaryHostPort: 4301,
        containerName: "container-name",
        networkName: "network-name",
        dataVolumeNames: ["vol-data"],
        baseImageTag: "swarm/repo:base",
        dependencyImageTag: "swarm/repo:deps",
        dependencyFingerprint: "fp",
      },
    }

    await expect(service.removeEnvironment(worktreeWithContainer)).rejects.toThrow(
      "Failed to remove container",
    )
  })

  test("does nothing when worktree has no container metadata", async () => {
    const service = new ContainerRuntimeService({} as never, {} as never, async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
      success: true,
    }))

    await expect(service.removeEnvironment(worktree)).resolves.toBeUndefined()
  })
})
