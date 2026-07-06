"use client";

import { useCallback, useEffect, useState } from "react";
import type { ContextPack, MemoryItem, QueueItem, Schedule } from "@agent-cc/shared";
import {
  getContext,
  getProjectContext,
  injectContext,
  listQueue,
  enqueueCommand,
  removeQueueItem,
  clearQueue,
  listSchedules,
  addSchedule,
  setScheduleEnabled,
  removeSchedule,
} from "@/lib/api";

export type RightTab = "memory" | "runs" | "inject" | "queue";

// Right panel: per-workspace memory (the value prop) with three tabs. Fetches the
// context pack once per workspace/refresh and renders the active tab from it.
export function RightPanel({
  workspaceId,
  tab,
  onTab,
  refreshKey,
  onToast,
}: {
  workspaceId: string;
  tab: RightTab;
  onTab: (t: RightTab) => void;
  refreshKey: number;
  onToast: (m: string) => void;
}) {
  const [pack, setPack] = useState<ContextPack | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setError(null);
    getContext(workspaceId)
      .then((p) => active && setPack(p))
      .catch((e) => active && setError(String(e)));
    return () => {
      active = false;
    };
  }, [workspaceId, refreshKey]);

  const tabBtn = (id: RightTab, label: string) => (
    <button className={`subtab${tab === id ? " active" : ""}`} onClick={() => onTab(id)}>
      {label}
    </button>
  );

  return (
    <>
      <div className="subtabs">
        {tabBtn("memory", "Memory")}
        {tabBtn("runs", "Runs")}
        {tabBtn("queue", "Queue")}
        {tabBtn("inject", "Inject")}
      </div>
      {tab === "queue" && <Queue workspaceId={workspaceId} refreshKey={refreshKey} onToast={onToast} />}
      {tab !== "queue" && error && <div className="empty">memory unavailable: {error}</div>}
      {tab !== "queue" && !error && !pack && <div className="empty">loading…</div>}
      {!error && pack && tab === "memory" && <MemoryList pack={pack} />}
      {!error && pack && tab === "runs" && <RunsList items={pack.recentRuns} />}
      {!error && pack && tab === "inject" && (
        <InjectPreview
          rendered={pack.rendered}
          onInject={async () => {
            try {
              const r = await injectContext(workspaceId);
              onToast(`Context sent (${r.bytes} bytes)`);
            } catch {
              onToast("Failed to inject — agent may be in a non-paste state");
            }
          }}
        />
      )}
    </>
  );
}

const TYPE_LABEL: Record<string, string> = {
  decision: "Decision",
  gotcha: "Gotcha",
  recent_run_summary: "Run",
  project_overlay: "Overlay",
  persona: "Persona",
};

// Human-readable "3m ago" / "2h ago" / "5d ago" from an ISO timestamp.
function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// A run summary opens with "Run ended (exit N).": surface that as a done/failed
// chip so the outcome reads at a glance instead of hiding in the prose.
function runOutcome(item: MemoryItem): "ok" | "fail" | null {
  if (item.type !== "recent_run_summary") return null;
  const m = /exit (\d+|unknown)/i.exec(item.body);
  if (!m || m[1] === "unknown") return null;
  return m[1] === "0" ? "ok" : "fail";
}

// Rolled-up items carry a `task:<name>` tag; show which task the value came from.
function taskProvenance(item: MemoryItem): string | null {
  const t = item.tags.find((x) => x.startsWith("task:"));
  return t ? t.slice("task:".length) : null;
}

function Row({ item }: { item: MemoryItem }) {
  const outcome = runOutcome(item);
  const from = taskProvenance(item);
  return (
    <div className="mem-row">
      <div className="mem-head">
        <span className={`mem-type mt-${item.type}`}>
          {TYPE_LABEL[item.type] ?? item.type.replace(/_/g, " ")}
        </span>
        {outcome && (
          <span className={`mem-outcome mo-${outcome}`}>{outcome === "ok" ? "done" : "failed"}</span>
        )}
        {from && (
          <span className="mem-from" title={`from task “${from}”`}>
            {from}
          </span>
        )}
        <span className="mem-time" title={item.createdAt}>
          {relTime(item.createdAt)}
        </span>
      </div>
      <div className="mem-body">{item.body}</div>
    </div>
  );
}

function Section({ title, items }: { title: string; items: MemoryItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mem-section">
      <div className="mem-section-head">{title}</div>
      {items.map((i) => (
        <Row key={i.id} item={i} />
      ))}
    </div>
  );
}

function MemoryList({ pack }: { pack: ContextPack }) {
  const total = pack.recentDecisions.length + pack.gotchas.length + pack.recentRuns.length;
  if (total === 0) {
    return <div className="empty">No memory yet. Run a session; its summary appears here.</div>;
  }
  return (
    <div className="mem-list">
      <Section title="Decisions" items={pack.recentDecisions} />
      <Section title="Gotchas" items={pack.gotchas} />
      <Section title="Runs" items={pack.recentRuns} />
    </div>
  );
}

