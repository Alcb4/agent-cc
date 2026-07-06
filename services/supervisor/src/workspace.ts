// Workspace manager: owns the lifecycle map (workspace -> live tmux session),
// the git worktree isolation, fans pane output out to WebSocket subscribers, and
// fires the session-end path (broadcast + on_session_end hook).
//
// Slice 2 scope: one git worktree per workspace (create/dirty-refuse/merge/
// discard/keep + a periodic monitor). Crash recovery reattach is partial (T4).

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  ok,
  err,
  appError,
  type Result,
  type Workspace,
  type ServerMessage,
  type Project,
  type ProjectSummary,
  type ActivityState,
  type WorkspaceActivity,
  type WorkspaceStage,
  type QueueItem,
  type Schedule,
} from "@agent-cc/shared";
import type { Logger } from "pino";
import type { SupervisorConfig } from "./config.js";
import { TmuxSession } from "./tmux.js";
import { HookRegistry } from "./hooks.js";
import { WorktreeManager, type WorktreeInfo, type ScanEntry } from "./worktree.js";
import { hasOrigin, pushBranch, createPr, prState } from "./github.js";
import {
  type DB,
  insertWorkspace,
  listWorkspaces,
  getWorkspace,
  setWorkspaceStatus,
  setWorkspaceStage,
  setWorkspacePr,
  deleteWorkspace,
  insertQueueItem,
  listQueueItems,
  nextQueuePosition,
  setQueueItemStatus,
  deleteQueueItem,
  clearQueue,
  workspacesWithRunningQueueItem,
  releaseRunningQueueItems,
  insertSchedule,
  listSchedules,
  listEnabledSchedules,
  setScheduleEnabled,
  setScheduleLastRun,
  deleteSchedule,
  insertProject,
  getProject,
  deleteProject,
  countProjectWorkspaces,
  listProjectSummaries,
} from "./db.js";
import { cronMatches, validateCron, minuteKey } from "./cron.js";

const SCROLLBACK_LIMIT = 256 * 1024; // bytes of recent output retained per session
const MONITOR_INTERVAL_MS = 30_000; // worktree liveness probe cadence (T24)
const ACTIVITY_INTERVAL_MS = 1_500; // B3 idle-detection tick cadence
const SCHEDULER_INTERVAL_MS = 30_000; // N3 cron check cadence (minute granularity)

type Subscriber = (msg: ServerMessage) => void;

interface LiveSession {
  tmux: TmuxSession;
  subscribers: Set<Subscriber>;
  scrollback: string;
  // B3 watchdog state.
  lastOutputAt: number; // epoch ms of the most recent pane output
  activity: ActivityState; // last emitted active/idle state
}

export interface CreateWorkspaceInput {
  name: string;
  // Either projectId (repo derived from the project) or an explicit repoRoot.
  projectId?: string;
  repoRoot?: string;
  model?: string;
  personaId?: string;
  cwdSubpath?: string;
  command?: string;
  cols?: number;
  rows?: number;
}

export interface CreateProjectInput {
  name: string;
  repoRoot: string;
  defaultModel?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class WorkspaceManager {
  private sessions = new Map<string, LiveSession>();
  // Subscribers persist across sessions of the same workspace so the dashboard
  // keeps receiving events (e.g. worktree.dirty) even when no session is live.
  private listeners = new Map<string, Set<Subscriber>>();
  private lastDirty = new Map<string, boolean>();
  private monitorTimer: ReturnType<typeof setInterval> | null = null;
  private activityTimer: ReturnType<typeof setInterval> | null = null;
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: DB,
    private readonly cfg: SupervisorConfig,
    private readonly hooks: HookRegistry,
    private readonly log: Logger,
    private readonly worktrees: WorktreeManager = new WorktreeManager(),
  ) {}

  list(projectId?: string): Workspace[] {
    return listWorkspaces(this.db, projectId);
  }

