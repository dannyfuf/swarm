import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SwarmError } from "../core/errors.ts";
import { PROTOCOL_VERSION } from "../core/protocol.ts";
import type { Config, Worktree, WorktreeStatus } from "../core/types.ts";
import { createFakeRemoteHost } from "../testing/fakeRemoteHost.ts";
import { config, makeState, repos, worktrees } from "../testing/fixtures.ts";
import { createMemoryConfig } from "../testing/memoryConfig.ts";
import { createMemoryState } from "../testing/memoryState.ts";
import { createNullLogger } from "../testing/nullLogger.ts";
import { createRemoteHostService } from "./remoteHosts.ts";

const remoteConfig: Config = {
  ...config,
  hosts: {
    devbox: { ssh: "devbox", swarmCommand: "swarm" },
    lab: { ssh: "user@lab", swarmCommand: "/opt/swarm" },
  },
};

function response(value: unknown, code = 0) {
  return { code, stdout: `${JSON.stringify(value)}\n`, stderr: "" };
}

function remoteWorktree(overrides: Partial<Worktree> = {}): Worktree {
  const source = worktrees[0];
  assert.ok(source);
  return {
    ...source,
    path: "/srv/swarm/worktrees/bukhr/payroll/main",
    session: "payroll/main",
    ...overrides,
  };
}

function createHarness(initial = makeState()) {
  const transport = createFakeRemoteHost();
  const state = createMemoryState(initial);
  const logger = createNullLogger();
  const service = createRemoteHostService({
    transport,
    state,
    config: createMemoryConfig(remoteConfig),
    logger,
  });
  return { service, transport, state, logger };
}

