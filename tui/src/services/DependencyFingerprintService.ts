/**
 * Computes dependency fingerprints for repo container image variants.
 */

import { createHash } from "node:crypto"
import { join } from "node:path"
import type { ContainerPreset } from "../types/container.js"

const PRESET_MANIFESTS: Record<ContainerPreset, string[]> = {
  rails: [
    "Gemfile",
    "Gemfile.lock",
    ".ruby-version",
    "package.json",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lock",
    "bun.lockb",
  ],
  "node-web": [
    "package.json",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lock",
    "bun.lockb",
  ],
  "python-web": [
    "requirements.txt",
    "requirements-dev.txt",
    "pyproject.toml",
    "poetry.lock",
    "uv.lock",
    "Pipfile",
    "Pipfile.lock",
  ],
  generic: [
    "package.json",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lock",
    "bun.lockb",
    "Gemfile",
    "Gemfile.lock",
    "requirements.txt",
    "pyproject.toml",
    "poetry.lock",
  ],
}

export interface DependencyFingerprint {
  fingerprint: string
  manifestPaths: string[]
}

export class DependencyFingerprintService {
  async compute(repoPath: string, preset: ContainerPreset): Promise<DependencyFingerprint> {
    const manifestPaths = await this.collectManifestPaths(repoPath, preset)
    const hash = createHash("sha256")

    hash.update(`preset:${preset}\n`)

    if (manifestPaths.length === 0) {
      hash.update("no-manifests\n")
    }

    for (const manifestPath of manifestPaths) {
      const absolutePath = join(repoPath, manifestPath)
      const content = await Bun.file(absolutePath).text()
      hash.update(`file:${manifestPath}\n`)
      hash.update(content)
      hash.update("\n")
    }

    return {
      fingerprint: hash.digest("hex").slice(0, 16),
      manifestPaths,
    }
  }

  async collectManifestPaths(repoPath: string, preset: ContainerPreset): Promise<string[]> {
    const manifests = PRESET_MANIFESTS[preset]
    const existingPaths: string[] = []

    for (const relativePath of manifests) {
      const file = Bun.file(join(repoPath, relativePath))
      if (await file.exists()) {
        existingPaths.push(relativePath)
      }
    }

    return existingPaths
  }
}
