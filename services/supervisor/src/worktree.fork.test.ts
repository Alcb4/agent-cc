import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { WorktreeManager } from "./worktree.js";

// Fork semantics: a fork's branch is cut from the SOURCE workspace's branch
// tip (committed work carries over), while baseBranch stays the original base
// (both source and fork merge into the same base independently).
describe("WorktreeManager fork (create with fromRef)", () => {
  let repo: string;
  const wt = new WorktreeManager();

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "agent-cc-fork-"));
    const git = simpleGit(repo);
    await git.init(["-b", "main"]);
    await git.addConfig("user.email", "t@t");
    await git.addConfig("user.name", "t");
    writeFileSync(join(repo, "a.txt"), "base\n");
    await git.add(".");
    await git.commit("base commit");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("cuts the fork from the source branch tip and keeps the original base", async () => {
    const src = await wt.create(repo, "source task", "src-id", "main");
    expect(src.ok).toBe(true);
    if (!src.ok) return;

    // commit work in the source worktree that main does NOT have
    const srcGit = simpleGit(src.value.worktreePath);
    writeFileSync(join(src.value.worktreePath, "work.txt"), "source work\n");
    await srcGit.add(".");
    await srcGit.commit("source work");

    const fork = await wt.create(repo, "fork task", "fork-id", "main", src.value.branch);
    expect(fork.ok).toBe(true);
    if (!fork.ok) return;

    // fork records the ORIGINAL base, not the source branch
    expect(fork.value.baseBranch).toBe("main");
    expect(fork.value.branch).toBe("workspace/fork-task/fork-id");

    // the source's committed work is present in the fork's worktree
    const forkGit = simpleGit(fork.value.worktreePath);
    const log = await forkGit.log();
    expect(log.all.map((c) => c.message)).toContain("source work");
  });

  it("defaults to the base branch tip when no fromRef is given", async () => {
    const plain = await wt.create(repo, "plain", "plain-id", "main");
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    const log = await simpleGit(plain.value.worktreePath).log();
    expect(log.all[0]!.message).toBe("base commit");
  });
});
