import { mkdtemp, mkdir, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { ContainerRuntimeService } from "../../services/ContainerRuntimeService.js"
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
  test("starts compose environment with expected args", async () => {
    const calls: string[][] = []
    const service = new ContainerRuntimeService(
      {
        planForWorktree: async () => ({
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
        }),
        detectDependencyDrift: async () => null,
      } as never,
      async (_command: string, args: string[]) => {
        calls.push(args)

        if (args.includes("ps")) {
          return {
            stdout: JSON.stringify([{ Service: "app", State: "running", Health: "healthy" }]),
            stderr: "",
            exitCode: 0,
            success: true,
          }
        }

        return { stdout: "ok", stderr: "", exitCode: 0, success: true }
      },
    )

    const result = await service.start(repo, worktree)

    expect(calls[0]).toEqual([
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
      "up",
      "-d",
    ])
    expect(result.metadata.publishedPorts).toEqual({ APP_PORT: 4301 })
    expect(result.status.state).toBe("running")
  })

  test("uses compose down with volume cleanup when removing environment", async () => {
    const calls: string[][] = []
    const buildDir = await mkdtemp(join(tmpdir(), "swarm-container-runtime-"))
    await mkdir(join(buildDir, "feature-x"))
    const generatedEnvPath = join(buildDir, "feature-x", ".env.worktree")
    const service = new ContainerRuntimeService(
      {
        detectDependencyDrift: async () => null,
      } as never,
      async (_command: string, args: string[]) => {
        calls.push(args)
        return { stdout: "ok", stderr: "", exitCode: 0, success: true }
      },
    )

    await service.removeEnvironment({
      ...worktree,
      container: {
        projectName: "swarm-repo-feature-x",
        dockerizationDir: "/config/repo",
        composeFiles: ["/config/repo/docker-compose.yml", join(buildDir, "feature-x", "override.yml")],
        activeProfiles: ["proxy"],
        generatedOverridePath: join(buildDir, "feature-x", "override.yml"),
        generatedEnvPath,
        publishedPorts: { APP_PORT: 4301 },
        primaryService: "app",
        primaryUrl: "http://127.0.0.1:4301",
      },
    })

    expect(calls[0]).toEqual([
      "compose",
      "--profile",
      "proxy",
      "-f",
      "/config/repo/docker-compose.yml",
      "-f",
      join(buildDir, "feature-x", "override.yml"),
      "--project-name",
      "swarm-repo-feature-x",
      "--env-file",
      generatedEnvPath,
      "down",
      "-v",
      "--remove-orphans",
    ])
    await expect(stat(join(buildDir, "feature-x"))).rejects.toThrow()
  })

  test("falls back to dangling resource cleanup when compose artifacts are missing", async () => {
    const calls: string[][] = []
    const buildDir = await mkdtemp(join(tmpdir(), "swarm-container-runtime-"))
    const worktreeBuildDir = join(buildDir, "test-1")
    await mkdir(worktreeBuildDir)
    const generatedEnvPath = join(worktreeBuildDir, ".env.worktree")

    const service = new ContainerRuntimeService(
      {
        detectDependencyDrift: async () => null,
      } as never,
      async (_command: string, args: string[]) => {
        calls.push(args)

        if (args.includes("down")) {
          return {
            stdout: "",
            stderr: `couldn't find env file: ${generatedEnvPath}`,
            exitCode: 1,
            success: false,
          }
        }

        if (args[0] === "ps") {
          return {
            stdout: "container-1\ncontainer-2",
            stderr: "",
            exitCode: 0,
            success: true,
          }
        }

        if (args[0] === "network" && args[1] === "ls") {
          return {
            stdout: "network-1",
            stderr: "",
            exitCode: 0,
            success: true,
          }
        }

        if (args[0] === "volume" && args[1] === "ls") {
          return {
            stdout: "volume-1",
            stderr: "",
            exitCode: 0,
            success: true,
          }
        }

        return { stdout: "ok", stderr: "", exitCode: 0, success: true }
      },
    )

    await service.removeEnvironment({
      ...worktree,
      container: {
        projectName: "swarm-repo-test-1",
        dockerizationDir: "/config/repo",
        composeFiles: ["/config/repo/docker-compose.yml", join(worktreeBuildDir, "override.yml")],
        activeProfiles: ["proxy"],
        generatedOverridePath: join(worktreeBuildDir, "override.yml"),
        generatedEnvPath,
        publishedPorts: { APP_PORT: 4301 },
        primaryService: "app",
        primaryUrl: "http://127.0.0.1:4301",
        containerName: "legacy-container",
        networkName: "legacy-network",
        dataVolumeNames: ["legacy-volume"],
      },
    })

    expect(calls).toEqual([
      [
        "compose",
        "--profile",
        "proxy",
        "-f",
        "/config/repo/docker-compose.yml",
        "-f",
        join(worktreeBuildDir, "override.yml"),
        "--project-name",
        "swarm-repo-test-1",
        "--env-file",
        generatedEnvPath,
        "down",
        "-v",
        "--remove-orphans",
      ],
      ["ps", "-aq", "--filter", "label=com.docker.compose.project=swarm-repo-test-1"],
      ["rm", "-f", "container-1", "container-2"],
      ["network", "ls", "-q", "--filter", "label=com.docker.compose.project=swarm-repo-test-1"],
      ["network", "rm", "network-1"],
      ["volume", "ls", "-q", "--filter", "label=com.docker.compose.project=swarm-repo-test-1"],
      ["volume", "rm", "volume-1"],
      ["rm", "-f", "legacy-container"],
      ["network", "rm", "legacy-network"],
      ["volume", "rm", "legacy-volume"],
    ])
    await expect(stat(worktreeBuildDir)).rejects.toThrow()
  })

  test("runs start.sh instead of docker compose up when present", async () => {
    const calls: Array<{ command: string; args: string[]; cwd?: string }> = []
    const service = new ContainerRuntimeService(
      {
        planForWorktree: async () => ({
          repoIdentity: { name: "repo", path: "/repo", pathHash: "abc123", key: "repo" },
          dockerization: {
            dockerizationDir: "/config/repo",
            composeFilePath: "/config/repo/docker-compose.yml",
            envFilePath: "/config/repo/.env",
            startupScriptPath: "/config/repo/start.sh",
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
        }),
        detectDependencyDrift: async () => null,
      } as never,
      async (command: string, args: string[], cwd?: string) => {
        calls.push({ command, args, cwd })

        if (command === "docker" && args.includes("ps")) {
          return {
            stdout: JSON.stringify([{ Service: "app", State: "running", Health: "healthy" }]),
            stderr: "",
            exitCode: 0,
            success: true,
          }
        }

        return { stdout: "ok", stderr: "", exitCode: 0, success: true }
      },
    )

    await service.start(repo, worktree)

    expect(calls[0]).toEqual({
      command: "env",
      args: [
        "SWARM_CONTAINER_PROJECT_NAME=swarm-repo-feature-x",
        "SWARM_CONTAINER_WORKTREE_PATH=/repo__wt__feature-x",
        "SWARM_CONTAINER_REPO_PATH=/repo",
        "SWARM_CONTAINER_DOCKERIZATION_DIR=/config/repo",
        "SWARM_CONTAINER_COMPOSE_FILES=/config/repo/docker-compose.yml:/build/repo/feature-x/docker-compose.override.yml",
        "SWARM_CONTAINER_ENV_FILE=/build/repo/feature-x/.env.worktree",
        "COMPOSE_PROJECT_NAME=swarm-repo-feature-x",
        "COMPOSE_FILE=/config/repo/docker-compose.yml:/build/repo/feature-x/docker-compose.override.yml",
        "COMPOSE_PROFILES=proxy",
        "COMPOSE_ENV_FILES=/build/repo/feature-x/.env.worktree",
        "bash",
        "/config/repo/start.sh",
      ],
      cwd: "/config/repo",
    })
  })

  test("parses newline-delimited compose ps json output", async () => {
    const service = new ContainerRuntimeService(
      {
        detectDependencyDrift: async () => null,
      } as never,
      async (_command: string, args: string[]) => {
        if (args.includes("ps")) {
          return {
            stdout: [
              JSON.stringify({ Service: "app", State: "running", Health: "healthy" }),
              JSON.stringify({ Service: "worker", State: "running", Health: "healthy" }),
            ].join("\n"),
            stderr: "",
            exitCode: 0,
            success: true,
          }
        }

        return { stdout: "", stderr: "", exitCode: 0, success: true }
      },
    )

    const status = await service.getStatus(repo, {
      ...worktree,
      container: {
        projectName: "swarm-repo-feature-x",
        dockerizationDir: "/config/repo",
        composeFiles: ["/config/repo/docker-compose.yml", "/build/repo/feature-x/override.yml"],
        activeProfiles: ["proxy"],
        generatedOverridePath: "/build/repo/feature-x/override.yml",
        generatedEnvPath: "/build/repo/feature-x/.env.worktree",
        publishedPorts: { APP_PORT: 4301 },
        primaryService: "app",
        primaryUrl: "http://127.0.0.1:4301",
      },
    })

    expect(status.state).toBe("running")
    expect(status.services).toHaveLength(2)
  })
})