  get(id: string): Workspace | null {
    return getWorkspace(this.db, id);
  }

  // ---- Projects ----

  listProjects(): ProjectSummary[] {
    return listProjectSummaries(this.db);
  }

  // N1 project-root picker: scan a root for candidate repos, flagging any whose
  // path is already owned by an existing project so the UI can grey them out.
  async scanProjectsRoot(root: string): Promise<Result<Array<ScanEntry & { alreadyAdded: boolean }>>> {
    const r = await this.worktrees.scanRoot(resolve(root));
    if (!r.ok) return r;
    const owned = new Set(this.listProjects().map((p) => resolve(p.repoRoot)));
    return ok(r.value.map((e) => ({ ...e, alreadyAdded: owned.has(resolve(e.path)) })));
  }

  getProject(id: string): Project | null {
    return getProject(this.db, id);
  }

  createProject(input: CreateProjectInput): Result<Project> {
    const project: Project = {
      id: randomUUID(),
      name: input.name,
      repoRoot: resolve(input.repoRoot),
      defaultModel: input.defaultModel ?? "",
      createdAt: nowIso(),
    };
    insertProject(this.db, project);
    this.log.info({ projectId: project.id, name: project.name }, "project created");
    return ok(project);
  }

  // Remove a project. With cascade, discard all its tasks first (kills sessions +
  // reclaims worktrees); without, refuse while it still has tasks.
  async removeProject(id: string, cascade = false): Promise<Result<void>> {
    if (!getProject(this.db, id)) return err(appError("workspace.not_found", "project not found"));
    if (countProjectWorkspaces(this.db, id) > 0) {
      if (!cascade) {
        return err(appError("bad_request", "project still has tasks; remove them first or confirm cascade"));
      }
      for (const w of this.list(id)) await this.discard(w.id, true);
    }
    deleteProject(this.db, id);
    this.log.info({ projectId: id, cascade }, "project removed");
    return ok(undefined);
  }

  private worktreeInfo(w: Workspace): WorktreeInfo {
    return { worktreePath: w.worktreePath, branch: w.branch, baseBranch: w.baseBranch };
  }

  private listenersFor(id: string): Set<Subscriber> {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    return set;
  }

  private emit(id: string, msg: ServerMessage): void {
    for (const sub of this.listenersFor(id)) sub(msg);
  }

  async create(input: CreateWorkspaceInput): Promise<Result<Workspace>> {
    // Resolve the repo + model: a project owns its repo, so projectId is the
    // primary path; an explicit repoRoot is still accepted (tests, ad-hoc use).
    let projectId: string | null = null;
    let repoRootRaw: string;
    let model = input.model ?? "";
    if (input.projectId) {
      const project = this.getProject(input.projectId);
      if (!project) return err(appError("workspace.not_found", "project not found"));
      projectId = project.id;
      repoRootRaw = project.repoRoot;
      if (!model) model = project.defaultModel;
    } else if (input.repoRoot) {
      repoRootRaw = input.repoRoot;
    } else {
      return err(appError("bad_request", "projectId or repoRoot is required"));
    }

    const ready = await this.worktrees.ensureRepoReady(resolve(repoRootRaw));
    if (!ready.ok) return ready;

    const id = randomUUID();
    const repoRoot = resolve(repoRootRaw);
    const wt = await this.worktrees.create(repoRoot, input.name, id, ready.value.baseBranch);
    if (!wt.ok) return wt;

    const cwd = resolve(wt.value.worktreePath, input.cwdSubpath ?? "");
    const command = input.command ?? this.cfg.defaultCommand;
    const cols = input.cols ?? 120;
    const rows = input.rows ?? 32;
    const ts = nowIso();

    const tmux = new TmuxSession(this.cfg, `agentcc-${id}`);
    const started = tmux.start({ cwd, cols, rows, command });
    if (!started.ok) {
      await this.worktrees.discard(repoRoot, wt.value); // best-effort rollback
      return started;
    }

    const workspace: Workspace = {
      id,
      projectId,
      name: input.name,
      repoRoot,
      model,
      cwdSubpath: input.cwdSubpath ?? "",
      branch: wt.value.branch,
      baseBranch: wt.value.baseBranch,
      worktreePath: wt.value.worktreePath,
      tmuxSessionName: `agentcc-${id}`,
      command,
      status: "running",
      stage: "active",
      prUrl: null,
      personaId: input.personaId ?? null,
      createdAt: ts,
      updatedAt: ts,
    };

    insertWorkspace(this.db, workspace);
    this.wire(workspace.id, tmux);
    this.log.info({ workspaceId: id, name: input.name, branch: workspace.branch }, "workspace created");
    return ok(workspace);
  }

