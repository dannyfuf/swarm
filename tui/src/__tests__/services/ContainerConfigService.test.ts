import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { ContainerConfigService } from "../../services/ContainerConfigService.js"
import { RepoIdentityService } from "../../services/RepoIdentityService.js"

const tempRoot = join(process.cwd(), "tmp-container-config-tests")

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

describe("ContainerConfigService", () => {
  test("loads repo dockerization from repo-name directory", async () => {
    const repoPath = "/tmp/repos/my-app"
    const service = new ContainerConfigService(new RepoIdentityService(), tempRoot)
    const dockerizationDir = service.getExpectedConfigPath(repoPath)
    const composeFilePath = join(dockerizationDir, "docker-compose.yml")

    await mkdir(dockerizationDir, { recursive: true })
    await writeFile(
      composeFilePath,
      [
        "services:",
        "  app:",
        "    image: node:22",
        "    ports:",
        '      - "' + "$" + "{APP_PORT:-3000}" + ':3000"',
      ].join("\n"),
      "utf-8",
    )

    const resolved = await service.loadForRepo(repoPath)

    expect(resolved.identity.key).toBe("my-app")
    expect(resolved.config.dockerizationDir).toBe(dockerizationDir)
    expect(resolved.config.composeFilePath).toBe(composeFilePath)
    expect(resolved.config.startupScriptPath).toBeNull()
  })

  test("loads repo dockerization start script when present", async () => {
    const repoPath = "/tmp/repos/my-app"
    const service = new ContainerConfigService(new RepoIdentityService(), tempRoot)
    const dockerizationDir = service.getExpectedConfigPath(repoPath)
    const composeFilePath = join(dockerizationDir, "docker-compose.yml")
    const startupScriptPath = join(dockerizationDir, "start.sh")

    await mkdir(dockerizationDir, { recursive: true })
    await writeFile(composeFilePath, ["services:", "  app:", "    image: node:22"].join("\n"), "utf-8")
    await writeFile(startupScriptPath, "#!/usr/bin/env bash\nexit 0\n", "utf-8")

    const resolved = await service.loadForRepo(repoPath)

    expect(resolved.config.startupScriptPath).toBe(startupScriptPath)
  })

  test("creates dockerization scaffold when missing", async () => {
    const repoPath = "/tmp/repos/my-app"
    const service = new ContainerConfigService(new RepoIdentityService(), tempRoot)

    const scaffold = await service.ensureConfigScaffold(repoPath)

    expect(scaffold.alreadyExisted).toBe(false)
    expect(scaffold.path).toContain("my-app")
    expect(scaffold.composeFilePath).toContain("docker-compose.yml")
    expect(scaffold.contents).toContain("services:")
  })

  test("returns missing summary when dockerization directory does not exist", async () => {
    const repoPath = "/tmp/repos/my-app"
    const service = new ContainerConfigService(new RepoIdentityService(), tempRoot)

    const summary = await service.getSummaryForRepo(repoPath)

    expect(summary).toMatchObject({
      state: "missing",
      path: service.getExpectedConfigPath(repoPath),
      resolvedPath: null,
      exists: false,
      isValid: false,
      preset: null,
      error: null,
    })
  })

  test("returns invalid summary when compose file is missing", async () => {
    const repoPath = "/tmp/repos/my-app"
    const service = new ContainerConfigService(new RepoIdentityService(), tempRoot)
    const dockerizationDir = service.getExpectedConfigPath(repoPath)

    await mkdir(dockerizationDir, { recursive: true })

    const summary = await service.getSummaryForRepo(repoPath)

    expect(summary.state).toBe("invalid")
    expect(summary.error).toContain("Missing compose file")
  })

  test("returns present summary when compose file is valid", async () => {
    const repoPath = "/tmp/repos/my-app"
    const service = new ContainerConfigService(new RepoIdentityService(), tempRoot)
    const dockerizationDir = service.getExpectedConfigPath(repoPath)
    const composeFilePath = join(dockerizationDir, "docker-compose.yml")

    await mkdir(dockerizationDir, { recursive: true })
    await writeFile(
      composeFilePath,
      ["services:", "  app:", "    image: node:22"].join("\n"),
      "utf-8",
    )

    const summary = await service.getSummaryForRepo(repoPath)

    expect(summary).toMatchObject({
      state: "present",
      path: dockerizationDir,
      resolvedPath: composeFilePath,
      exists: true,
      isValid: true,
      preset: null,
      error: null,
    })
  })
})
