"use client";

import { useCallback, useEffect, useState } from "react";
import type { AuditEntry } from "@agent-cc/shared";
import { getAuditLog } from "@/lib/api";

// Security / audit-log viewer (Cmd-K → security). Surfaces audit.db: every LLM
// gateway call and every proxied OAuth operation, newest first, with denials /
// errors highlighted. Read-only.
export function SecurityPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [filter, setFilter] = useState<"all" | "llm" | "oauth">("all");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(() => {
    void getAuditLog(200)
      .then((e) => {
        setEntries(e);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  useEffect(() => {
    if (open) {
      setLoaded(false);
      load();
    }
  }, [open, load]);

  if (!open) return null;
  const rows = entries.filter((e) => filter === "all" || e.kind === filter);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="config" onClick={(e) => e.stopPropagation()}>
        <div className="subtabs">
          {(["all", "llm", "oauth"] as const).map((f) => (
            <button key={f} className={`subtab${filter === f ? " active" : ""}`} onClick={() => setFilter(f)}>
              {f === "all" ? "All" : f === "llm" ? "LLM" : "OAuth"}
            </button>
          ))}
          <button className="subtab" onClick={load} title="Refresh">
            ↻
          </button>
        </div>
        <div className="config-body">
          {loaded && entries.length === 0 && (
            <div className="empty">
              No audit activity yet. LLM rows appear only for calls routed through the gateway (agents on
              your subscription bypass it); OAuth rows appear when an agent uses a connection.
            </div>
          )}
          {!loaded && <div className="empty">loading…</div>}
          {rows.map((e) => (
            <div key={e.id} className="audit-row">
              <span className={`audit-kind audit-${e.kind}`}>{e.kind}</span>
              <span className="audit-summary mono" title={e.summary}>
                {e.summary}
              </span>
              <span className={`audit-status${e.status === "ok" ? "" : " bad"}`}>{e.status}</span>
              <span className="audit-ts">{e.ts.slice(0, 19).replace("T", " ")}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