describe("RemoteHostService protocol", () => {
  test("parses envelopes and sends complete create metadata", async () => {
    const { service, transport } = createHarness();
    const created = remoteWorktree({ id: "bukhr/payroll#remote", slug: "remote" });
    transport.script(
      "devbox",
      "list",
      response({
        protocol: PROTOCOL_VERSION,
        version: "swarm 0.1.0+abc",
        repos,
        worktrees: [created],
      }),
    );
    transport.script(
      "devbox",
      "create",
      response({ protocol: PROTOCOL_VERSION, created: true, worktree: created }),
    );
    const repo = repos[0];
    assert.ok(repo);

    assert.equal((await service.list("devbox")).version, "swarm 0.1.0+abc");
    assert.deepEqual(
      await service.create("devbox", {
        repo,
        slug: "remote",
        branch: "feat/remote",
        baseRef: "origin/main",
      }),
      { created: true, worktree: created },
    );
    assert.deepEqual(transport.calls[1]?.args, [
      "create",
      "bukhr/payroll",
      "remote",
      "--branch",
      "feat/remote",
      "--base",
      "origin/main",
      "--url",
      "git@github.com:bukhr/payroll.git",
      "--default-branch",
      "main",
      "--hooks",
      '{"prepare":[],"postCreate":[]}',
      "--json",
    ]);
    assert.equal(transport.calls[0]?.timeoutMs, 30_000);
    assert.equal(transport.calls[1]?.timeoutMs, undefined);
  });

  test("rejects a globally duplicate id before invoking ssh", async () => {
    const existing = remoteWorktree({ host: "lab" });
    const { service, transport } = createHarness(makeState({ worktrees: [existing] }));
    const repo = repos[0];
    assert.ok(repo);

    await assert.rejects(
      service.create("devbox", {
        repo,
        slug: existing.slug,
        branch: existing.branch,
        baseRef: existing.baseRef,
      }),
      (error: unknown) => {
        assert.ok(error instanceof SwarmError);
        assert.equal(error.code, "conflict");
        assert.equal(
          error.message,
          `Worktree already exists with different placement: ${existing.id}`,
        );
        return true;
      },
    );
    assert.deepEqual(transport.calls, []);
  });

  test("returns a matching mirror idempotently without invoking ssh", async () => {
    const existing = remoteWorktree({ host: "devbox" });
    const { service, transport } = createHarness(makeState({ worktrees: [existing] }));
    const repo = repos[0];
    assert.ok(repo);

    assert.deepEqual(
      await service.create("devbox", {
        repo,
        slug: existing.slug,
        baseRef: existing.baseRef,
      }),
      { created: false, worktree: existing },
    );
    assert.deepEqual(transport.calls, []);
  });

  test("omits a defaulted branch from the recursive remote create invocation", async () => {
    const { service, transport } = createHarness(makeState({ worktrees: [] }));
    const created = remoteWorktree({ id: "bukhr/payroll#ticket-42", slug: "ticket-42" });
    transport.script(
      "devbox",
      "create",
      response({ protocol: PROTOCOL_VERSION, created: true, worktree: created }),
    );
    const repo = repos[0];
    assert.ok(repo);

    await service.create("devbox", { repo, slug: "ticket-42", baseRef: "origin/main" });

    assert.equal(transport.calls[0]?.args.includes("--branch"), false);
  });

  test("maps unreachable, protocol mismatch, and remote error envelopes", async () => {
    const { service, transport } = createHarness();
    transport.script("devbox", "list", { code: 255, stdout: "", stderr: "connection refused" });
    await assert.rejects(service.list("devbox"), (error: unknown) => {
      assert.ok(error instanceof SwarmError);
      assert.equal(error.code, "remote");
      assert.equal(error.message, "devbox unreachable: connection refused");
      return true;
    });

    transport.script(
      "devbox",
      "list",
      response({ protocol: 7, version: "swarm future", repos: [], worktrees: [] }),
    );
    await assert.rejects(service.list("devbox"), /local 1, remote 7/);

    transport.script(
      "devbox",
      "kill",
      response({ protocol: 1, error: { kind: "conflict", message: "still busy" } }, 1),
    );
    await assert.rejects(service.kill("devbox", "bukhr/payroll#main"), (error: unknown) => {
      assert.ok(error instanceof SwarmError);
      assert.equal(error.code, "conflict");
      assert.equal(error.message, "devbox: still busy");
      return true;
    });

    transport.script(
      "devbox",
      "delete",
      response(
        {
          protocol: 1,
          ok: false,
          results: [{ worktreeId: "bukhr/payroll#main", ok: false, reason: "worktree is dirty" }],
        },
        1,
      ),
    );
    assert.deepEqual(await service.delete("devbox", "bukhr/payroll#main"), {
      ok: false,
      reason: "worktree is dirty",
    });
  });

  test("routes delete, kill, sleep, inspect, and status subcommands", async () => {
    const { service, transport } = createHarness();
    const ok = response({ protocol: 1, ok: true });
    transport.script(
      "devbox",
      "delete",
      response({
        protocol: 1,
        ok: true,
        results: [{ worktreeId: "bukhr/payroll#main", ok: true }],
      }),
    );
    transport.script("devbox", "kill", ok);
    transport.script(
      "devbox",
      "sleep",
      response({
        protocol: 1,
        kept: [{ window: "cc", reason: "claude" }],
        closed: ["nvim"],
        sessionKilled: false,
      }),
    );
    const status: WorktreeStatus = {
      worktreeId: "bukhr/payroll#main",
      session: "detached",
      windows: [],
      running: ["claude"],
    };
    transport.script("devbox", "status", response({ protocol: 1, statuses: [status] }));
    const inspected = {
      worktreeId: "bukhr/payroll#main",
      repoId: "bukhr/payroll",
      host: "local",
      path: "/srv/swarm/worktrees/bukhr/payroll/main",
      branch: "main",
      baseRef: "origin/main",
      head: "1".repeat(40),
      targetBranch: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      upstreamGone: false,
      dirty: false,
      mergedIntoTarget: true,
      uniqueCommits: 0,
      published: true,
      merged: true,
      pr: null,
      session: "none" as const,
      running: [],
      inspectedAt: "2026-09-04T00:00:00.000Z",
      warnings: [],
      error: null,
    };
    transport.script("devbox", "inspect", response({ protocol: 1, worktrees: [inspected] }));

    assert.deepEqual(await service.delete("devbox", "bukhr/payroll#main", { force: true }), {
      ok: true,
    });
    await service.kill("devbox", "bukhr/payroll#main");
    assert.deepEqual(await service.sleep("devbox", "payroll/main"), {
      kept: [{ window: "cc", reason: "claude" }],
      closed: ["nvim"],
      sessionKilled: false,
    });
    assert.deepEqual(await service.status("devbox"), [status]);
    assert.deepEqual(await service.inspect("devbox", ["bukhr/payroll#main"], { fetch: true }), [
      inspected,
    ]);
    assert.deepEqual(
      transport.calls.map(({ args, timeoutMs }) => ({ args, timeoutMs })),
      [
        {
          args: ["delete", "bukhr/payroll#main", "--force", "--json"],
          timeoutMs: 30_000,
        },
        { args: ["kill", "bukhr/payroll#main", "--json"], timeoutMs: 30_000 },
        { args: ["sleep", "payroll/main", "--json"], timeoutMs: 30_000 },
        { args: ["status", "--json"], timeoutMs: 30_000 },
        {
          args: ["inspect", "bukhr/payroll#main", "--fetch", "--json"],
          timeoutMs: 30_000,
        },
      ],
    );
  });
});

