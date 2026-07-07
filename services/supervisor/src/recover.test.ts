import { describe, expect, it } from "vitest";
import { recoveryAction } from "./workspace.js";

// Crash recovery decision (T4). A clean session end kills its tmux session, so a
// workspace marked ended/error whose session is nonetheless alive is status drift
// from an abrupt crash and must be revived — otherwise the task is stranded as
// "ended" with a live agent no one can reach.
describe("recoveryAction", () => {
  it("revives a terminal-status workspace whose session survived a crash", () => {
    expect(recoveryAction("ended", true)).toBe("revive");
    expect(recoveryAction("error", true)).toBe("revive");
  });

  it("reattaches a live session without touching a non-terminal status", () => {
    expect(recoveryAction("running", true)).toBe("reattach");
    expect(recoveryAction("idle", true)).toBe("reattach");
    expect(recoveryAction("dirty", true)).toBe("reattach");
  });

  it("marks a tracked-running workspace ended once its session is gone", () => {
    expect(recoveryAction("running", false)).toBe("mark-ended");
  });

  it("leaves an already-terminal workspace alone when its session is gone", () => {
    expect(recoveryAction("ended", false)).toBe("leave");
    expect(recoveryAction("error", false)).toBe("leave");
    expect(recoveryAction("idle", false)).toBe("leave");
  });
});