  // Fork an existing workspace: a new worktree + branch cut from the SOURCE
  // workspace's branch tip, sharing the source's base branch (both can merge
  // into the same base independently — "try a different approach from here").
  // Only committed work carries over; uncommitted changes stay in the source
  // worktree, so forking a live session is safe and never blocks on dirty.
  // The fork inherits project, model, command, cwd, and persona, and starts
  // its own fresh session.
  async fork(sourceId: string, name?: string): Promise<Result<Workspace>> {
    const src = this.get(sourceId);
    if (!src) return err(appError("workspace.not_found", "not found"));

    const id = randomUUID();
    const forkName = name?.trim() || `${src.name} fork`;
    const wt = await this.worktrees.create(src.repoRoot, forkName, id, src.baseBranch, src.branch);
    if (!wt.ok) return wt;

    const cwd = resolve(wt.value.worktreePath, src.cwdSubpath ?? "");
    const cols = 120;
    const rows = 32;
    const ts = nowIso();

    const tmux = new TmuxSession(this.cfg, `agentcc-${id}`);
    const started = tmux.start({ cwd, cols, rows, command: src.command });
    if (!started.ok) {
      await this.worktrees.discard(src.repoRoot, wt.value); // best-effort rollback
      return started;
    }

    const workspace: Workspace = {
      id,
      projectId: src.projectId,
      name: forkName,
      repoRoot: src.repoRoot,
      model: src.model,
      cwdSubpath: src.cwdSubpath ?? "",
      branch: wt.value.branch,
      baseBranch: wt.value.baseBranch,
      worktreePath: wt.value.worktreePath,
      tmuxSessionName: `agentcc-${id}`,
      command: src.command,
      status: "running",
      stage: "active",
      prUrl: null,
      personaId: src.personaId,
      createdAt: ts,
      updatedAt: ts,
    };

    insertWorkspace(this.db, workspace);
    this.wire(workspace.id, tmux);
    this.log.info(
      { workspaceId: id, sourceId, name: forkName, branch: workspace.branch, fromRef: src.branch },
      "workspace forked",
    );
    return ok(workspace);
  }

  // Start a fresh session in an existing (ended/kept) workspace. Refuses on a
  // dirty worktree — never auto-stash. `allowDirty` is the deliberate exception
  // for conflict resolution: after a Sync-from-base conflict the worktree is
  // *meant* to be dirty (the conflict markers are the work), so we open a session
  // into it rather than refuse.
  async run(id: string, allowDirty = false): Promise<Result<void>> {
    const w = this.get(id);
    if (!w) return err(appError("workspace.not_found", "not found"));
    if (this.sessions.has(id)) return ok(undefined); // already running

    const dirty = await this.worktrees.dirtyState(w.worktreePath);
    if (!dirty.ok) return dirty;
    if (!allowDirty && dirty.value.dirty) {
      this.emit(id, { type: "worktree.dirty", workspaceId: id, fileCount: dirty.value.blocking.length });
      return err(
        appError("workspace.dirty", `worktree has ${dirty.value.blocking.length} uncommitted files`, {
          blocking: dirty.value.blocking,
        }),
      );
    }

    const cwd = resolve(w.worktreePath, w.cwdSubpath);
    const tmux = new TmuxSession(this.cfg, w.tmuxSessionName);
    const started = tmux.start({ cwd, cols: 120, rows: 32, command: w.command || "bash" });
    if (!started.ok) return started;

    setWorkspaceStatus(this.db, id, "running", nowIso());
    setWorkspaceStage(this.db, id, "active", nowIso()); // K3: re-running → back to active
    this.wire(id, tmux);
    return ok(undefined);
  }

