import type { ProcessPort, ProcInfo } from "../core/ports.ts";

export type FakeProcess = ProcessPort & {
  snapshotCalls: number;
  listeningPortCalls: number;
  alive: Set<number>;
  openedUrls: string[];
};

export function createFakeProcess(
  processSnapshot: ProcInfo[] = [],
  portMap: Map<number, number[]> = new Map(),
): FakeProcess {
  const alive = new Set(processSnapshot.map(({ pid }) => pid));
  const fake: FakeProcess = {
    snapshotCalls: 0,
    listeningPortCalls: 0,
    alive,
    openedUrls: [],
    async snapshot() {
      fake.snapshotCalls += 1;
      return processSnapshot.map((process) => ({ ...process }));
    },
    descendants(root, snapshot) {
      const byParent = new Map<number, ProcInfo[]>();
      for (const process of snapshot) {
        const children = byParent.get(process.ppid) ?? [];
        children.push(process);
        byParent.set(process.ppid, children);
      }
      const rootProcess = snapshot.find((process) => process.pid === root);
      const descendants: ProcInfo[] = rootProcess ? [rootProcess] : [];
      const queue = [root];
      const seen = new Set(queue);
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const parent = queue[cursor];
        if (parent === undefined) continue;
        for (const child of byParent.get(parent) ?? []) {
          if (seen.has(child.pid)) continue;
          seen.add(child.pid);
          queue.push(child.pid);
          descendants.push(child);
        }
      }
      return descendants;
    },
    async listeningPorts(pids) {
      fake.listeningPortCalls += 1;
      const requested = new Set(pids);
      return new Map(
        [...portMap.entries()]
          .filter(([pid]) => requested.has(pid))
          .map(([pid, ports]) => [pid, [...ports]]),
      );
    },
    async isAlive(pid) {
      return alive.has(pid);
    },
    async openUrl(url) {
      fake.openedUrls.push(url);
    },
  };
  return fake;
}
