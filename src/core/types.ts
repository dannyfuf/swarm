import { join } from "node:path";
import { z } from "zod";

export const ContextId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
export type ContextId = z.infer<typeof ContextId>;

export const RepoId = z.string().regex(/^[^/\s]+\/[^/\s]+$/);
export type RepoId = z.infer<typeof RepoId>;

export const WorktreeId = z.string().regex(/^[^/\s]+\/[^/\s]+#[^\s#]+$/);
export type WorktreeId = z.infer<typeof WorktreeId>;

export const ContextSchema = z.object({
  id: ContextId,
  name: z.string().min(1),
  owners: z.array(z.string()),
  createdAt: z.string().datetime(),
});
export type Context = z.infer<typeof ContextSchema>;

export const RepoSchema = z.object({
  id: RepoId,
  owner: z.string(),
  name: z.string(),
  url: z.string(),
  contextId: ContextId,
  defaultBranch: z.string(),
  path: z.string(),
  clonedAt: z.string().datetime(),
  hooks: z
    .object({
      prepare: z.array(z.string()).default([]),
      postCreate: z.array(z.string()).default([]),
    })
    .default({ prepare: [], postCreate: [] }),
});
export type Repo = z.infer<typeof RepoSchema>;

export const CloneJobSchema = z.object({
  id: RepoId,
  owner: z.string(),
  name: z.string(),
  url: z.string(),
  contextId: ContextId,
  defaultBranch: z.string(),
  path: z.string(),
  stagingPath: z.string(),
  logPath: z.string(),
  pid: z.number().int().positive().optional(),
  startedAt: z.string().datetime(),
  status: z.enum(["starting", "cloning", "failed"]),
  error: z.string().optional(),
});
export type CloneJob = z.infer<typeof CloneJobSchema>;

export const WorktreeSchema = z.object({
  id: WorktreeId,
  repoId: RepoId,
  slug: z.string(),
  branch: z.string(),
  baseRef: z.string(),
  path: z.string(),
  session: z.string(),
  createdAt: z.string().datetime(),
  lastOpenedAt: z.string().datetime().optional(),
});
export type Worktree = z.infer<typeof WorktreeSchema>;

export const PrTabSchema = z.enum(["mine", "review"]);
export type PrTab = z.infer<typeof PrTabSchema>;

export const PrChecksSchema = z.enum(["pass", "fail", "pending", "none"]);
export type PrChecks = z.infer<typeof PrChecksSchema>;

export const PrReviewDecisionSchema = z.enum([
  "approved",
  "changes_requested",
  "review_required",
  "none",
]);
export type PrReviewDecision = z.infer<typeof PrReviewDecisionSchema>;

export const PrStateSchema = z.enum([
  "draft",
  "ci_fail",
  "changes",
  "ci_pending",
  "approved",
  "review",
]);
export type PrState = z.infer<typeof PrStateSchema>;

export const PullRequestSchema = z
  .object({
    repoId: RepoId,
    number: z.number().int().positive(),
    title: z.string(),
    url: z.string().url(),
    author: z.string().min(1),
    headRefName: z.string().min(1),
    baseRefName: z.string().min(1),
    isDraft: z.boolean(),
    isCrossRepository: z.boolean(),
    headRepo: RepoId.optional(),
    reviewDecision: PrReviewDecisionSchema,
    checks: PrChecksSchema,
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    labels: z.array(z.string()),
    updatedAt: z.string().datetime(),
  })
  .superRefine((pr, context) => {
    let url: URL;
    try {
      url = new URL(pr.url);
    } catch {
      return;
    }
    const match = /^\/[^/]+\/[^/]+\/pull\/([1-9]\d*)$/u.exec(url.pathname);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      match?.[1] !== String(pr.number)
    ) {
      context.addIssue({
        code: "custom",
        path: ["url"],
        message: `Expected https://github.com/<owner>/<name>/pull/${pr.number}`,
      });
    }
  });
export type PullRequest = z.infer<typeof PullRequestSchema>;

export const PrRepoSliceSchema = z.object({
  prs: z.array(PullRequestSchema),
  fetchedAt: z.string().datetime().optional(),
  error: z.string().optional(),
  loading: z.boolean(),
});
export type PrRepoSlice = z.infer<typeof PrRepoSliceSchema>;

export const StateSchema = z.object({
  version: z.literal(1),
  contexts: z.array(ContextSchema),
  repos: z.array(RepoSchema),
  clones: z.array(CloneJobSchema).default([]),
  worktrees: z.array(WorktreeSchema),
  activeContextId: ContextId.optional(),
});
export type State = z.infer<typeof StateSchema>;