  async merge(id: string): Promise<Result<{ merged: true }>> {
    const w = this.get(id);
    if (!w) return err(appError("workspace.not_found", "not found"));
    if (this.sessions.has(id)) {
      return err(appError("bad_request", "end the session before merging"));
    }
    const merged = await this.worktrees.merge(w.repoRoot, this.worktreeInfo(w));
    if (merged.ok) setWorkspaceStage(this.db, id, "done", nowIso()); // K3: merged → done
    return merged;
  }

  async discard(id: string, confirm: boolean): Promise<Result<void>> {
    const w = this.get(id);
    if (!w) return err(appError("workspace.not_found", "not found"));
    if (!confirm) return err(appError("bad_request", "discard requires confirm: true"));
    if (this.sessions.has(id)) this.killSession(id);

    // Best-effort worktree removal: a done/merged task's worktree is already gone,
    // and a half-set-up one may be missing — either way we still remove the row so
    // the task can always be deleted from the board.
    await this.worktrees.discard(w.repoRoot, this.worktreeInfo(w));
    deleteWorkspace(this.db, id);
    this.listeners.delete(id);
    this.lastDirty.delete(id);
    this.log.info({ workspaceId: id }, "workspace discarded");
    return ok(undefined);
  }

  // Keep: no-op beyond ensuring the session is marked ended-but-kept.
  keep(id: string): Result<void> {
    const w = this.get(id);
    if (!w) return err(appError("workspace.not_found", "not found"));
    if (w.status !== "ended") setWorkspaceStatus(this.db, id, "ended", nowIso());
    setWorkspaceStage(this.db, id, "done", nowIso()); // K3: kept (accepted as-is) → done
    return ok(undefined);
  }

  // Pull the base branch into the workspace's worktree (conflict-avoidance +
  // resolution). Clean → the branch is now current and a later Merge is conflict
  // -free. Conflict → drop a session into the worktree so the user/agent resolves
  // the markers and commits, then Merge cleanly.
  async syncFromBase(id: string): Promise<Result<{ conflict: boolean; files: string[] }>> {
    const w = this.get(id);
    if (!w) return err(appError("workspace.not_found", "not found"));
    if (this.sessions.has(id)) return err(appError("bad_request", "end the session before syncing"));

    const r = await this.worktrees.syncFromBase(w.worktreePath, w.baseBranch);
    if (!r.ok) return r;
    if (r.value.conflict) {
      // Open a session into the (now-conflicted, dirty) worktree to resolve.
      const started = await this.run(id, true);
      if (!started.ok) return started;
      this.emit(id, { type: "worktree.dirty", workspaceId: id, fileCount: r.value.files.length });
    }
    return r;
  }

  // Phase 2: does this workspace's repo have a remote (so a PR flow applies)?
  async integration(id: string): Promise<Result<{ hasRemote: boolean }>> {
    const w = this.get(id);
    if (!w) return err(appError("workspace.not_found", "not found"));
    return ok({ hasRemote: await hasOrigin(w.repoRoot) });
  }

