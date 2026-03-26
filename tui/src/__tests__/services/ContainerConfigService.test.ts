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
  test("loads and validates repo config", async () => {
    const repoPath = "/tmp/repos/my-app"
    const repoIdentityService = new RepoIdentityService()
    const service = new ContainerConfigService(repoIdentityService, tempRoot)
    const configPath = service.getExpectedConfigPath(repoPath)

    await mkdir(join(tempRoot, "swarm", "containers"), { recursive: true })
    await writeFile(
      configPath,
      [
        "schema_version: 1",
        `repo_path: ${repoPath}`,
        "preset: rails",
        "env:",
        "  file: .env.development",
        "processes:",
        "  app:",
        "    command: bin/rails server -b 0.0.0.0 -p 3000",
        "    expose: true",
        "    internal_port: 3000",
        "  worker:",
        "    command: bundle exec sidekiq",
      ].join("\n"),
      "utf-8",
    )

    const resolved = await service.loadForRepo(repoPath)

    expect(resolved.identity.key).toContain("my-app")
    expect(resolved.config.env.file).toBe(".env.development")
    expect(resolved.config.processes).toHaveLength(2)
    expect(resolved.config.processes.find((process) => process.expose)?.name).toBe("app")
  })

  test("rejects absolute env file paths", async () => {
    const repoPath = "/tmp/repos/my-app"
    const repoIdentityService = new RepoIdentityService()
    const service = new ContainerConfigService(repoIdentityService, tempRoot)
    const configPath = service.getExpectedConfigPath(repoPath)

    await mkdir(join(tempRoot, "swarm", "containers"), { recursive: true })
    await writeFile(
      configPath,
      [
        "schema_version: 1",
        `repo_path: ${repoPath}`,
        "preset: generic",
        "env:",
        "  file: /etc/passwd",
        "processes:",
        "  app:",
        "    command: ./bin/start",
        "    expose: true",
        "    internal_port: 3000",
      ].join("\n"),
      "utf-8",
    )

    await expect(service.loadForRepo(repoPath)).rejects.toThrow("repo-relative")
  })

  test("creates scaffold when config is missing", async () => {
    const repoPath = "/tmp/repos/my-app"
    const repoIdentityService = new RepoIdentityService()
    const service = new ContainerConfigService(repoIdentityService, tempRoot)

    const scaffold = await service.ensureConfigScaffold(repoPath)

    expect(scaffold.alreadyExisted).toBe(false)
    expect(scaffold.path).toContain("my-app")
    expect(scaffold.contents).toContain("schema_version: 1")
    expect(scaffold.contents).toContain(`repo_path: ${repoPath}`)
    expect(scaffold.contents).toContain("preset: generic")
  })

  test("returns missing summary when config does not exist", async () => {
    const repoPath = "/tmp/repos/my-app"
    const repoIdentityService = new RepoIdentityService()
    const service = new ContainerConfigService(repoIdentityService, tempRoot)

    const summary = await service.getSummaryForRepo(repoPath)

    expect(summary).toEqual({
      state: "missing",
      path: service.getExpectedConfigPath(repoPath),
      resolvedPath: null,
      exists: false,
      isValid: false,
      preset: null,
      error: null,
    })
  })

  test("returns valid summary with preset when config is valid", async () => {
    const repoPath = "/tmp/repos/my-app"
    const repoIdentityService = new RepoIdentityService()
    const service = new ContainerConfigService(repoIdentityService, tempRoot)
    const configPath = service.getExpectedConfigPath(repoPath)

    await mkdir(join(tempRoot, "swarm", "containers"), { recursive: true })
    await writeFile(
      configPath,
      [
        "schema_version: 1",
        `repo_path: ${repoPath}`,
        "preset: node-web",
        "processes:",
        "  app:",
        "    command: bun run dev",
        "    expose: true",
        "    internal_port: 3000",
      ].join("\n"),
      "utf-8",
    )

    const summary = await service.getSummaryForRepo(repoPath)

    expect(summary).toEqual({
      state: "present",
      path: configPath,
      resolvedPath: configPath,
      exists: true,
      isValid: true,
      preset: "node-web",
      error: null,
    })
  })

  test("returns invalid summary when config fails validation", async () => {
    const repoPath = "/tmp/repos/my-app"
    const repoIdentityService = new RepoIdentityService()
    const service = new ContainerConfigService(repoIdentityService, tempRoot)
    const configPath = service.getExpectedConfigPath(repoPath)

    await mkdir(join(tempRoot, "swarm", "containers"), { recursive: true })
    await writeFile(
      configPath,
      [
        "schema_version: 1",
        `repo_path: ${repoPath}`,
        "preset: generic",
        "processes:",
        "  app:",
        "    command: ./bin/start",
        "    expose: true",
      ].join("\n"),
      "utf-8",
    )

    const summary = await service.getSummaryForRepo(repoPath)

    expect(summary.state).toBe("invalid")
    expect(summary.path).toBe(configPath)
    expect(summary.resolvedPath).toBe(configPath)
    expect(summary.exists).toBe(true)
    expect(summary.isValid).toBe(false)
    expect(summary.preset).toBe(null)
    expect(summary.error).toContain("positive internal_port")
  })
})