export const AGENT_NAMES = ["claude", "opencode"] as const;
export const AgentNameSchema = z.enum(AGENT_NAMES);
export type AgentName = z.infer<typeof AgentNameSchema>;

export function isAgentName(value: string | undefined): value is AgentName {
  return AgentNameSchema.safeParse(value).success;
}

export const WindowSpecSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
});
export type WindowSpec = z.infer<typeof WindowSpecSchema>;

export const KeepAliveRuleSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["process", "listening-port"]),
  pattern: z.string().default(""),
  enabled: z.boolean().default(true),
});
export type KeepAliveRule = z.infer<typeof KeepAliveRuleSchema>;

export const SleepPolicySchema = z.object({
  enabled: z.boolean().default(true),
  keepAlive: z.array(KeepAliveRuleSchema),
  graceMs: z.number().int().default(2000),
});
export type SleepPolicy = z.infer<typeof SleepPolicySchema>;

export const ConfigSchema = z.object({
  version: z.literal(1),
  reposDir: z.string(),
  worktreesDir: z.string(),
  hotPoolSize: z.number().int().nonnegative().default(1),
  hotFreshnessMs: z.number().int().nonnegative().default(60000),
  hotRefreshIntervalMs: z.number().int().nonnegative().default(300000),
  agent: AgentNameSchema.default("claude"),
  windows: z.array(WindowSpecSchema),
  sleep: SleepPolicySchema,
  github: z
    .object({
      cacheTtlSeconds: z.number().int().default(3600),
      prTtlSeconds: z.number().int().default(90),
      cloneProtocol: z.enum(["ssh", "https"]).default("ssh"),
    })
    .default({ cacheTtlSeconds: 3600, prTtlSeconds: 90, cloneProtocol: "ssh" }),
  ui: z
    .object({
      statusRefreshMs: z.number().int().default(2000),
    })
    .default({ statusRefreshMs: 2000 }),
});
export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_WINDOWS: WindowSpec[] = [
  { name: "nvim", command: "nvim ." },
  { name: "cc", command: "{agent}" },
  { name: "lg", command: "lazygit" },
];

export function resolveWindowCommand(spec: WindowSpec, agent: AgentName): WindowSpec {
  return { ...spec, command: spec.command.replaceAll("{agent}", agent) };
}

export function resolveWindows(config: Pick<Config, "agent" | "windows">): WindowSpec[] {
  return config.windows.map((spec) => resolveWindowCommand(spec, config.agent));
}

export const DEFAULT_KEEP_ALIVE: KeepAliveRule[] = [
  {
    id: "claude",
    label: "claude",
    kind: "process",
    pattern: "(^|/)claude( |$)",
    enabled: true,
  },
  {
    id: "opencode",
    label: "opencode",
    kind: "process",
    pattern: "(^|/)opencode( |$)",
    enabled: true,
  },
  {
    id: "codex",
    label: "codex",
    kind: "process",
    pattern: "(^|/)codex( |$)",
    enabled: true,
  },
  {
    id: "servers",
    label: "server",
    kind: "listening-port",
    pattern: "",
    enabled: true,
  },
];

export function defaultConfig(home: string): Config {
  return {
    version: 1,
    reposDir: join(home, "repos"),
    worktreesDir: join(home, "worktrees"),
    hotPoolSize: 1,
    hotFreshnessMs: 60000,
    hotRefreshIntervalMs: 300000,
    agent: "claude",
    windows: DEFAULT_WINDOWS.map((window) => ({ ...window })),
    sleep: {
      enabled: true,
      keepAlive: DEFAULT_KEEP_ALIVE.map((rule) => ({ ...rule })),
      graceMs: 2000,
    },
    github: { cacheTtlSeconds: 3600, prTtlSeconds: 90, cloneProtocol: "ssh" },
    ui: { statusRefreshMs: 2000 },
  };
}

export function defaultState(): State {
  return {
    version: 1,
    contexts: [],
    repos: [],
    clones: [],
    worktrees: [],
  };
}

export type SessionState = "none" | "detached" | "attached";

export interface WorktreeStatus {
  worktreeId: WorktreeId;
  session: SessionState;
  windows: Array<{
    index: number;
    name: string;
    command: string;
    keepAlive: string[];
  }>;
  running: string[];
}

export interface RemoteRepo {
  owner: string;
  name: string;
  fullName: string;
  description: string;
  sshUrl: string;
  isPrivate: boolean;
  updatedAt: string;
  defaultBranch: string;
}