  // Phase 2: push the workspace branch + open a GitHub PR via gh. The card stays
  // in review with prUrl set; K4 advances it to done when the PR merges.
  async openPr(id: string): Promise<Result<{ url: string }>> {
    const w = this.get(id);
    if (!w) return err(appError("workspace.not_found", "not found"));
    if (!(await hasOrigin(w.repoRoot))) {
      return err(appError("bad_request", "no origin remote — use local Merge, or add a remote"));
    }
    const pushed = await pushBranch(w.repoRoot, w.branch);
    if (!pushed.ok) return pushed;
    const pr = await createPr(w.repoRoot, w.branch, w.baseBranch, w.name, "Opened by agent-cc.");
    if (!pr.ok) return pr;
    setWorkspacePr(this.db, id, pr.value.url, nowIso());
    this.emit(id, { type: "queue.updated", workspaceId: id }); // nudge the dashboard to refresh
    this.log.info({ workspaceId: id, url: pr.value.url }, "PR opened");
    return pr;
  }

  // K3: manually move a workspace to another workflow stage (board drag/menu).
  setStage(id: string, stage: WorkspaceStage): Result<void> {
    const w = this.get(id);
    if (!w) return err(appError("workspace.not_found", "not found"));
    setWorkspaceStage(this.db, id, stage, nowIso());
    return ok(undefined);
  }

  // Crash recovery (T4): the tmux server lives on its own named socket, so
  // sessions survive a supervisor crash. On restart, match each tracked session
  // by name and re-stream it via a fresh control-mode client. Sessions that died
  // while the supervisor was down are marked ended.
  recover(): void {
    let reattached = 0;
    for (const w of this.list()) {
      if (w.status !== "running") continue;
      const tmux = new TmuxSession(this.cfg, w.tmuxSessionName);
      if (!tmux.hasSession()) {
        setWorkspaceStatus(this.db, w.id, "ended", nowIso());
        this.log.info({ workspaceId: w.id }, "tracked session gone; marked ended");
        continue;
      }
      const attached = tmux.attach(120, 32);
      if (attached.ok) {
        this.wire(w.id, tmux);
        reattached += 1;
        this.log.info({ workspaceId: w.id, session: w.tmuxSessionName }, "reattached surviving session");
      } else {
        setWorkspaceStatus(this.db, w.id, "error", nowIso());
        this.log.warn({ workspaceId: w.id, err: attached.error }, "reattach failed");
      }
    }
    if (reattached > 0) this.log.info({ reattached }, "crash recovery complete");
  }

  private wire(workspaceId: string, tmux: TmuxSession): void {
    const live: LiveSession = {
      tmux,
      subscribers: this.listenersFor(workspaceId),
      scrollback: "",
      lastOutputAt: Date.now(),
      activity: "active",
    };
    this.sessions.set(workspaceId, live);

    tmux.on("output", (data) => {
      live.scrollback = (live.scrollback + data).slice(-SCROLLBACK_LIMIT);
      live.lastOutputAt = Date.now();
      // Output resumed after being idle → emit active so the queue/scheduler and
      // the dashboard learn the agent is working again.
      if (live.activity === "idle") {
        live.activity = "active";
        this.emit(workspaceId, { type: "session.active", workspaceId });
      }
      this.emit(workspaceId, { type: "output", data });
    });

    tmux.on("exit", (reason) => {
      if (reason === "detached") return;
      void this.handleSessionEnd(workspaceId, live);
    });
  }

  private killSession(id: string): void {
    const live = this.sessions.get(id);
    if (!live) return;
    live.tmux.kill();
    this.sessions.delete(id);
  }

  private async handleSessionEnd(workspaceId: string, live: LiveSession): Promise<void> {
    setWorkspaceStatus(this.db, workspaceId, "ended", nowIso());
    // K3: an ended session is awaiting a merge/discard/keep decision → review.
    setWorkspaceStage(this.db, workspaceId, "review", nowIso());
    const exitCode = null; // exit-code capture refined in T4
    this.emit(workspaceId, { type: "session.ended", workspaceId, exitCode });
    this.log.info({ workspaceId }, "session ended");

    await this.hooks.fireSessionEnd(
      { workspaceId, exitCode, finalPaneState: live.scrollback },
      (e) => this.log.error({ err: e, workspaceId }, "on_session_end hook failed"),
    );
    this.sessions.delete(workspaceId);
  }

