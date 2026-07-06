"use client";

import { useCallback, useEffect, useState } from "react";
import { scanProjects, type ScanEntry } from "@/lib/api";

// N1: pick a repo from a scanned root folder instead of typing an absolute path
// (which invited typos and bad-path errors). Non-repos / repos with no commits
// are shown disabled with the reason; dirty repos are selectable with a note.
// A manual-path escape hatch remains for anything outside the scanned root.
export function ProjectRootPicker({
  value,
  onChange,
  onToast,
}: {
  value: string;
  onChange: (path: string) => void;
  onToast: (m: string) => void;
}) {
  const [root, setRoot] = useState("");
  const [rootInput, setRootInput] = useState("");
  const [entries, setEntries] = useState<ScanEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [manual, setManual] = useState(false);

  const scan = useCallback(
    async (r?: string) => {
      setLoading(true);
      try {
        const res = await scanProjects(r);
        setRoot(res.root);
        setRootInput(res.root);
        setEntries(res.entries);
      } catch (e) {
        onToast(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [onToast],
  );

  useEffect(() => {
    if (!manual) void scan();
  }, [manual, scan]);

  if (manual) {
    return (
      <span className="model-select">
        <input placeholder="repo root (abs path)" value={value} onChange={(e) => onChange(e.target.value)} />
        <button type="button" onClick={() => setManual(false)}>
          ↩ browse
        </button>
      </span>
    );
  }

  return (
    <div className="repo-picker">
      <div className="repo-rootbar">
        <input
          value={rootInput}
          onChange={(e) => setRootInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void scan(rootInput)}
          placeholder="scan folder"
        />
        <button type="button" onClick={() => void scan(rootInput)}>
          {loading ? "…" : "Scan"}
        </button>
        <button type="button" onClick={() => setManual(true)} title="Type a path manually">
          path
        </button>
      </div>
      <div className="repo-list">
        {entries.length === 0 && !loading && <div className="micro repo-empty">No subfolders in {root}</div>}
        {entries.map((e) => {
          const usable = e.isRepo && e.hasCommits;
          const reason = !e.isRepo ? "not a git repo" : !e.hasCommits ? "no commits" : e.dirty ? "dirty" : "";
          return (
            <button
              type="button"
              key={e.path}
              className={`repo-item${value === e.path ? " sel" : ""}${usable ? "" : " disabled"}`}
              disabled={!usable || e.alreadyAdded}
              onClick={() => onChange(e.path)}
              title={e.path}
            >
              <span className="repo-name">{e.name}</span>
              <span className="repo-tag">{e.alreadyAdded ? "added" : reason}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
