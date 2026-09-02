export type ErrorCode =
  | "not-found"
  | "conflict"
  | "git"
  | "tmux"
  | "fs"
  | "github"
  | "validation"
  | "cancelled"
  | "unsupported";

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