  subscribe(workspaceId: string, sub: Subscriber): Result<() => void> {
    const set = this.listenersFor(workspaceId);
    set.add(sub);
    // Replay last-known pane content so a fresh tab is not blank.
    const live = this.sessions.get(workspaceId);
    if (live?.scrollback) sub({ type: "output", data: live.scrollback });
    return ok(() => set.delete(sub));
  }

  sendInput(workspaceId: string, data: string): Result<void> {
    const live = this.sessions.get(workspaceId);
    if (!live) return err(appError("tmux.session_gone", "no live session"));
    return live.tmux.sendInput(data);
  }

  resize(workspaceId: string, cols: number, rows: number): Result<void> {
    const live = this.sessions.get(workspaceId);
    if (!live) return err(appError("tmux.session_gone", "no live session"));
    return live.tmux.resize(cols, rows);
  }

  inject(workspaceId: string, text: string): Result<void> {
    const live = this.sessions.get(workspaceId);
    if (!live) return err(appError("tmux.session_gone", "no live session"));
    return live.tmux.inject(text);
  }

  // T24: periodic worktree liveness probe. Emits worktree.orphaned when the
  // worktree's HEAD can't be resolved, and worktree.dirty when the dirty state
  // changes (so the dashboard can refresh its count).
  startMonitor(): void {
    if (this.monitorTimer) return;
    this.monitorTimer = setInterval(() => void this.runMonitorPass(), MONITOR_INTERVAL_MS);
    this.monitorTimer.unref?.();
  }

  async runMonitorPass(): Promise<void> {
    for (const w of this.list()) {
      // Done is terminal: a merged workspace's worktree is intentionally gone,
      // so don't probe it (that would wrongly flag it orphaned).
      if (w.stage === "done") continue;
      const probe = await this.worktrees.probe(w.worktreePath);
      if (!probe.alive) {
        this.emit(w.id, { type: "worktree.orphaned", workspaceId: w.id });
        if (w.status !== "error") setWorkspaceStatus(this.db, w.id, "error", nowIso());
        continue;
      }
      const prev = this.lastDirty.get(w.id);
      if (prev !== probe.dirty) {
        this.lastDirty.set(w.id, probe.dirty);
        if (probe.dirty) this.emit(w.id, { type: "worktree.dirty", workspaceId: w.id, fileCount: 1 });
      }

      // K4: a workspace awaiting review whose work has landed auto-advances to
      // done. Phase 2: if a PR is open, watch the PR's merge state; otherwise
      // detect a local/external branch merge into base.
      if (w.stage === "review") {
        let landed = false;
        if (w.prUrl) {
          landed = (await prState(w.repoRoot, w.prUrl)).merged;
        } else {
          landed = await this.worktrees.isMerged(w.repoRoot, w.branch, w.baseBranch);
        }
        if (landed) {
          setWorkspaceStage(this.db, w.id, "done", nowIso());
          await this.worktrees.remove(w.repoRoot, this.worktreeInfo(w)); // reclaim (best-effort)
          this.log.info({ workspaceId: w.id, pr: w.prUrl ?? null }, "work landed; stage → done");
        }
      }
    }
  }

  // ---- B3 watchdog: idle / done detection ----

  // Start the activity tick. A live session with no pane output for the idle
  // threshold transitions active → idle (the "done with current command" signal
  // the queue/scheduler build on). A tracked session whose tmux is gone — with
  // no exit event — is reaped as ended so it can't wedge the watchdog.
  startActivityMonitor(): void {
    if (this.activityTimer) return;
    this.activityTimer = setInterval(() => {
      this.runActivityPass();
      this.runQueuePass(); // advance queues using the activity state just computed
    }, ACTIVITY_INTERVAL_MS);
    this.activityTimer.unref?.();
  }

