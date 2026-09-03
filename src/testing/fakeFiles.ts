import { dirname, relative, resolve, sep } from "node:path";
import type { FilesPort } from "../core/ports.ts";

export interface FakeFilesInitial {
  paths?: Iterable<string>;
  texts?: Record<string, string> | Iterable<readonly [string, string]>;
}

export type FakeFilesCall = { method: keyof FilesPort; args: unknown[] };

export type FakeFiles = FilesPort & {
  calls: FakeFilesCall[];
  paths: Set<string>;
  texts: Map<string, string>;
  removed: string[];
};

function textEntries(texts: FakeFilesInitial["texts"]): Iterable<readonly [string, string]> {
  if (!texts) return [];
  return Symbol.iterator in Object(texts)
    ? (texts as Iterable<readonly [string, string]>)
    : Object.entries(texts);
}

function isWithin(path: string, prefix: string): boolean {
  const child = relative(prefix, path);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== "..");
}

export function createFakeFiles(initial: FakeFilesInitial = {}): FakeFiles {
  const paths = new Set([...(initial.paths ?? [])].map((path) => resolve(path)));
  const texts = new Map(
    [...textEntries(initial.texts)].map(([path, text]) => [resolve(path), text]),
  );
  for (const path of texts.keys()) paths.add(path);
  const calls: FakeFilesCall[] = [];
  const removed: string[] = [];

  const removePrefix = (path: string): void => {
    const absolute = resolve(path);
    removed.push(absolute);
    for (const candidate of [...paths]) if (isWithin(candidate, absolute)) paths.delete(candidate);
    for (const candidate of [...texts.keys()]) {
      if (isWithin(candidate, absolute)) texts.delete(candidate);
    }
  };

  const movePrefix = (src: string, dest: string): void => {
    for (const path of [...paths]) {
      if (!isWithin(path, src)) continue;
      paths.delete(path);
      paths.add(resolve(dest, relative(src, path)));
    }
    for (const [path, text] of [...texts]) {
      if (!isWithin(path, src)) continue;
      texts.delete(path);
      texts.set(resolve(dest, relative(src, path)), text);
    }
  };

  return {
    calls,
    paths,
    texts,
    removed,
    async exists(path) {
      calls.push({ method: "exists", args: [path] });
      const absolute = resolve(path);
      return paths.has(absolute) || [...paths].some((candidate) => isWithin(candidate, absolute));
    },
    async ensureDir(path) {
      calls.push({ method: "ensureDir", args: [path] });
      paths.add(resolve(path));
    },
    async cloneTree(src, dest) {
      calls.push({ method: "cloneTree", args: [src, dest] });
      const source = resolve(src);
      const destination = resolve(dest);
      for (const path of [...paths]) {
        if (isWithin(path, source)) paths.add(resolve(destination, relative(source, path)));
      }
      for (const [path, text] of [...texts]) {
        if (isWithin(path, source)) texts.set(resolve(destination, relative(source, path)), text);
      }
    },
    async move(src, dest) {
      calls.push({ method: "move", args: [src, dest] });
      movePrefix(resolve(src), resolve(dest));
    },
    async removeTree(path) {
      calls.push({ method: "removeTree", args: [path] });
      removePrefix(path);
    },
    async removeDetached(path) {
      calls.push({ method: "removeDetached", args: [path] });
      removePrefix(path);
    },
    async readText(path) {
      calls.push({ method: "readText", args: [path] });
      return texts.get(resolve(path)) ?? null;
    },
    async writeTextAtomic(path, text) {
      calls.push({ method: "writeTextAtomic", args: [path, text] });
      const absolute = resolve(path);
      paths.add(dirname(absolute));
      paths.add(absolute);
      texts.set(absolute, text);
    },
    async listDirs(path) {
      calls.push({ method: "listDirs", args: [path] });
      const absolute = resolve(path);
      const directories = new Set<string>();
      for (const candidate of paths) {
        const child = relative(absolute, candidate);
        if (!child || child.startsWith("..")) continue;
        if (!child.includes(sep) && texts.has(candidate)) continue;
        directories.add(child.split(sep)[0] ?? child);
      }
      return [...directories].filter((name) => !name.startsWith(".hot")).sort();
    },
  };
}
