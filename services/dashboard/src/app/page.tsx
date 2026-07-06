"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Workspace, ProjectSummary } from "@agent-cc/shared";
import { Terminal } from "@/components/Terminal";
import { WatchGrid } from "@/components/WatchGrid";
import { StageBoard } from "@/components/StageBoard";
import { RightPanel, type RightTab } from "@/components/RightPanel";
import { CommandPalette, type Command } from "@/components/CommandPalette";
import { HelpDrawer } from "@/components/HelpDrawer";
import { ConfigPanel, type ConfigTab } from "@/components/ConfigPanel";
import { SecurityPanel } from "@/components/SecurityPanel";
import { ProjectRootPicker } from "@/components/ProjectRootPicker";
import { ModelSelect } from "@/components/ModelSelect";
import {
  listProjects,
  createProject,
  deleteProject,
  listWorkspaces,
  createWorkspace,
  runWorkspace,
  mergeWorkspace,
  keepWorkspace,
  discardWorkspace,
  syncWorkspace,
  getIntegration,
  openPr,
  listServices,
  getUsage,
  getActivity,
  listPersonas,
  type ServiceStatus,
} from "@/lib/api";
import type { UsageSummary, WorkspaceActivity, Persona } from "@agent-cc/shared";

type Tab = "projects" | "all" | "board";

