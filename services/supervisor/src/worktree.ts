// Worktree manager. The supervisor owns git isolation end to end: one workspace
// = one git worktree at .worktrees/<uuid>/ on branch workspace/<name>/<uuid>.
// The user never types `git worktree add`.
//
// Locked rules (design doc, Service 0 / Worktree management):
//  - refuse to create a workspace if the repo has no commits
//  - refuse to start a session on a dirty worktree (never auto-stash)
//  - on session end the user picks merge / discard / keep (no auto-anything)
//  - merge is `git merge --no-ff`; a conflict is surfaced, not resolved here
//  - discard requires explicit confirmation and force-removes the worktree
//  - all git goes through simple-git (thin CLI wrapper, in-process)

import { simpleGit, type SimpleGit } from "simple-git";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { ok, err, appError, type Result } from "@agent-cc/shared";

// One immediate subdirectory of the projects root, classified for the N1 picker.
export interface ScanEntry {
  name: string;
  path: string;
  isRepo: boolean;
  hasCommits: boolean;
  dirty: boolean;
}

export interface DirtyState {
  dirty: boolean;
  // Files that count as dirty (block a session start).
  blocking: string[];
  // Untracked tooling files we treat quietly (caches, OS cruft) — informational.
  quiet: string[];
}

// Untracked paths that should not, on their own, trigger the refuse-on-dirty
// friction (Risk 8 counter-mitigation). Matched against the porcelain path.
const QUIET_PATTERNS = [/(^|\/)\.cache(\/|$)/, /(^|\/)\.DS_Store$/, /(^|\/)node_modules(\/|$)/, /(^|\/)\.turbo(\/|$)/];

function isQuiet(path: string): boolean {
  return QUIET_PATTERNS.some((re) => re.test(path));
}

// Turn a free-text workspace name into a valid git branch segment: lowercase,
// non-[a-z0-9._-] runs → hyphens, trimmed, capped. Falls back to "task" if empty.
function branchSlug(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 40)
    .replace(/[-.]+$/g, "");
  return s || "task";
}

export interface WorktreeInfo {
  worktreePath: string;
  branch: string;
  baseBranch: string;
}

export class WorktreeManager {
  // Confirm the repo exists and has at least one commit (a worktree needs a tip).
  async ensureRepoReady(repoRoot: string): Promise<Result<{ baseBranch: string }>> {
    const git = simpleGit(repoRoot);
    let isRepo: boolean;
    try {
      isRepo = await git.checkIsRepo();
    } catch (e) {
      return err(appError("bad_request", `not a git repo: ${(e as Error).message}`));
    }
    if (!isRepo) return err(appError("bad_request", `${repoRoot} is not a git repository`));

    try {
      const count = (await git.raw(["rev-list", "--count", "HEAD"])).trim();
      if (count === "0") {
        return err(appError("workspace.no_commits", "repository has no commits yet"));
      }
    } catch {
      return err(appError("workspace.no_commits", "repository has no commits yet"));
    }

    const baseBranch = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
    return ok({ baseBranch });
  }

