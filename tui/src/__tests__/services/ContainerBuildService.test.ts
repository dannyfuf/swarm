import { describe, expect, test } from "bun:test"
import { ContainerBuildService } from "../../services/ContainerBuildService.js"

describe("ContainerBuildService", () => {
  test("warns on dependency drift without forcing rebuild", async () => {
    const service = new ContainerBuildService(
      {
        loadForRepo: async () => ({
          path: "/config.yml",
          identity: { name: "repo", path: "/repo", pathHash: "abc123", key: "repo--abc123" },
          config: {
            schemaVersion: 1,
            repoPath: "/repo",
            preset: "node-web",
            runtime: { baseImage: "node:22", packages: [] },
            env: { file: null, vars: {} },
            build: { install: "bun install" },
            setup: { command: null },
            processes: [{ name: "app", command: "bun run dev", expose: true, internalPort: 3000 }],
          },
        }),
      } as never,
      {
        compute: async () => ({ fingerprint: "newfingerprint", manifestPaths: [] }),
      } as never,
      {
        generateArtifacts: async () => ({
          buildDir: "/build",
          baseDockerfilePath: "/build/Dockerfile.base",
          dependencyDockerfilePath: "/build/variant/Dockerfile",
          dependencyContextDir: "/build/variant",
          entrypointPath: "/build/variant/entrypoint.sh",
          processScriptPaths: [],
        }),
      } as never,
      async (_command, args) => {
        if (args[0] === "info") {
          return { stdout: "ok", stderr: "", exitCode: 0, success: true }
        }
        if (args[0] === "image") {
          return { stdout: "exists", stderr: "", exitCode: 0, success: true }
        }
        return { stdout: "built", stderr: "", exitCode: 0, success: true }
      },
    )

    const plan = await service.buildForRepo(
      "/repo",
      "/repo__wt__branch",
      {
        primaryHostPort: 4300,
        containerName: "container",
        networkName: "network",
        dataVolumeNames: ["vol"],
        baseImageTag: "swarm/repo:base-abc123",
        dependencyImageTag: "swarm/repo:deps-abc123-oldfingerprint",
        dependencyFingerprint: "oldfingerprint",
      },
      false,
    )

    expect(plan.warning).toContain("Dependency manifests changed")
    expect(plan.dependencyFingerprint).toBe("oldfingerprint")
    expect(plan.dependencyImageTag).toBe("swarm/repo:deps-abc123-oldfingerprint")
  })

  test("detects dependency drift for existing metadata", async () => {
    const service = new ContainerBuildService(
      {
        loadForRepo: async () => ({
          path: "/config.yml",
          identity: { name: "repo", path: "/repo", pathHash: "abc123", key: "repo--abc123" },
          config: {
            schemaVersion: 1,
            repoPath: "/repo",
            preset: "node-web",
            runtime: { baseImage: "node:22", packages: [] },
            env: { file: null, vars: {} },
            build: { install: "bun install" },
            setup: { command: null },
            processes: [{ name: "app", command: "bun run dev", expose: true, internalPort: 3000 }],
          },
        }),
      } as never,
      {
        compute: async () => ({ fingerprint: "newfingerprint", manifestPaths: [] }),
      } as never,
      {
        generateArtifacts: async () => {
          throw new Error("should not generate artifacts for drift checks")
        },
      } as never,
      async () => ({ stdout: "", stderr: "", exitCode: 0, success: true }),
    )

    const warning = await service.detectDependencyDrift("/repo", "/repo__wt__branch", {
      primaryHostPort: 4300,
      containerName: "container",
      networkName: "network",
      dataVolumeNames: ["vol"],
      baseImageTag: "swarm/repo:base-abc123",
      dependencyImageTag: "swarm/repo:deps-abc123-oldfingerprint",
      dependencyFingerprint: "oldfingerprint",
    })

    expect(warning).toContain("Dependency image is stale")
  })
})
