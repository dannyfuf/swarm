export type ErrorCode =
  | "not-found"
  | "conflict"
  | "refused"
  | "git"
  | "tmux"
  | "fs"
  | "github"
  | "remote"
  | "validation"
  | "cancelled"
  | "unsupported";

const errnoNamePattern = /^E[A-Z0-9]+$/u;

/**
 * Walks the `cause` chain of an error and returns the first POSIX errno name
 * (`ENOENT`, `ENOTDIR`, ...) found on it. Adapters wrap syscall failures in a
 * `SwarmError` whose `code` is a `ErrorCode`, so the original errno is only
 * reachable through the cause chain.
 */
export function errnoCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth += 1) {
    const code: unknown = (current as { code?: unknown }).code;
    if (typeof code === "string" && errnoNamePattern.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export class SwarmError extends Error {
  readonly code: ErrorCode;
  override readonly cause?: unknown;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SwarmError";
    this.code = code;
    this.cause = options?.cause;
  }
}
