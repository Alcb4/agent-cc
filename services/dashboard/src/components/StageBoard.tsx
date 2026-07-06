"use client";

import { useMemo } from "react";
import type { Workspace, ProjectSummary, WorkspaceActivity, WorkspaceStage } from "@agent-cc/shared";
import { mergeWorkspace, keepWorkspace, discardWorkspace, syncWorkspace, setStage } from "@/lib/api";
import { activityLabel } from "@/lib/activity";
import { clickableRow } from "@/lib/a11y";

// K3/K4: a kanban board grouping workspaces by workflow stage (orthogonal to
// runtime status). Review cards carry the merge/keep/discard decision; any card
// can be moved between stages (the no-drag move affordance). Auto-transitions
// (ended→review, merged→done) happen server-side; this just reflects them.
const COLUMNS: { stage: WorkspaceStage; label: string }[] = [
  { stage: "backlog", label: "Backlog" },
  { stage: "active", label: "Active" },
  { stage: "review", label: "Review" },
  { stage: "done", label: "Done" },
];

export function StageBoard({
  workspaces,
  projects,
  activity,
  onFocus,
  onToast,
  onRefresh,
}: {
  workspaces: Workspace[];
  projects: ProjectSummary[];
  activity: Record<string, WorkspaceActivity>;
  onFocus: (id: string) => void;
  onToast: (m: string) => void;
  onRefresh: () => void;
}) {
  const projName = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.id, p.name);
    return (id: string | null): string => (id ? (m.get(id) ?? "—") : "no project");
  }, [projects]);

  const byStage = (stage: WorkspaceStage) => workspaces.filter((w) => w.stage === stage);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      onToast(`${label} ok`);
      onRefresh();
    } catch (e) {
      onToast(`${label} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="board">
      {COLUMNS.map((col) => {
        const items = byStage(col.stage);
        return (
          <div className="board-col" key={col.stage}>
            <div className="board-col-head">
              <span className="micro">{col.label}</span>
              <span className="board-count">{items.length}</span>
            </div>
            <div className="board-col-body">
              {items.map((w) => {
                const a = activity[w.id];
                return (
                  <div className="board-card" key={w.id}>
                    <div className="board-card-main" {...clickableRow(() => onFocus(w.id))}>
                      <div className="board-card-head">
                        <span className={`pill ${w.status}`}>{w.status}</span>
                        {a?.live ? <span className={`act act-${a.state}`}>{activityLabel(a.state)}</span> : null}
                      </div>
                      <div className="board-card-name">{w.name}</div>
                      <div className="board-card-meta">
                        {projName(w.projectId)} · {w.branch}
                      </div>
                    </div>

                    {w.stage === "review" && w.prUrl && (
                      <div className="board-actions">
                        <a className="pr-link" href={w.prUrl} target="_blank" rel="noreferrer">
                          PR ↗
                        </a>
                        <span className="micro">awaiting merge</span>
                      </div>
                    )}
                    {w.stage === "review" && !w.prUrl && (
                      <div className="board-actions">
                        <button onClick={() => void act("Merge", () => mergeWorkspace(w.id))}>Merge</button>
                        <button
                          onClick={() => void act("Sync from base", () => syncWorkspace(w.id))}
                          title="Pull base into this worktree to resolve/avoid conflicts"
                        >
                          Sync
                        </button>
                        <button onClick={() => void act("Keep", () => keepWorkspace(w.id))}>Keep</button>
                        <button onClick={() => void act("Discard", () => discardWorkspace(w.id))}>Discard</button>
                      </div>
                    )}

                    <div className="board-foot">
                      <select
                        className="board-move"
                        value={w.stage}
                        onChange={(e) => void act("Move", () => setStage(w.id, e.target.value))}
                        title="Move to stage"
                      >
                        {COLUMNS.map((c) => (
                          <option key={c.stage} value={c.stage}>
                            → {c.label}
                          </option>
                        ))}
                      </select>
                      <button
                        className="board-remove"
                        title="Remove this task"
                        onClick={() => {
                          const msg =
                            w.stage === "done"
                              ? `Remove "${w.name}" from the board? (its work was already merged/kept)`
                              : `Discard "${w.name}"? This ends its session and throws away its worktree + branch.`;
                          if (confirm(msg)) void act("Remove", () => discardWorkspace(w.id));
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                );
              })}
              {items.length === 0 && <div className="board-empty micro">empty</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
