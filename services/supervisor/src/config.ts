// Supervisor-local configuration. Env access for service-specific knobs that
// aren't part of the shared cross-service env contract.

import { homedir } from "node:os";

export interface SupervisorConfig {
  // Dedicated tmux server socket, isolated from the user's default server.
  // A named socket also makes crash recovery (reattach by name) deterministic.
  tmuxSocket: string;
  // Path to the tmux binary.
  tmuxBin: string;
  // Root folder scanned by the N1 project-root picker. Defaults to the home dir.
  projectsRoot: string;
  // B3 watchdog: a live session with no pane output for this long is "idle"
  // (the done-with-current-command signal that the queue/scheduler build on).
  idleThresholdMs: number;
  // N4 queue: how long a session must be idle before the queue treats the
  // current command as done and advances. Deliberately longer than the watchdog
  // idle threshold so an agent pausing mid-thought doesn't advance prematurely.
  queueIdleMs: number;
  // Default agent a new workspace launches. `claude` (Claude Code) runs on the
  // user's subscription via its own login — agent-cc makes no LLM API calls.
  // To bill the API instead, set ANTHROPIC_API_KEY in the env (claude prefers it).
  defaultCommand: string;
}

export function loadSupervisorConfig(): SupervisorConfig {
  return {
    tmuxSocket: process.env.AGENT_CC_TMUX_SOCKET ?? "agent-cc",
    tmuxBin: process.env.AGENT_CC_TMUX_BIN ?? "tmux",
    projectsRoot: process.env.AGENT_CC_PROJECTS_ROOT ?? homedir(),
    idleThresholdMs: Number(process.env.AGENT_CC_IDLE_THRESHOLD_MS ?? 5000),
    queueIdleMs: Number(process.env.AGENT_CC_QUEUE_IDLE_MS ?? 12000),
    defaultCommand: process.env.AGENT_CC_DEFAULT_COMMAND ?? "claude",
  };
}
