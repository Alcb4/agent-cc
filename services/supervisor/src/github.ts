// Phase 2: GitHub PR integration via the `gh` CLI (authenticated out of band by
// the user) + plain git for the push. Kept separate from worktree.ts (simple-git)
// because these shell out to gh. All calls run with cwd = repoRoot so gh infers
// the repo from the `origin` remote.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ok, err, appError, type Result } from "@agent-cc/shared";

const pexec = promisify(execFile);

// Does the repo have an `origin` remote? (Local read of .git/config — no network.)
export async function hasOrigin(repoRoot: string): Promise<boolean> {
  try {
    await pexec("git", ["-C", repoRoot, "remote", "get-url", "origin"]);
    return true;
  } catch {
    return false;
  }
}

// Push the workspace branch to origin (sets upstream).
export async function pushBranch(repoRoot: string, branch: string): Promise<Result<void>> {
  try {
    await pexec("git", ["-C", repoRoot, "push", "-u", "origin", branch]);
    return ok(undefined);
  } catch (e) {
    return err(appError("internal", `git push failed: ${stderrOf(e)}`));
  }
}

// Open a PR for branch → base. Returns the PR URL (gh prints it on stdout).
export async function createPr(
  repoRoot: string,
  branch: string,
  base: string,
  title: string,
  body: string,
): Promise<Result<{ url: string }>> {
  try {
    const { stdout } = await pexec(
      "gh",
      ["pr", "create", "--head", branch, "--base", base, "--title", title, "--body", body],
      { cwd: repoRoot },
    );
    const url = stdout.trim().split("\n").pop() ?? "";
    if (!url.startsWith("http")) return err(appError("internal", `unexpected gh output: ${stdout.trim()}`));
    return ok({ url });
  } catch (e) {
    return err(appError("internal", `gh pr create failed: ${stderrOf(e)}`));
  }
}

// PR state for K4 auto-transition. merged=true once it lands; best-effort.
export async function prState(
  repoRoot: string,
  prUrl: string,
): Promise<{ state: string; merged: boolean }> {
  try {
    const { stdout } = await pexec("gh", ["pr", "view", prUrl, "--json", "state,mergedAt"], {
      cwd: repoRoot,
    });
    const j = JSON.parse(stdout) as { state?: string; mergedAt?: string | null };
    return { state: j.state ?? "UNKNOWN", merged: Boolean(j.mergedAt) };
  } catch {
    return { state: "UNKNOWN", merged: false };
  }
}

function stderrOf(e: unknown): string {
  const anyErr = e as { stderr?: string; message?: string };
  return (anyErr.stderr || anyErr.message || String(e)).trim().split("\n").slice(-3).join(" ");
}