describe("RemoteHostService sync", () => {
  test("adds and updates mirrors, preserves lastOpenedAt, removes vanished, and skips unknown repos", async () => {
    const existing = remoteWorktree({
      host: "devbox",
      lastOpenedAt: "2025-12-01T00:00:00.000Z",
      path: "/old/path",
    });
    const vanished = remoteWorktree({
      id: "bukhr/payroll#vanished",
      slug: "vanished",
      host: "devbox",
    });
    const otherHost = remoteWorktree({ id: "bukhr/payroll#lab", slug: "lab", host: "lab" });
    const local = worktrees[1];
    assert.ok(local);
    const { service, transport, state, logger } = createHarness(
      makeState({ worktrees: [local, existing, vanished, otherHost] }),
    );
    const added = remoteWorktree({ id: "bukhr/payroll#added", slug: "added" });
    const unknown = remoteWorktree({
      id: "other/missing#main",
      repoId: "other/missing",
      slug: "main",
    });
    transport.script(
      "devbox",
      "list",
      response({
        protocol: 1,
        version: "swarm 0.1.0",
        repos: [],
        worktrees: [remoteWorktree(), added, unknown],
      }),
    );

    const synced = await service.sync("devbox");

    assert.deepEqual(
      synced.map(({ id }) => id),
      [existing.id, added.id],
    );
    assert.equal(synced[0]?.path, "/srv/swarm/worktrees/bukhr/payroll/main");
    assert.equal(synced[0]?.lastOpenedAt, "2025-12-01T00:00:00.000Z");
    assert.ok(synced.every(({ host }) => host === "devbox"));
    assert.ok(state.state.worktrees.some(({ id }) => id === local.id));
    assert.ok(state.state.worktrees.some(({ id }) => id === otherHost.id));
    assert.ok(!state.state.worktrees.some(({ id }) => id === vanished.id));
    assert.match(logger.entries[0]?.message ?? "", /unregistered repo/);
  });

  test("syncAll isolates hosts", async () => {
    const { service, transport } = createHarness();
    transport.script(
      "devbox",
      "list",
      response({ protocol: 1, version: "swarm ok", repos: [], worktrees: [] }),
    );
    transport.script("lab", "list", { code: 255, stdout: "", stderr: "offline" });

    const result = await service.syncAll();

    assert.deepEqual(
      result.map(({ hostId }) => hostId),
      ["devbox", "lab"],
    );
    assert.equal(result[0]?.error, undefined);
    assert.equal(result[1]?.error?.code, "remote");
  });

  test("skips ids owned by other hosts without overwriting or removing those records", async () => {
    const local = remoteWorktree();
    const lab = remoteWorktree({
      id: "bukhr/payroll#lab",
      slug: "lab",
      host: "lab",
      path: "/lab/original",
    });
    const vanished = remoteWorktree({
      id: "bukhr/payroll#vanished",
      slug: "vanished",
      host: "devbox",
    });
    const { service, transport, state, logger } = createHarness(
      makeState({ worktrees: [local, lab, vanished] }),
    );
    transport.script(
      "devbox",
      "list",
      response({
        protocol: 1,
        version: "swarm 0.1.0",
        repos: [],
        worktrees: [
          remoteWorktree({ path: "/devbox/replacement" }),
          remoteWorktree({ id: lab.id, slug: lab.slug, path: "/devbox/lab-replacement" }),
        ],
      }),
    );

    assert.deepEqual(await service.sync("devbox"), []);
    assert.deepEqual(state.state.worktrees, [local, lab]);
    const warnings = logger.entries.filter(({ level }) => level === "warn");
    assert.ok(
      warnings.some(({ message }) => message.includes("devbox") && message.includes("host local")),
    );
    assert.ok(
      warnings.some(({ message }) => message.includes("devbox") && message.includes("host lab")),
    );
  });

  test("remoteSnapshot filters status and falls back to unknown", async () => {
    const mirror = remoteWorktree({ host: "devbox" });
    const { service, transport } = createHarness(makeState({ worktrees: [mirror] }));
    const status: WorktreeStatus = {
      worktreeId: mirror.id,
      session: "attached",
      windows: [],
      running: ["claude"],
    };
    transport.script(
      "devbox",
      "status",
      response({
        protocol: 1,
        statuses: [status, { ...status, worktreeId: "bukhr/payroll#other" }],
      }),
      { code: 255, stdout: "", stderr: "offline" },
    );

    assert.deepEqual([...(await service.remoteSnapshot("devbox")).values()], [status]);
    assert.deepEqual(
      [...(await service.remoteSnapshot("devbox")).values()],
      [{ worktreeId: mirror.id, session: "unknown", windows: [], running: [] }],
    );
    assert.equal(service.lastError("devbox")?.message, "devbox unreachable: offline");
  });
});
