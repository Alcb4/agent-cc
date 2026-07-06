// Memory harness logic: compose a ContextPack for a fresh session, and persist a
// run summary when a session ends. This is the compounding loop that makes the
// next session smarter than the last.

import { randomUUID } from "node:crypto";
import {
  type ContextPack,
  type MemoryItem,
  redactSecrets,
  redactUrlCredentials,
  sanitizeForLlm,
  stripControlSequences,
} from "@agent-cc/shared";
import {
  type DB,
  insertItem,
  insertRun,
  recentByType,
  searchItems,
} from "./db.js";

const TOP_K = 5;

function nowIso(): string {
  return new Date().toISOString();
}

export function getContext(db: DB, workspaceId: string, taskHint: string): ContextPack {
  const recentDecisions = recentByType(db, workspaceId, "decision", TOP_K);
  const gotchas = recentByType(db, workspaceId, "gotcha", TOP_K);
  const recentRuns = recentByType(db, workspaceId, "recent_run_summary", TOP_K);

  // Fold in keyword-relevant items for the task hint (deduped against the above).
  const seen = new Set([...recentDecisions, ...gotchas, ...recentRuns].map((i) => i.id));
  const relevant = searchItems(db, workspaceId, taskHint, TOP_K).filter((i) => !seen.has(i.id));

  const pack: ContextPack = {
    workspaceId,
    taskHint,
    recentDecisions,
    gotchas,
    recentRuns,
    // The rendered pack is injected verbatim into a fresh agent session, so it
    // crosses into a model. Sanitise on the way in: redact any credential that
    // slipped past ingestion (defense-in-depth) and neuter injection markers a
    // stored note might carry. Structured fields stay raw for the UI.
    rendered: sanitizeForLlm(render(taskHint, recentDecisions, gotchas, recentRuns, relevant)),
  };
  return pack;
}

function render(
  taskHint: string,
  decisions: MemoryItem[],
  gotchas: MemoryItem[],
  runs: MemoryItem[],
  relevant: MemoryItem[],
): string {
  const lines: string[] = ["# Context pack"];
  if (taskHint) lines.push(`Task: ${taskHint}`);
  const section = (title: string, items: MemoryItem[]): void => {
    if (items.length === 0) return;
    lines.push("", `## ${title}`);
    for (const i of items) lines.push(`- ${i.body}`);
  };
  section("Decisions", decisions);
  section("Gotchas", gotchas);
  section("Recent runs", runs);
  section("Relevant notes", relevant);
  return lines.join("\n") + "\n";
}

export function writeRun(
  db: DB,
  workspaceId: string,
  runOutput: string,
  exitCode: number | null,
): MemoryItem {
  // Redact credentials at the ingestion boundary so secrets never enter the
  // store (raw pane output routinely contains printed env vars, tokens, and git
  // remote URLs with embedded creds). Everything downstream — finalPaneState,
  // the summary, and any future re-injection — is derived from the clean text.
  // Escape sequences are stripped FIRST so SGR codes can't split a credential
  // and defeat the redaction patterns.
  const clean = redactUrlCredentials(redactSecrets(stripControlSequences(runOutput)));
  const summary = summarize(clean, exitCode);
  const ts = nowIso();

  insertRun(db, {
    id: randomUUID(),
    workspaceId,
    exitCode,
    finalPaneState: clean,
    summary,
    createdAt: ts,
  });

  const item: MemoryItem = {
    id: randomUUID(),
    workspaceId,
    type: "recent_run_summary",
    body: summary,
    tags: ["run"],
    createdAt: ts,
  };
  insertItem(db, item);
  return item;
}

// 5-line run summary from the final pane state. Heuristic for Slice 1: the last
// few meaningful lines plus the exit code. A model-generated summary is a later
// refinement once the gateway exists.
export function summarize(runOutput: string, exitCode: number | null): string {
  const meaningful = runOutput
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim().length > 0);
  const tail = meaningful.slice(-4);
  const head = `Run ended (exit ${exitCode ?? "unknown"}).`;
  return [head, ...tail].join("\n");
}
