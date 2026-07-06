// Structured error values returned across the supervisor's public API.
// Stable string codes so the dashboard can branch on them.

export type ErrorCode =
  | "workspace.not_found"
  | "workspace.dirty"
  | "workspace.no_commits"
  | "workspace.merge_conflict"
  | "worktree.orphaned"
  | "tmux.spawn_failed"
  | "tmux.session_gone"
  | "memory.write_failed"
  | "memory.read_failed"
  | "service.unreachable"
  | "bad_request"
  | "internal";

export interface AppError {
  code: ErrorCode;
  message: string;
  detail?: unknown;
}

export function appError(code: ErrorCode, message: string, detail?: unknown): AppError {
  return detail === undefined ? { code, message } : { code, message, detail };
}