  runActivityPass(): void {
    const threshold = this.cfg.idleThresholdMs;
    const now = Date.now();
    for (const [id, live] of this.sessions) {
      // Reap a silently-dead session (control client dropped without an exit).
      if (!live.tmux.hasSession()) {
        void this.handleSessionEnd(id, live);
        continue;
      }
      if (live.activity === "active" && now - live.lastOutputAt >= threshold) {
        live.activity = "idle";
        this.emit(id, { type: "session.idle", workspaceId: id, idleMs: now - live.lastOutputAt });
      }
    }
  }

  // Current activity for one workspace (null state when no live session).
  activity(workspaceId: string): WorkspaceActivity {
    const live = this.sessions.get(workspaceId);
    if (!live) return { workspaceId, live: false, state: null, idleMs: 0 };
    return {
      workspaceId,
      live: true,
      state: live.activity,
      idleMs: Date.now() - live.lastOutputAt,
    };
  }

  // Activity for every live session — the bulk poll the dashboard grid uses and
  // the future queue/scheduler will read to decide when to advance.
  activitySnapshot(): WorkspaceActivity[] {
    const now = Date.now();
    return [...this.sessions.entries()].map(([workspaceId, live]) => ({
      workspaceId,
      live: true,
      state: live.activity,
      idleMs: now - live.lastOutputAt,
    }));
  }

  // ---- N4 command queue (per-workspace, sequential) ----

  listQueue(workspaceId: string): QueueItem[] {
    return listQueueItems(this.db, workspaceId);
  }

  // Append a command to the workspace's queue. It runs after the items ahead of
  // it, in order, once the session goes idle (the queue advances on the B3 idle
  // signal with the longer queue threshold).
  enqueue(workspaceId: string, command: string): Result<QueueItem> {
    const w = this.get(workspaceId);
    if (!w) return err(appError("workspace.not_found", "not found"));
    if (!command.trim()) return err(appError("bad_request", "command required"));
    const item: QueueItem = {
      id: randomUUID(),
      workspaceId,
      command,
      status: "pending",
      position: nextQueuePosition(this.db, workspaceId),
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
    };
    insertQueueItem(this.db, item);
    this.emit(workspaceId, { type: "queue.updated", workspaceId });
    return ok(item);
  }

  removeQueueItem(workspaceId: string, itemId: string): Result<void> {
    deleteQueueItem(this.db, itemId);
    this.emit(workspaceId, { type: "queue.updated", workspaceId });
    return ok(undefined);
  }

  clearQueue(workspaceId: string): Result<void> {
    clearQueue(this.db, workspaceId);
    this.emit(workspaceId, { type: "queue.updated", workspaceId });
    return ok(undefined);
  }