export default function Page() {
  const [tab, setTab] = useState<Tab>("projects");
  // On the All tab we default to the watch grid; focusing a pane drops into the
  // single-terminal view, and "← Watch all" returns to the grid.
  const [allFocus, setAllFocus] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [downServices, setDownServices] = useState<ServiceStatus[]>([]);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [activity, setActivity] = useState<Record<string, WorkspaceActivity>>({});
  const [hasRemote, setHasRemote] = useState(false);
  const [rightTab, setRightTab] = useState<RightTab>("memory");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [configTab, setConfigTab] = useState<ConfigTab>("providers");
  const [securityOpen, setSecurityOpen] = useState(false);

  const [pName, setPName] = useState("");
  const [pRepo, setPRepo] = useState("");
  const [pModel, setPModel] = useState("");
  // Collapsed by default: the rail's job is the project list, not the form.
  const [showNewProject, setShowNewProject] = useState(false);
  const [tName, setTName] = useState("");
  const [tCmd, setTCmd] = useState("claude"); // default agent: Claude Code (subscription)
  const [tCustom, setTCustom] = useState(false);
  const [tPersona, setTPersona] = useState(""); // bound persona for the new task ("" = none)
  const [personas, setPersonas] = useState<Persona[]>([]);
  const tNameRef = useRef<HTMLInputElement>(null);

  const loadWorkspaces = useCallback(
    async (projectId: string | null, tabNow: Tab): Promise<void> => {
      const ws = await listWorkspaces(tabNow === "projects" && projectId ? projectId : undefined);
      setWorkspaces(ws);
      setActiveId((cur) => (cur && ws.some((w) => w.id === cur) ? cur : (ws[0]?.id ?? null)));
    },
    [],
  );

  const refresh = useCallback(async () => {
    const ps = await listProjects();
    setProjects(ps);
    setSelectedProjectId((cur) => cur ?? ps[0]?.id ?? null);
  }, []);

  useEffect(() => {
    void refresh().catch(() => setToast("supervisor unreachable on :7711"));
  }, [refresh]);

  useEffect(() => {
    void loadWorkspaces(selectedProjectId, tab).catch(() => undefined);
  }, [selectedProjectId, tab, loadWorkspaces, refreshKey]);

  // dependent-service liveness for the hard-fail banner
  useEffect(() => {
    const tick = (): void => {
      void listServices()
        .then((s) => setDownServices(s.filter((x) => x.status === "down")))
        .catch(() => undefined);
    };
    tick();
    const h = setInterval(tick, 5000);
    return () => clearInterval(h);
  }, []);

  // Usage meter (last 24h) — real numbers from the gateway via the supervisor.
  useEffect(() => {
    const tick = (): void => {
      void getUsage()
        .then(setUsage)
        .catch(() => undefined);
    };
    tick();
    const h = setInterval(tick, 10_000);
    return () => clearInterval(h);
  }, []);

  // Personas for the task-create binding selector. Reload on mount and whenever
  // the config panel closes, so a persona just created in Config appears here.
  useEffect(() => {
    if (configOpen) return;
    void listPersonas()
      .then(setPersonas)
      .catch(() => undefined);
  }, [configOpen]);

  // B3 watchdog: poll per-session active/idle state for the grid + header badges.
  useEffect(() => {
    const tick = (): void => {
      void getActivity()
        .then(setActivity)
        .catch(() => undefined);
    };
    tick();
    const h = setInterval(tick, 2000);
    return () => clearInterval(h);
  }, []);

  const active = workspaces.find((w) => w.id === activeId) ?? null;
  const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? null;

  // Phase 2: learn whether the focused review workspace's repo has a remote, to
  // decide whether to offer "Open PR".
  useEffect(() => {
    if (!active || active.status !== "ended" || active.prUrl) {
      setHasRemote(false);
      return;
    }
    let live = true;
    void getIntegration(active.id)
      .then((r) => live && setHasRemote(r.hasRemote))
      .catch(() => live && setHasRemote(false));
    return () => {
      live = false;
    };
  }, [active]);

  const onCreateProject = async (): Promise<void> => {
    if (!pName || !pRepo) return;
    try {
      const p = await createProject({ name: pName, repoRoot: pRepo, defaultModel: pModel || undefined });
      setPName("");
      setPRepo("");
      setPModel("");
      setShowNewProject(false);
      await refresh();
      setTab("projects");
      setSelectedProjectId(p.id);
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e));
    }
  };

  const onDeleteProject = async (p: ProjectSummary): Promise<void> => {
    const msg =
      p.workspaceCount > 0
        ? `Delete project "${p.name}" and its ${p.workspaceCount} task(s)? This discards all their worktrees + branches.`
        : `Delete project "${p.name}"?`;
    if (!confirm(msg)) return;
    try {
      await deleteProject(p.id, p.workspaceCount > 0);
      if (selectedProjectId === p.id) setSelectedProjectId(null);
      await refresh();
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e));
    }
  };

  const onCreateTask = async (): Promise<void> => {
    if (!tName || !selectedProjectId) return;
    try {
      const ws = await createWorkspace({
        name: tName,
        projectId: selectedProjectId,
        command: tCmd.trim() || undefined,
        personaId: tPersona || undefined,
      });
      setTName("");
      await refresh();
      await loadWorkspaces(selectedProjectId, "projects");
      setActiveId(ws.id);
      setRightTab("memory");
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e));
    }
  };

  const lifecycle = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    if (!active) return;
    try {
      await fn();
      setToast(`${label} ok`);
      setRefreshKey((k) => k + 1);
      await refresh();
    } catch (e) {
      setToast(`${label} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // ---- keyboard model ----
  const moveActive = useCallback(
    (delta: number) => {
      if (workspaces.length === 0) return;
      const idx = workspaces.findIndex((w) => w.id === activeId);
      const next = Math.max(0, Math.min(workspaces.length - 1, (idx < 0 ? 0 : idx) + delta));
      setActiveId(workspaces[next]!.id);
    },
    [workspaces, activeId],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      const el = document.activeElement;
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      if (typing) return;
      if (e.key === "?") {
        setHelpOpen(true);
      } else if (e.key === "j") {
        moveActive(1);
      } else if (e.key === "k") {
        moveActive(-1);
      } else if (e.key === "Escape") {
        setPaletteOpen(false);
        setHelpOpen(false);
        setConfigOpen(false);
        setSecurityOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moveActive]);

  const commands = useMemo<Command[]>(() => {
    const cmds: Command[] = [
      { id: "view-projects", label: "View: projects", run: () => setTab("projects") },
      {
        id: "view-all",
        label: "View: watch all workspaces",
        run: () => {
          setTab("all");
          setAllFocus(false);
        },
      },
      {
        id: "new-task",
        label: "New task (in selected project)",
        run: () => {
          setTab("projects");
          requestAnimationFrame(() => tNameRef.current?.focus());
        },
      },
      {
        id: "view-board",
        label: "View: board (by stage)",
        run: () => {
          setTab("board");
          setAllFocus(false);
        },
      },
      { id: "help", label: "Keyboard help", run: () => setHelpOpen(true) },
    ];
    for (const w of workspaces) {
      cmds.push({
        id: `open-${w.id}`,
        label: `Open: ${w.name}`,
        hint: w.status,
        run: () => {
          setActiveId(w.id);
          setAllFocus(true);
        },
      });
    }
    const openConfig = (t: ConfigTab) => () => {
      setConfigTab(t);
      setConfigOpen(true);
    };
    cmds.push({ id: "go-providers", label: "Config: providers", hint: "LLM keys", run: openConfig("providers") });
    cmds.push({ id: "go-personas", label: "Config: personas", hint: "prompts", run: openConfig("personas") });
    cmds.push({ id: "go-overlays", label: "Config: overlays", hint: "per-project prompt", run: openConfig("overlays") });
    cmds.push({ id: "go-oauth", label: "Config: OAuth", hint: "connections", run: openConfig("oauth") });
    cmds.push({ id: "go-security", label: "Security: audit log", hint: "LLM + OAuth", run: () => setSecurityOpen(true) });
    return cmds;
  }, [workspaces]);

  const runningTotal = projects.reduce((n, p) => n + p.runningCount, 0);

  return (
    <div className="shell">
      <div className="topbar">
        <span className="brand">agent-cc</span>
        <span className="micro">
          {active?.model ? `model: ${active.model} · ` : ""}
          {usage ? `${fmtTokens(usage.inputTokens + usage.outputTokens)} tok · ${fmtCost(usage.costMicrocents)} 24h · ` : ""}
          {runningTotal} running · ⌘K
          {toast ? ` · ${toast}` : ""}
        </span>
      </div>

      {downServices.length > 0 && (
        <div className="banner">
          {downServices.map((s) => s.name).join(", ")} unreachable. Restart with: agent-cc start.
        </div>
      )}

      <div className="panels">
        <div className="left">
          <div className="tabs">
            <button className={tab === "projects" ? "tab active" : "tab"} onClick={() => setTab("projects")}>
              Projects
            </button>
            <button
              className={tab === "all" ? "tab active" : "tab"}
              onClick={() => {
                setTab("all");
                setAllFocus(false);
              }}
            >
              All
            </button>
            <button
              className={tab === "board" ? "tab active" : "tab"}
              onClick={() => {
                setTab("board");
                setAllFocus(false);
              }}
            >
              Board
            </button>
          </div>

          {tab === "projects" && (
            <>
              {showNewProject || projects.length === 0 ? (
                <div className="stack">
                  <span className="micro">New project</span>
                  <input placeholder="name" value={pName} onChange={(e) => setPName(e.target.value)} />
                  <ProjectRootPicker value={pRepo} onChange={setPRepo} onToast={setToast} />
                  <ModelSelect value={pModel} onChange={setPModel} allowEmpty placeholder="default model (optional)" />
                  <button className="primary" onClick={() => void onCreateProject()}>
                    + New project
                  </button>
                  {projects.length > 0 && (
                    <button onClick={() => setShowNewProject(false)}>Cancel</button>
                  )}
                </div>
              ) : (
                <div className="panel-head">
                  <span className="micro">Projects</span>
                  <button className="proj-add" onClick={() => setShowNewProject(true)}>
                    + New
                  </button>
                </div>
              )}

              {projects.map((p) => (
                <div
                  key={p.id}
                  className={`proj-row${p.id === selectedProjectId ? " active" : ""}`}
                  onClick={() => setSelectedProjectId(p.id)}
                >
                  <span className={`dot ${p.runningCount > 0 ? "running" : "idle"}`} />
                  <span className="proj-name">{p.name}</span>
                  <span className="proj-count">{p.workspaceCount}</span>
                  <button
                    className="proj-del"
                    title="Delete project"
                    onClick={(e) => {
                      e.stopPropagation();
                      void onDeleteProject(p);
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}

              {selectedProject && (
                <>
                  <div className="panel-head">
                    <span className="micro">Tasks · {selectedProject.name}</span>
                  </div>
                  {workspaces.map((w) => (
                    <WsCard key={w.id} w={w} active={w.id === activeId} onClick={() => setActiveId(w.id)} />
                  ))}
                  <div className="stack">
                    <input
                      ref={tNameRef}
                      placeholder="new task name"
                      value={tName}
                      onChange={(e) => setTName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && void onCreateTask()}
                    />
                    <select
                      value={tCustom ? "__custom__" : tCmd}
                      onChange={(e) => {
                        if (e.target.value === "__custom__") {
                          setTCustom(true);
                          setTCmd("");
                        } else {
                          setTCustom(false);
                          setTCmd(e.target.value);
                        }
                      }}
                    >
                      <option value="claude">Claude Code (subscription)</option>
                      <option value="bash">Shell</option>
                      <option value="__custom__">Custom…</option>
                    </select>
                    {tCustom && (
                      <input
                        placeholder="custom command (e.g. aider)"
                        value={tCmd}
                        onChange={(e) => setTCmd(e.target.value)}
                      />
                    )}
                    {personas.length > 0 && (
                      <select
                        value={tPersona}
                        onChange={(e) => setTPersona(e.target.value)}
                        title="Bind a persona — its composed prompt is prepended to injected context"
                      >
                        <option value="">no persona</option>
                        {personas.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.role}
                          </option>
                        ))}
                      </select>
                    )}
                    <button className="primary" onClick={() => void onCreateTask()}>
                      + New task
                    </button>
                  </div>
                </>
              )}
            </>
          )}

          {(tab === "all" || tab === "board") && (
            <>
              <div className="panel-head">
                <span className="micro">All workspaces</span>
              </div>
              {workspaces.map((w) => (
                <WsCard
                  key={w.id}
                  w={w}
                  active={w.id === activeId && allFocus}
                  onClick={() => {
                    setActiveId(w.id);
                    setAllFocus(true);
                  }}
                />
              ))}
            </>
          )}
        </div>

        <div className="centre">
          {(tab === "all" || tab === "board") && !allFocus ? (
            tab === "all" ? (
              <WatchGrid
                workspaces={workspaces}
                projects={projects}
                activity={activity}
                onFocus={(id) => {
                  setActiveId(id);
                  setAllFocus(true);
                  setRightTab("memory");
                }}
                onToast={setToast}
                onRefresh={() => {
                  setRefreshKey((k) => k + 1);
                  void refresh();
                }}
              />
            ) : (
              <StageBoard
                workspaces={workspaces}
                projects={projects}
                activity={activity}
                onFocus={(id) => {
                  setActiveId(id);
                  setAllFocus(true);
                  setRightTab("memory");
                }}
                onToast={setToast}
                onRefresh={() => {
                  setRefreshKey((k) => k + 1);
                  void refresh();
                }}
              />
            )
          ) : active ? (
            <>
              <div className="term-head">
                <span>
                  {(tab === "all" || tab === "board") && (
                    <button className="back-grid" onClick={() => setAllFocus(false)}>
                      ← {tab === "board" ? "Board" : "Watch all"}
                    </button>
                  )}
                  {active.name} · <span style={{ color: "var(--fg-2)" }}>{active.branch}</span> ·{" "}
                  <span className={`pill ${active.status}`}>{active.status}</span>
                  {activity[active.id]?.live ? (
                    <span className={`act act-${activity[active.id]!.state}`}>
                      {activity[active.id]!.state}
                    </span>
                  ) : null}
                  {active.model ? <span style={{ color: "var(--fg-2)" }}> · {active.model}</span> : null}
                  {active.personaId ? (
                    <span className="persona-tag" title="Bound persona — prompt prepended to injected context">
                      {personas.find((p) => p.id === active.personaId)?.role ?? "persona"}
                    </span>
                  ) : null}
                </span>
                <div className="term-actions">
                  {active.stage === "done" ? (
                    <span className="micro">done</span>
                  ) : active.prUrl ? (
                    <>
                      <a className="pr-link" href={active.prUrl} target="_blank" rel="noreferrer">
                        PR ↗
                      </a>
                      <span className="micro">awaiting merge</span>
                      <button onClick={() => void lifecycle("Discard", () => discardWorkspace(active.id))}>Discard</button>
                    </>
                  ) : active.status === "ended" ? (
                    <>
                      <button onClick={() => void lifecycle("Re-run", () => runWorkspace(active.id))}>Re-run</button>
                      <button onClick={() => void lifecycle("Merge", () => mergeWorkspace(active.id))}>Merge</button>
                      <button onClick={() => void lifecycle("Sync", () => syncWorkspace(active.id))}>Sync</button>
                      {hasRemote && (
                        <button onClick={() => void lifecycle("Open PR", () => openPr(active.id))}>Open PR</button>
                      )}
                      <button onClick={() => void lifecycle("Keep", () => keepWorkspace(active.id))}>Keep</button>
                      <button onClick={() => void lifecycle("Discard", () => discardWorkspace(active.id))}>Discard</button>
                    </>
                  ) : (
                    <button onClick={() => setRightTab("inject")}>↑ Inject context</button>
                  )}
                </div>
              </div>
              {active.status === "ended" && (
                <div className="term-note">
                  <span className="micro">
                    Session ended — pane is read-only. Run summary is in Memory / Runs →
                  </span>
                </div>
              )}
              <Terminal
                key={active.id}
                workspace={active}
                readOnly={active.status === "ended"}
                onEnded={() => {
                  setRightTab("runs");
                  setRefreshKey((k) => k + 1);
                  void refresh();
                }}
              />
            </>
          ) : (
            <div className="empty">
              {projects.length === 0
                ? "Create a project (name + a git repo path) to begin. Press ⌘K anytime."
                : "Select a project and create a task. Press ⌘K for commands."}
            </div>
          )}
        </div>

        <div className="right">
          {(tab === "all" || tab === "board") && !allFocus ? (
            <>
              <div className="panel-head">
                <span className="micro">{tab === "board" ? "Board" : "Watch"}</span>
              </div>
              <div className="empty">
                {tab === "board"
                  ? "Workspaces grouped by workflow stage. Review cards await your merge/keep/discard. Focus one to see its memory."
                  : "Live read-only panes for every workspace. Focus one to act on it and see its memory."}
              </div>
            </>
          ) : active ? (
            <RightPanel
              workspaceId={active.id}
              tab={rightTab}
              onTab={setRightTab}
              refreshKey={refreshKey}
              onToast={setToast}
            />
          ) : (
            <>
              <div className="panel-head">
                <span className="micro">Memory + decisions</span>
              </div>
              <div className="empty">Once you have a task, its memory will appear here.</div>
            </>
          )}
        </div>
      </div>

      <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />
      <HelpDrawer open={helpOpen} onClose={() => setHelpOpen(false)} />
      <ConfigPanel
        open={configOpen}
        tab={configTab}
        onTab={setConfigTab}
        onClose={() => setConfigOpen(false)}
        onToast={setToast}
      />
      <SecurityPanel open={securityOpen} onClose={() => setSecurityOpen(false)} />
    </div>
  );
}

// Display-only formatting (not money math): microcents -> dollars, 100_000_000 = $1.
function fmtCost(microcents: number): string {
  return `$${(microcents / 100_000_000).toFixed(2)}`;
}
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function WsCard({ w, active, onClick }: { w: Workspace; active: boolean; onClick: () => void }) {
  return (
    <div className={`ws-card${active ? " active" : ""}`} onClick={onClick}>
      <div className="ws-row">
        <span className={`pill ${w.status}`}>{w.status}</span>
        <span>{w.name}</span>
      </div>
      <div className="ws-branch">{w.branch}</div>
    </div>
  );
}
