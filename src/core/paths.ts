import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config, RepoId, WorktreeId } from "./types.ts";

export function swarmHome(env: { SWARM_HOME?: string; HOME?: string }): string {
  return env.SWARM_HOME ?? join(env.HOME ?? "", ".swarm");
}

export function installRoot(env: { SWARM_INSTALL_ROOT?: string }, moduleUrl: string): string {
  return env.SWARM_INSTALL_ROOT ?? resolve(dirname(fileURLToPath(moduleUrl)), "..");
}

export function slugify(branch: string): string {
  return branch
    .toLowerCase()
    .replace(/\//g, "-")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function isWorktreeSlug(slug: string): boolean {
  return (
    slug.length > 0 &&
    slug !== "." &&
    slug !== ".." &&
    slugify(slug) === slug &&
    /^[a-z0-9]/u.test(slug)
  );
}

export function sessionName(repoName: string, slug: string): string {
  return `${repoName.replace(/[.:]/g, "-")}/${slug.replace(/[.:]/g, "-")}`;
}

export function repoId(owner: string, name: string): RepoId {
  return `${owner}/${name}`;
}

export function worktreeId(id: RepoId, slug: string): WorktreeId {
  return `${id}#${slug}`;
}

export function parseWorktreeId(id: WorktreeId): { repoId: RepoId; slug: string } {
  const separator = id.indexOf("#");
  return {
    repoId: id.slice(0, separator),
    slug: id.slice(separator + 1),
  };
}

export function repoPath(config: Config, owner: string, name: string): string {
  return join(config.reposDir, owner, name);
}

export function worktreePath(config: Config, owner: string, name: string, slug: string): string {
  return join(config.worktreesDir, owner, name, slug);
}

export function hotCopyPath(worktreesDir: string, id: RepoId, slot = 0): string {
  return join(worktreesDir, id, slot === 0 ? ".hot" : `.hot.${slot}`);
}

export function hotCopyStagingPath(worktreesDir: string, id: RepoId, slot = 0): string {
  return join(worktreesDir, id, slot === 0 ? ".hot.staging" : `.hot.${slot}.staging`);
}

export function hotCopyPidPath(worktreesDir: string, id: RepoId, slot = 0): string {
  return `${hotCopyStagingPath(worktreesDir, id, slot)}.pid`;
}
