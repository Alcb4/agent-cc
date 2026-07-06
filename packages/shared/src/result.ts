// Errors as values, not exceptions (per AGENTS.md conventions).
// Exceptions are reserved for programmer errors only.

import type { AppError } from "./errors.js";

export type Result<T, E = AppError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(r: Result<T, E>): r is { ok: true; value: T } {
  return r.ok;
}

export function isErr<T, E>(r: Result<T, E>): r is { ok: false; error: E } {
  return !r.ok;
}

// Unwrap a Result or throw. Use only at boundaries where a failure is a
// programmer error, never in normal control flow.
export function unwrap<T, E>(r: Result<T, E>): T {
  if (r.ok) return r.value;
  throw new Error(`unwrap called on an error Result: ${JSON.stringify(r.error)}`);
}