  // Scan the immediate subdirectories of `root`, reporting which are usable git
  // repos (N1 project-root picker). Skips dotfolders; reports each candidate's
  // repo/commit/dirty state so the dashboard can guide the choice.
  async scanRoot(root: string): Promise<Result<ScanEntry[]>> {
    let dirents;
    try {
      dirents = await readdir(root, { withFileTypes: true });
    } catch (e) {
      return err(appError("bad_request", `cannot read ${root}: ${(e as Error).message}`));
    }
    const dirs = dirents.filter((d) => d.isDirectory() && !d.name.startsWith("."));
    const entries: ScanEntry[] = [];
    for (const d of dirs) {
      const path = join(root, d.name);
      const git = simpleGit(path);
      let isRepo = false;
      let hasCommits = false;
      let dirty = false;
      try {
        isRepo = await git.checkIsRepo();
        if (isRepo) {
          const count = (await git.raw(["rev-list", "--count", "HEAD"])).trim();
          hasCommits = count !== "0";
          const status = await git.status();
          dirty = status.files.some((f) => !isQuiet(f.path));
        }
      } catch {
        // leave defaults — an unreadable / partial repo just shows as not-usable
      }
      entries.push({ name: d.name, path, isRepo, hasCommits, dirty });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return ok(entries);
  }

  // Create the isolated worktree + branch. The display name is slugified for
  // the branch segment (git branch names can't contain spaces or many
  // punctuation chars) — the original name stays on the workspace. By default
  // the branch starts at the base branch tip; a fork passes the source
  // workspace's branch as `fromRef` while keeping the original base (so the
  // fork still merges into the same base as its source).
  async create(
    repoRoot: string,
    name: string,
    workspaceId: string,
    baseBranch: string,
    fromRef: string = baseBranch,
  ): Promise<Result<WorktreeInfo>> {
    const branch = `workspace/${branchSlug(name)}/${workspaceId}`;
    const worktreePath = join(repoRoot, ".worktrees", workspaceId);
    const git = simpleGit(repoRoot);
    try {
      await git.raw(["worktree", "add", "-b", branch, worktreePath, fromRef]);
    } catch (e) {
      return err(appError("internal", `git worktree add failed: ${(e as Error).message}`));
    }
    return ok({ worktreePath, branch, baseBranch });
  }

  async dirtyState(worktreePath: string): Promise<Result<DirtyState>> {
    try {
      const status = await simpleGit(worktreePath).status();
      const blocking: string[] = [];
      const quiet: string[] = [];
      for (const f of status.files) {
        if (isQuiet(f.path)) quiet.push(f.path);
        else blocking.push(f.path);
      }
      // Mid-rebase / mid-merge / detached HEAD also count as not-startable.
      const inProgress = status.detached;
      return ok({ dirty: blocking.length > 0 || inProgress, blocking, quiet });
    } catch (e) {
      return err(appError("internal", `git status failed: ${(e as Error).message}`));
    }
  }

  // Merge the workspace branch into its base branch. This runs at the repo root,
  // not inside the worktree: git forbids checking out the base branch in a second
  // worktree while it is checked out at the root, so the base branch is merged
  // where it actually lives. On conflict, abort cleanly and surface it — the user
  // resolves in a real terminal.
  async merge(repoRoot: string, info: WorktreeInfo): Promise<Result<{ merged: true }>> {
    const git = simpleGit(repoRoot);
    try {
      const current = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
      if (current !== info.baseBranch) await git.checkout(info.baseBranch);
    } catch (e) {
      return err(appError("internal", `checkout ${info.baseBranch} failed: ${(e as Error).message}`));
    }
    // NB: simple-git's raw(['merge']) does NOT reliably reject on a conflicting
    // merge (git exits 1 but the promise can resolve), so we detect conflicts
    // from `git status` rather than relying on a throw.
    let mergeErr: Error | null = null;
    try {
      await git.raw(["merge", "--no-ff", "--no-edit", info.branch]);
    } catch (e) {
      mergeErr = e as Error;
    }
    let conflicted: string[] = [];
    try {
      conflicted = (await git.status()).conflicted;
    } catch {
      // status unreadable — fall through; mergeErr (if any) is surfaced below
    }
    if (conflicted.length > 0) {
      // Don't leave the shared base half-merged: abort so base is clean, and
      // surface the conflict. Resolution path is "Sync from base" (pull base
      // into the worktree, resolve there, commit), then merge again — clean.
      try {
        await git.raw(["merge", "--abort"]);
      } catch {
        // nothing to abort
      }
      return err(
        appError("workspace.merge_conflict", "merge conflict — use Sync from base to resolve, then merge again", {
          branch: info.branch,
          base: info.baseBranch,
          files: conflicted,
        }),
      );
    }
    if (mergeErr) {
      return err(appError("internal", `merge failed: ${mergeErr.message}`));
    }
    // Merged cleanly → the branch is now in base; reclaim the worktree + branch.
    await this.remove(repoRoot, info); // best-effort; merge already succeeded
    return ok({ merged: true });
  }

  // Merge the base branch INTO the workspace branch, inside the worktree (brings
  // the worktree up to date and surfaces conflicts here, where a session can
  // resolve them — not in the shared base). On conflict the merge is left in
  // place (markers + MERGE_HEAD) for resolution; on clean it just advances.
  async syncFromBase(
    worktreePath: string,
    baseBranch: string,
  ): Promise<Result<{ conflict: boolean; files: string[] }>> {
    const git = simpleGit(worktreePath);
    // Same caveat as merge(): detect conflicts from status, not from a throw.
    let mergeErr: Error | null = null;
    try {
      await git.raw(["merge", "--no-edit", baseBranch]);
    } catch (e) {
      mergeErr = e as Error;
    }
    let conflicted: string[] = [];
    try {
      conflicted = (await git.status()).conflicted;
    } catch {
      // fall through
    }
    if (conflicted.length > 0) return ok({ conflict: true, files: conflicted }); // leave in place to resolve
    if (mergeErr) return err(appError("internal", `sync from base failed: ${mergeErr.message}`));
    return ok({ conflict: false, files: [] });
  }

  // Reclaim a worktree: force-remove the dir and delete the branch. Used by both
  // discard (throw work away) and post-merge cleanup (work already landed).
  async remove(repoRoot: string, info: WorktreeInfo): Promise<Result<void>> {
    const git = simpleGit(repoRoot);
    try {
      await git.raw(["worktree", "remove", "--force", info.worktreePath]);
    } catch (e) {
      return err(appError("internal", `worktree remove failed: ${(e as Error).message}`));
    }
    try {
      await git.raw(["branch", "-D", info.branch]);
    } catch {
      // branch may already be gone; not fatal
    }
    return ok(undefined);
  }

  // Discard = reclaim the worktree, throwing the work away. Caller must confirm.
  async discard(repoRoot: string, info: WorktreeInfo): Promise<Result<void>> {
    return this.remove(repoRoot, info);
  }

  // K4: has the workspace branch already landed in its base branch? (true when
  // the branch tip is an ancestor of the base tip — i.e. it was merged, here or
  // externally). Best-effort: any git error is treated as "not merged".
  async isMerged(repoRoot: string, branch: string, baseBranch: string): Promise<boolean> {
    try {
      const git = simpleGit(repoRoot);
      await git.raw(["merge-base", "--is-ancestor", branch, baseBranch]);
      return true; // exit 0 → ancestor → merged
    } catch {
      return false; // exit 1 (not ancestor) or any error
    }
  }

  // Liveness probe used by the monitor. Orphaned = the worktree's HEAD can no
  // longer be resolved (e.g. branch deleted, worktree dir removed manually).
  async probe(worktreePath: string): Promise<{ alive: boolean; dirty: boolean }> {
    try {
      const git: SimpleGit = simpleGit(worktreePath);
      await git.revparse(["HEAD"]);
      const status = await git.status();
      const dirty = status.files.some((f) => !isQuiet(f.path));
      return { alive: true, dirty };
    } catch {
      return { alive: false, dirty: false };
    }
  }
}
