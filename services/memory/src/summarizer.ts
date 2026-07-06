// Model-generated run summaries via the local `claude` CLI in headless -p mode.
// Rides the user's existing Claude Code OAuth login, so no provider key and no
// gateway round-trip. Strictly best-effort: writeRun stores the heuristic
// summary synchronously and this module upgrades it in the background — any
// failure (CLI missing, not logged in, timeout, empty output) leaves the
// heuristic in place.

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { redactSecrets, sanitizeForLlm } from "@agent-cc/shared";

// Tail-truncate the pane text: the end of a session (test results, errors,
// final agent message) carries the signal; early scrollback rarely does.
const MAX_INPUT_CHARS = 8_000;
const MAX_SUMMARY_CHARS = 1_200;
const TIMEOUT_MS = 90_000;

export type CliRunner = (prompt: string) => Promise<string>;

export function modelSummariesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENT_CC_MODEL_SUMMARIES !== "0";
}

export function buildPrompt(cleanOutput: string, exitCode: number | null): string {
  const tail =
    cleanOutput.length > MAX_INPUT_CHARS ? cleanOutput.slice(-MAX_INPUT_CHARS) : cleanOutput;
  return [
    "You are summarizing the final terminal output of a finished coding-agent session",
    "for a run log that future sessions read as context.",
    `The session exited with code ${exitCode ?? "unknown"}.`,
    "Write a summary of at most 5 short lines: what was worked on, what the outcome",
    "was (done / failed / partial), and anything a follow-up session must know.",
    "Output ONLY the summary lines — no preamble, no markdown headings.",
    "",
    "Terminal output (may be truncated to the tail):",
    "---",
    // The pane text is already redacted at ingestion; sanitize injection
    // markers too since this crosses into a model.
    sanitizeForLlm(tail),
    "---",
  ].join("\n");
}

// Default runner: `claude -p` reading the prompt on stdin. Runs from tmpdir so
// no project CLAUDE.md or settings leak into the summarization context.
export const cliRunner: CliRunner = (prompt) =>
  new Promise((resolvePromise, reject) => {
    const model = process.env.AGENT_CC_SUMMARY_MODEL || "haiku";
    const child = spawn("claude", ["-p", "--model", model], {
      cwd: tmpdir(),
      stdio: ["pipe", "pipe", "pipe"],
      timeout: TIMEOUT_MS,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(out);
      else reject(new Error(`claude -p exited ${code}: ${err.slice(0, 200)}`));
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });

// Returns the upgraded summary text, or null when the model path should not
// replace the heuristic (disabled, failed, or produced nothing usable).
export async function modelSummarize(
  cleanOutput: string,
  exitCode: number | null,
  runner: CliRunner = cliRunner,
): Promise<string | null> {
  if (!modelSummariesEnabled()) return null;
  let raw: string;
  try {
    raw = await runner(buildPrompt(cleanOutput, exitCode));
  } catch {
    return null;
  }
  // Redact again on the way out: the model can echo pane content verbatim, and
  // the summary is stored + re-injected into future sessions.
  const text = redactSecrets(raw).trim().slice(0, MAX_SUMMARY_CHARS).trim();
  if (!text) return null;
  return `Run ended (exit ${exitCode ?? "unknown"}).\n${text}`;
}