  // The queue runner, driven by the activity tick. Advances each live session's
  // queue: completes a running item once the session has been idle long enough
  // (and actually produced output, so we don't complete before the command even
  // started), then injects the next pending command.
  runQueuePass(): void {
    const now = Date.now();
    const queueIdleMs = this.cfg.queueIdleMs;

    // K2 stale-release: a running item whose session is gone returns to pending.
    for (const wsId of workspacesWithRunningQueueItem(this.db)) {
      if (!this.sessions.has(wsId)) {
        releaseRunningQueueItems(this.db, wsId);
        this.emit(wsId, { type: "queue.updated", workspaceId: wsId });
      }
    }

    for (const [wsId, live] of this.sessions) {
      const items = listQueueItems(this.db, wsId);
      if (items.length === 0) continue;
      const idleEnough = live.activity === "idle" && now - live.lastOutputAt >= queueIdleMs;

      const running = items.find((i) => i.status === "running");
      if (running) {
        const startedMs = running.startedAt ? Date.parse(running.startedAt) : now;
        const producedOutput = live.lastOutputAt > startedMs;
        // Complete when the command ran and the session went quiet, or — for a
        // command that emits no output — after a longer no-output grace period.
        const noOutputGraceMs = queueIdleMs * 2;
        const done =
          (producedOutput && idleEnough) ||
          (!producedOutput && idleEnough && now - startedMs >= noOutputGraceMs);
        if (!done) continue;
        setQueueItemStatus(this.db, running.id, "done", { finishedAt: nowIso() });
        this.emit(wsId, { type: "queue.updated", workspaceId: wsId });
        // fall through to inject the next item this same pass
      }

      // Inject the next pending command only when the session is quiescent/ready.
      if (!idleEnough) continue;
      if (items.some((i) => i.status === "running")) continue; // (shouldn't, we just completed)
      const next = listQueueItems(this.db, wsId).find((i) => i.status === "pending");
      if (!next) continue;
      const sent = live.tmux.sendInput(`${next.command}\r`);
      if (sent.ok) {
        setQueueItemStatus(this.db, next.id, "running", { startedAt: nowIso() });
        this.emit(wsId, { type: "queue.updated", workspaceId: wsId });
      }
    }
  }

  // ---- N3 cron scheduler ----

  listSchedules(workspaceId: string): Schedule[] {
    return listSchedules(this.db, workspaceId);
  }

  addSchedule(workspaceId: string, cron: string, command: string): Result<Schedule> {
    const w = this.get(workspaceId);
    if (!w) return err(appError("workspace.not_found", "not found"));
    if (!validateCron(cron)) return err(appError("bad_request", "invalid cron expression (expect 5 fields)"));
    if (!command.trim()) return err(appError("bad_request", "command required"));
    const s: Schedule = {
      id: randomUUID(),
      workspaceId,
      cron: cron.trim(),
      command,
      enabled: true,
      lastRunAt: null,
      createdAt: nowIso(),
    };
    insertSchedule(this.db, s);
    return ok(s);
  }

  setScheduleEnabled(id: string, enabled: boolean): Result<void> {
    setScheduleEnabled(this.db, id, enabled);
    return ok(undefined);
  }

  removeSchedule(id: string): Result<void> {
    deleteSchedule(this.db, id);
    return ok(undefined);
  }

  startScheduler(): void {
    if (this.schedulerTimer) return;
    this.schedulerTimer = setInterval(() => void this.runSchedulerPass(), SCHEDULER_INTERVAL_MS);
    this.schedulerTimer.unref?.();
  }

  // Fire any enabled schedule whose cron matches the current minute (at most once
  // per minute). Firing enqueues the command onto the workspace's N4 queue and,
  // if no session is live, starts one so the job actually runs unattended.
  async runSchedulerPass(): Promise<void> {
    const now = new Date();
    const key = minuteKey(now);
    for (const s of listEnabledSchedules(this.db)) {
      if (!cronMatches(s.cron, now)) continue;
      if (s.lastRunAt && minuteKey(new Date(s.lastRunAt)) === key) continue; // already fired this minute
      const w = this.get(s.workspaceId);
      if (!w) {
        deleteSchedule(this.db, s.id); // workspace gone — drop the orphan schedule
        continue;
      }
      setScheduleLastRun(this.db, s.id, now.toISOString());
      // Ensure a session exists so the queue can advance (best-effort; refuses on
      // a dirty worktree, in which case the item still queues for later).
      if (!this.sessions.has(s.workspaceId)) {
        await this.run(s.workspaceId).catch(() => undefined);
      }
      this.enqueue(s.workspaceId, s.command);
      this.log.info({ workspaceId: s.workspaceId, cron: s.cron }, "schedule fired → enqueued");
    }
  }

  shutdown(): void {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    if (this.activityTimer) clearInterval(this.activityTimer);
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    for (const live of this.sessions.values()) live.tmux.detach();
    this.sessions.clear();
  }
}