// The project's rolled-up memory: value carried over from its removed tasks.
// Read-only — shown in the right panel when a project is selected with no task.
export function ProjectMemory({
  projectId,
  projectName,
  refreshKey,
}: {
  projectId: string;
  projectName: string;
  refreshKey: number;
}) {
  const [pack, setPack] = useState<ContextPack | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setError(null);
    getProjectContext(projectId)
      .then((p) => active && setPack(p))
      .catch((e) => active && setError(String(e)));
    return () => {
      active = false;
    };
  }, [projectId, refreshKey]);

  return (
    <>
      <div className="panel-head">
        <h2 className="micro">Project memory · {projectName}</h2>
      </div>
      <div className="mem-note micro">What ended tasks in this project left behind. Removing a task rolls its value up here.</div>
      {error && <div className="empty">memory unavailable: {error}</div>}
      {!error && !pack && <div className="empty">loading…</div>}
      {!error && pack && <MemoryList pack={pack} />}
    </>
  );
}

function RunsList({ items }: { items: MemoryItem[] }) {
  if (items.length === 0) return <div className="empty">No runs yet.</div>;
  return (
    <div className="mem-list">
      {items.map((i) => (
        <Row key={i.id} item={i} />
      ))}
    </div>
  );
}

// N4: the workspace's command queue. Commands run sequentially in the session,
// advancing when it goes idle. Polls so server-driven advances show up live.
function Queue({
  workspaceId,
  refreshKey,
  onToast,
}: {
  workspaceId: string;
  refreshKey: number;
  onToast: (m: string) => void;
}) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [cmd, setCmd] = useState("");

  const load = useCallback(() => {
    void listQueue(workspaceId)
      .then(setItems)
      .catch(() => undefined);
  }, [workspaceId]);

  useEffect(() => {
    load();
    const h = setInterval(load, 2000);
    return () => clearInterval(h);
  }, [load, refreshKey]);

  const add = async () => {
    if (!cmd.trim()) return;
    try {
      await enqueueCommand(workspaceId, cmd);
      setCmd("");
      load();
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <div className="stack">
        <span className="micro">Queue · runs sequentially, advances when the agent goes idle</span>
        <input
          placeholder="command (e.g. /tests, a prompt, a shell line)"
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void add()}
        />
        <div className="board-actions">
          <button className="primary" onClick={() => void add()}>
            + Enqueue
          </button>
          {items.length > 0 && (
            <button onClick={() => void clearQueue(workspaceId).then(load)}>Clear</button>
          )}
        </div>
      </div>
      {items.length === 0 && <div className="empty">Queue is empty.</div>}
      {items.map((it) => (
        <div key={it.id} className="q-row">
          <span className={`q-status q-${it.status}`}>
            {it.status === "pending" ? "queued" : it.status}
          </span>
          <span className="q-cmd mono" title={it.command}>
            {it.command}
          </span>
          {it.status !== "running" && (
            <button
              className="q-del"
              onClick={() => void removeQueueItem(workspaceId, it.id).then(load)}
              title="Remove"
            >
              ✕
            </button>
          )}
        </div>
      ))}
      <Schedules workspaceId={workspaceId} refreshKey={refreshKey} onToast={onToast} />
    </div>
  );
}

// N3: recurring schedules that enqueue a command on a cron cadence.
function Schedules({
  workspaceId,
  refreshKey,
  onToast,
}: {
  workspaceId: string;
  refreshKey: number;
  onToast: (m: string) => void;
}) {
  const [rows, setRows] = useState<Schedule[]>([]);
  const [cron, setCron] = useState("");
  const [cmd, setCmd] = useState("");

  const load = useCallback(() => {
    void listSchedules(workspaceId)
      .then(setRows)
      .catch(() => undefined);
  }, [workspaceId]);

  useEffect(() => {
    load();
    const h = setInterval(load, 5000);
    return () => clearInterval(h);
  }, [load, refreshKey]);

  const add = async () => {
    if (!cron.trim() || !cmd.trim()) return;
    try {
      await addSchedule(workspaceId, cron, cmd);
      setCron("");
      setCmd("");
      load();
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <div className="stack">
        <span className="micro">Schedules · cron (min hour dom mon dow) → enqueues a command</span>
        <input placeholder="cron e.g. 0 9 * * 1-5" value={cron} onChange={(e) => setCron(e.target.value)} />
        <input
          placeholder="command to run"
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void add()}
        />
        <button className="primary" onClick={() => void add()}>
          + Add schedule
        </button>
      </div>
      {rows.map((s) => (
        <div key={s.id} className="q-row">
          <span className="mono q-cron">{s.cron}</span>
          <span className="q-cmd mono" title={s.command}>
            {s.command}
          </span>
          <button
            className="q-del"
            onClick={() => void setScheduleEnabled(workspaceId, s.id, !s.enabled).then(load)}
            title={s.enabled ? "Disable" : "Enable"}
          >
            {s.enabled ? "⏸" : "▶"}
          </button>
          <button className="q-del" onClick={() => void removeSchedule(workspaceId, s.id).then(load)} title="Remove">
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

function InjectPreview({ rendered, onInject }: { rendered: string; onInject: () => void }) {
  return (
    <div className="inject-preview">
      <pre className="inject-text">{rendered || "(empty context pack)"}</pre>
      <div className="stack">
        <button className="primary" onClick={onInject}>
          Inject into session
        </button>
      </div>
    </div>
  );
}
