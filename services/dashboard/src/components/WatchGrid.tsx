"use client";

import { useMemo, useState } from "react";
import type { Workspace, ProjectSummary, WorkspaceActivity } from "@agent-cc/shared";
import { Terminal } from "@/components/Terminal";
import { sendInput, runWorkspace } from "@/lib/api";
import { type Cta, loadCtas, saveCtas, DEFAULT_CTAS } from "@/lib/ctas";
import { activityLabel } from "@/lib/activity";
import { clickableRow } from "@/lib/a11y";

// B2 — tiled live-watch grid. One read-only pane per workspace, streaming the
// same supervisor WebSocket as the focused terminal (multi-subscriber + the
// scrollback replay on connect means a fresh pane shows current state). Each
// pane carries the N5 quick-CTA action row.
export function WatchGrid({
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
  const [ctas, setCtas] = useState<Cta[]>(() => loadCtas());
  const [editing, setEditing] = useState(false);

  const projName = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.id, p.name);
    return (id: string | null): string => (id ? (m.get(id) ?? "—") : "no project");
  }, [projects]);

  return (
    <div className="watch">
      <div className="watch-bar">
        <span className="micro">
          Watching {workspaces.length} workspace{workspaces.length === 1 ? "" : "s"}
        </span>
        <button onClick={() => setEditing((e) => !e)}>{editing ? "Done" : "Edit CTAs"}</button>
      </div>

      {editing && (
        <CtaEditor
          ctas={ctas}
          onSave={(next) => {
            setCtas(next);
            saveCtas(next);
            setEditing(false);
            onToast("CTAs saved");
          }}
        />
      )}

      {workspaces.length === 0 ? (
        <div className="empty">No workspaces yet. Create a task to start watching.</div>
      ) : (
        <div className="watch-grid">
          {workspaces.map((w) => (
            <WatchPane
              key={w.id}
              w={w}
              projectName={projName(w.projectId)}
              act={activity[w.id]}
              ctas={ctas}
              onFocus={onFocus}
              onToast={onToast}
              onRefresh={onRefresh}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function WatchPane({
  w,
  projectName,
  act,
  ctas,
  onFocus,
  onToast,
  onRefresh,
}: {
  w: Workspace;
  projectName: string;
  act: WorkspaceActivity | undefined;
  ctas: Cta[];
  onFocus: (id: string) => void;
  onToast: (m: string) => void;
  onRefresh: () => void;
}) {
  // A live tmux session exists for everything except a fully ended/error pane.
  const live = w.status === "running" || w.status === "idle" || w.status === "dirty";

  const fire = async (c: Cta): Promise<void> => {
    try {
      await sendInput(w.id, `${c.command}\r`);
      onToast(`${c.label} → ${w.name}`);
    } catch (e) {
      onToast(`${c.label} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const rerun = async (): Promise<void> => {
    try {
      await runWorkspace(w.id);
      onToast(`Re-run ${w.name}`);
      onRefresh();
    } catch (e) {
      onToast(`Re-run failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="watch-pane">
      <div className="watch-head" {...clickableRow(() => onFocus(w.id))}>
        <span className={`pill ${w.status}`}>{w.status}</span>
        {act?.live ? <span className={`act act-${act.state}`}>{activityLabel(act.state)}</span> : null}
        <span className="watch-name">{w.name}</span>
        <span className="watch-meta">
          {projectName} · {w.branch}
        </span>
      </div>

      <div className="watch-body">
        {live ? (
          <>
            <Terminal workspace={w} readOnly fontSize={11} onEnded={onRefresh} />
            {/* transparent overlay: click focuses the pane without stealing xterm
                selection logic. Hidden from AT — the same action is keyboard-
                reachable via the pane header row. */}
            <div className="watch-overlay" aria-hidden="true" onClick={() => onFocus(w.id)} />
          </>
        ) : (
          <div className="watch-dead">
            <span className="micro">session {w.status}</span>
            <button onClick={() => void rerun()}>Re-run</button>
          </div>
        )}
      </div>

      <div className="watch-ctas">
        {ctas.map((c) => (
          <button key={c.id} disabled={!live} onClick={() => void fire(c)} title={c.command}>
            {c.label}
          </button>
        ))}
        <button className="watch-focus" onClick={() => onFocus(w.id)}>
          Focus →
        </button>
      </div>
    </div>
  );
}

// Minimal CTA editor: one "Label = command" per line. Keeps the customise path
// concrete without a heavyweight form; persisted to localStorage by the parent.
function CtaEditor({ ctas, onSave }: { ctas: Cta[]; onSave: (next: Cta[]) => void }) {
  const [text, setText] = useState(() => ctas.map((c) => `${c.label} = ${c.command}`).join("\n"));

  const parse = (): Cta[] => {
    const out: Cta[] = [];
    for (const line of text.split("\n")) {
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const label = line.slice(0, eq).trim();
      const command = line.slice(eq + 1).trim();
      if (!label || !command) continue;
      out.push({ id: label.toLowerCase().replace(/\s+/g, "-"), label, command });
    }
    return out.length > 0 ? out : DEFAULT_CTAS;
  };

  return (
    <div className="cta-editor">
      <span className="micro">One per line — Label = /command</span>
      <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      <div className="cta-editor-actions">
        <button className="primary" onClick={() => onSave(parse())}>
          Save
        </button>
        <button
          onClick={() => {
            setText(DEFAULT_CTAS.map((c) => `${c.label} = ${c.command}`).join("\n"));
          }}
        >
          Reset to defaults
        </button>
      </div>
    </div>
  );
}
