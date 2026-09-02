import type { AppState } from "../core/app.ts";
import {
  type Config,
  type Context,
  defaultConfig,
  type PullRequest,
  type RemoteRepo,
  type Repo,
  type State,
  type Worktree,
} from "../core/types.ts";

export const contexts: Context[] = [
  {
    id: "buk",
    name: "Buk",
    owners: ["bukhr"],
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "personal",
    name: "Personal",
    owners: ["dannyfuf"],
    createdAt: "2026-01-02T00:00:00.000Z",
  },
];

export const repos: Repo[] = [
  {
    id: "bukhr/payroll",
    owner: "bukhr",
    name: "payroll",
    url: "git@github.com:bukhr/payroll.git",
    contextId: "buk",
    defaultBranch: "main",
    path: "/home/test/.swarm/repos/bukhr/payroll",
    clonedAt: "2026-01-03T00:00:00.000Z",
    hooks: { postCreate: [] },
  },
  {
    id: "bukhr/platform",
    owner: "bukhr",
    name: "platform",
    url: "git@github.com:bukhr/platform.git",
    contextId: "buk",
    defaultBranch: "main",
    path: "/home/test/.swarm/repos/bukhr/platform",
    clonedAt: "2026-01-04T00:00:00.000Z",
    hooks: { postCreate: ["npm install"] },
  },
  {
    id: "dannyfuf/dotfiles",
    owner: "dannyfuf",
    name: "dotfiles",
    url: "git@github.com:dannyfuf/dotfiles.git",
    contextId: "personal",
    defaultBranch: "main",
    path: "/home/test/.swarm/repos/dannyfuf/dotfiles",
    clonedAt: "2026-01-05T00:00:00.000Z",
    hooks: { postCreate: [] },
  },
];

export const worktrees: Worktree[] = [
  {
    id: "bukhr/payroll#main",
    repoId: "bukhr/payroll",
    slug: "main",
    branch: "main",
    baseRef: "origin/main",
    path: "/home/test/.swarm/worktrees/bukhr/payroll/main",
    session: "payroll/main",
    createdAt: "2026-02-01T00:00:00.000Z",
    lastOpenedAt: "2026-02-10T00:00:00.000Z",
  },
  {
    id: "bukhr/payroll#feat-payroll-fix",
    repoId: "bukhr/payroll",
    slug: "feat-payroll-fix",
    branch: "feat/payroll-fix",
    baseRef: "origin/main",
    path: "/home/test/.swarm/worktrees/bukhr/payroll/feat-payroll-fix",
    session: "payroll/feat-payroll-fix",
    createdAt: "2026-02-02T00:00:00.000Z",
    lastOpenedAt: "2026-02-09T00:00:00.000Z",
  },
  {
    id: "bukhr/payroll#fix-1234",
    repoId: "bukhr/payroll",
    slug: "fix-1234",
    branch: "fix/1234",
    baseRef: "origin/main",
    path: "/home/test/.swarm/worktrees/bukhr/payroll/fix-1234",
    session: "payroll/fix-1234",
    createdAt: "2026-02-03T00:00:00.000Z",
  },
  {
    id: "bukhr/platform#feat-api",
    repoId: "bukhr/platform",
    slug: "feat-api",
    branch: "feat/api",
    baseRef: "origin/main",
    path: "/home/test/.swarm/worktrees/bukhr/platform/feat-api",
    session: "platform/feat-api",
    createdAt: "2026-02-04T00:00:00.000Z",
    lastOpenedAt: "2026-02-11T00:00:00.000Z",
  },
  {
    id: "dannyfuf/dotfiles#main",
    repoId: "dannyfuf/dotfiles",
    slug: "main",
    branch: "main",
    baseRef: "origin/main",
    path: "/home/test/.swarm/worktrees/dannyfuf/dotfiles/main",
    session: "dotfiles/main",
    createdAt: "2026-02-05T00:00:00.000Z",
    lastOpenedAt: "2026-02-12T00:00:00.000Z",
  },
];

export const config: Config = defaultConfig("/home/test/.swarm");

export const remoteRepos: RemoteRepo[] = [
  {
    owner: "bukhr",
    name: "benefits",
    fullName: "bukhr/benefits",
    description: "Benefits platform",
    sshUrl: "git@github.com:bukhr/benefits.git",
    isPrivate: true,
    updatedAt: "2026-02-12T00:00:00.000Z",
    defaultBranch: "main",
  },
  {
    owner: "dannyfuf",
    name: "notes",
    fullName: "dannyfuf/notes",
    description: "Personal notes",
    sshUrl: "git@github.com:dannyfuf/notes.git",
    isPrivate: false,
    updatedAt: "2026-02-11T00:00:00.000Z",
    defaultBranch: "main",
  },
];

export function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  const pr: PullRequest = {
    repoId: "bukhr/payroll",
    number: 42,
    title: "Improve payroll exports",
    url: "https://github.com/bukhr/payroll/pull/42",
    author: "octocat",
    headRefName: "feat/payroll-exports",
    baseRefName: "main",
    isDraft: false,
    isCrossRepository: false,
    reviewDecision: "review_required",
    checks: "pass",
    additions: 120,
    deletions: 24,
    labels: ["feature"],
    updatedAt: "2026-02-12T00:00:00.000Z",
    ...overrides,
  };
  return {
    ...pr,
    url: overrides.url ?? `https://github.com/${pr.repoId}/pull/${pr.number}`,
  };
}

export function makeState(overrides: Partial<State> = {}): State {
  return structuredClone({
    version: 1,
    contexts,
    repos,
    clones: [],
    worktrees,
    activeContextId: "buk",
    ...overrides,
  });
}

export function makeAppState(overrides: Partial<AppState> = {}): Partial<AppState> {
  const state = makeState();
  return structuredClone({
    contexts: state.contexts,
    repos: state.repos,
    clones: state.clones,
    worktrees: state.worktrees,
    activeContextId: state.activeContextId,
    config,
    loading: false,
    ...overrides,
  });
}
