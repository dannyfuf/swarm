import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { DockerArtifactService } from "../../services/DockerArtifactService.js"

const tempRoot = join(process.cwd(), "tmp-docker-artifact-tests")

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

describe("DockerArtifactService", () => {
  test("writes override ports with compose override tag", async () => {
    const dockerizationDir = join(tempRoot, "dockerization")
    const composeFilePath = join(dockerizationDir, "docker-compose.yml")

    await mkdir(dockerizationDir, { recursive: true })
    await writeFile(
      composeFilePath,
      [
        "services:",
        "  app:",
        "    build:",
        "      context: .",
        "    env_file:",
        '      - ".env"',
        "    ports:",
        '      - "3000:3000"',
      ].join("\n"),
      "utf-8",
    )

    const service = new DockerArtifactService(tempRoot)
    const result = await service.generateArtifacts({
      repoPath: "/repo",
      worktreePath: "/repo__wt__test-1",
      worktreeSlug: "test-1",
      repoIdentity: { name: "repo", path: "/repo", pathHash: "abc123", key: "repo" },
      dockerization: {
        dockerizationDir,
        composeFilePath,
        envFilePath: null,
        startupScriptPath: null,
      },
      allocatePublishedPorts: async () => ({ "app:3000": 4100 }),
    })

    const overrideContents = await readFile(result.artifacts.generatedOverridePath, "utf-8")
    const envContents = await readFile(result.artifacts.generatedEnvPath, "utf-8")

    expect(overrideContents).toContain("ports: !override")
    expect(overrideContents).toContain("env_file: !override")
    expect(overrideContents).toContain(result.artifacts.generatedEnvPath)
    expect(overrideContents).toContain("published: 4100")
    expect(envContents).toBe("\n")
  })

  test("writes env-backed webpack port overrides", async () => {
    const dockerizationDir = join(tempRoot, "dockerization")
    const composeFilePath = join(dockerizationDir, "docker-compose.yml")
    const envFilePath = join(dockerizationDir, ".env")

    await mkdir(dockerizationDir, { recursive: true })
    await writeFile(
      composeFilePath,
      [
        "services:",
        "  webpack:",
        "    build:",
        "      context: .",
        "    ports:",
        '      - "' + "$" + '{WEBPACK_PORT:-3035}:3035"',
      ].join("\n"),
      "utf-8",
    )
    await writeFile(
      envFilePath,
      "WEBPACK_PORT=3035\nWEBPACKER_PUBLIC=localhost:3035\nDOCKER_ASSET_HOST=http://localhost:3035\n",
      "utf-8",
    )

    const service = new DockerArtifactService(tempRoot)
    const result = await service.generateArtifacts({
      repoPath: "/repo",
      worktreePath: "/repo__wt__test-1",
      worktreeSlug: "test-1",
      repoIdentity: { name: "repo", path: "/repo", pathHash: "abc123", key: "repo" },
      dockerization: {
        dockerizationDir,
        composeFilePath,
        envFilePath,
        startupScriptPath: null,
      },
      allocatePublishedPorts: async () => ({ WEBPACK_PORT: 4103 }),
    })

    const envContents = await readFile(result.artifacts.generatedEnvPath, "utf-8")

    expect(envContents).toContain("WEBPACK_PORT=4103")
    expect(envContents).toContain("WEBPACKER_PUBLIC=localhost:4103")
    expect(envContents).toContain("DOCKER_ASSET_HOST=http://localhost:4103")
  })

  test("preserves fixed published ports from compose definitions", async () => {
    const dockerizationDir = join(tempRoot, "dockerization")
    const composeFilePath = join(dockerizationDir, "docker-compose.yml")

    await mkdir(dockerizationDir, { recursive: true })
    await writeFile(
      composeFilePath,
      [
        "services:",
        "  webpack-proxy:",
        "    image: node:20",
        "    ports:",
        '      - "4405:3035"',
      ].join("\n"),
      "utf-8",
    )

    const service = new DockerArtifactService(tempRoot)
    let requestedPublishedPort: number | null = null

    const result = await service.generateArtifacts({
      repoPath: "/repo",
      worktreePath: "/repo__wt__test-1",
      worktreeSlug: "test-1",
      repoIdentity: { name: "repo", path: "/repo", pathHash: "abc123", key: "repo" },
      dockerization: {
        dockerizationDir,
        composeFilePath,
        envFilePath: null,
        startupScriptPath: null,
      },
      allocatePublishedPorts: async (portRequests) => {
        requestedPublishedPort = portRequests[0]?.requestedPublishedPort ?? null
        return { "webpack-proxy:3035": 4405 }
      },
    })

    expect(requestedPublishedPort as number | null).toBe(4405)
    expect(result.metadata.publishedPorts).toEqual({ "webpack-proxy:3035": 4405 })
  })
})
