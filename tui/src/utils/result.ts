/**
 * Discriminated union Result type for explicit error handling.
 *
 * Provides a functional alternative to try/catch for service methods
 * where callers need to inspect success/failure without exceptions.
 */

/** A successful result carrying a value. */
export interface Ok<T> {
  readonly ok: true
  readonly value: T
}

/** A failed result carrying an error. */
export interface Err<E> {
  readonly ok: false
  readonly error: E
}

/** Discriminated union of success and failure. */
export type Result<T, E = Error> = Ok<T> | Err<E>

/** Construct a successful Result. */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value }
}

/** Construct a failed Result. */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error }
}

/**
 * Unwrap a Result, throwing the error if it failed.
 * Useful when you want to convert back to exception-style handling.
 */
export function unwrap<T>(result: Result<T, Error>): T {
  if (result.ok) return result.value
  throw result.error
}
