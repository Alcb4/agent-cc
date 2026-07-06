// tmux control-mode client. Owns one detached tmux session and one long-lived
// control-mode (-CC) client that streams pane output and accepts commands.
//
// Protocol notes proven in the Slice 0 spike (docs/plans/slice-0-findings.md):
//  - control mode emits lines beginning with '%'
//  - %output %<pane> <data> carries pane bytes; non-printables are octal-escaped
//    as \ooo and backslash is doubled
//  - %begin/%end/%error wrap command responses (ignored for streaming)
//  - %exit signals the client/server is going away
//  - input is sent with `send-keys -H <hex...>` so every byte (including control
//    characters) round-trips uniformly
//  - context injection uses `load-buffer` + `paste-buffer -p -r` (the -r flag is
//    mandatory or tmux turns every LF into CR)

import { spawn as ptySpawn, type IPty } from "node-pty";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, err, type Result, appError } from "@agent-cc/shared";
import type { SupervisorConfig } from "./config.js";

export interface TmuxStartOptions {
  cwd: string;
  cols: number;
  rows: number;
  command: string; // shell or agent command to run in the session
}

export interface TmuxSessionEvents {
  output: (data: string) => void;
  exit: (reason: string) => void;
}

export declare interface TmuxSession {
  on<E extends keyof TmuxSessionEvents>(event: E, listener: TmuxSessionEvents[E]): this;
  emit<E extends keyof TmuxSessionEvents>(
    event: E,
    ...args: Parameters<TmuxSessionEvents[E]>
  ): boolean;
}

export class TmuxSession extends EventEmitter {
  private control: IPty | null = null;
  private exited = false;
  private parseBuf = "";

  constructor(
    private readonly cfg: SupervisorConfig,
    readonly name: string,
  ) {
    super();
  }

  private base(): string[] {
    return ["-L", this.cfg.tmuxSocket];
  }

  // Run a one-shot tmux command against the server (not through control mode).
  private exec(args: string[]): Result<string> {
    const r = spawnSync(this.cfg.tmuxBin, [...this.base(), ...args], {
      encoding: "utf8",
    });
    if (r.error) return err(appError("tmux.spawn_failed", r.error.message));
    if (r.status !== 0) {
      return err(appError("tmux.spawn_failed", (r.stderr || "tmux failed").trim()));
    }
    return ok(r.stdout);
  }

  hasSession(): boolean {
    const r = spawnSync(this.cfg.tmuxBin, [...this.base(), "has-session", "-t", this.name]);
    return r.status === 0;
  }

  // Create the detached session and attach a control-mode client to stream it.
  start(opts: TmuxStartOptions): Result<void> {
    const created = this.exec([
      "new-session",
      "-d",
      "-s",
      this.name,
      "-x",
      String(opts.cols),
      "-y",
      String(opts.rows),
      "-c",
      opts.cwd,
      opts.command,
    ]);
    if (!created.ok) return created;

    return this.attach(opts.cols, opts.rows);
  }

  // Attach a control-mode client to an already-running session (also used by
  // crash recovery to re-stream a surviving session).
  attach(cols: number, rows: number): Result<void> {
    if (!this.hasSession()) {
      return err(appError("tmux.session_gone", `session ${this.name} not found`));
    }
    try {
      this.control = ptySpawn(
        this.cfg.tmuxBin,
        [...this.base(), "-CC", "attach-session", "-t", this.name],
        { name: "xterm-256color", cols, rows, env: process.env as Record<string, string> },
      );
    } catch (e) {
      return err(appError("tmux.spawn_failed", (e as Error).message));
    }

    this.control.onData((chunk) => this.onControlData(chunk));
    this.control.onExit(() => {
      if (this.exited) return;
      // Control client died. Distinguish session-end from a transient detach.
      const reason = this.hasSession() ? "detached" : "session-ended";
      this.exited = true;
      this.emit("exit", reason);
    });
    return ok(undefined);
  }

  private onControlData(chunk: string): void {
    this.parseBuf += chunk;
    let idx: number;
    while ((idx = this.parseBuf.indexOf("\n")) >= 0) {
      let line = this.parseBuf.slice(0, idx);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.parseBuf = this.parseBuf.slice(idx + 1);
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    if (line.startsWith("%output ")) {
      // %output %<pane-id> <data...>
      const rest = line.slice("%output ".length);
      const sp = rest.indexOf(" ");
      const data = sp >= 0 ? rest.slice(sp + 1) : "";
      this.emit("output", unescapeControlOutput(data));
      return;
    }
    if (line.startsWith("%exit")) {
      if (this.exited) return;
      this.exited = true;
      this.emit("exit", line.slice("%exit".length).trim() || "exit");
      return;
    }
    // %begin/%end/%error and other notifications are not needed for streaming.
  }

  // Send raw bytes to the session's active pane. Hex encoding (-H) makes every
  // byte, including control characters, round-trip without escaping ambiguity.
  sendInput(data: string): Result<void> {
    if (!this.control || this.exited) {
      return err(appError("tmux.session_gone", "no live control client"));
    }
    const bytes = Buffer.from(data, "utf8");
    if (bytes.length === 0) return ok(undefined);
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
    this.control.write(`send-keys -t ${this.name} -H ${hex.join(" ")}\n`);
    return ok(undefined);
  }

  resize(cols: number, rows: number): Result<void> {
    if (!this.control || this.exited) {
      return err(appError("tmux.session_gone", "no live control client"));
    }
    this.control.write(`refresh-client -C ${cols}x${rows}\n`);
    this.control.resize(cols, rows);
    return ok(undefined);
  }

  // Inject a context pack via bracketed paste. Independent of the control client;
  // operates on the server by socket (matches the Slice 0 spike exactly).
  inject(text: string): Result<void> {
    const dir = mkdtempSync(join(tmpdir(), "agent-cc-inject-"));
    const file = join(dir, "pack.txt");
    try {
      writeFileSync(file, text);
      const buf = `inject-${this.name}`;
      const load = this.exec(["load-buffer", "-b", buf, file]);
      if (!load.ok) return load;
      // -p: bracketed paste (only wraps if the agent enabled it); -r: keep LF.
      const paste = this.exec(["paste-buffer", "-p", "-r", "-b", buf, "-t", this.name]);
      if (!paste.ok) return paste;
      return ok(undefined);
    } catch (e) {
      return err(appError("tmux.spawn_failed", (e as Error).message));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  kill(): void {
    this.exited = true;
    this.exec(["kill-session", "-t", this.name]);
    this.control?.kill();
    this.control = null;
  }

  // Detach the streaming client without ending the session (session survives).
  detach(): void {
    this.control?.kill();
    this.control = null;
  }
}

// Reverse tmux's %output escaping: \\ -> \, and \ooo (octal) -> byte.
export function unescapeControlOutput(s: string): string {
  if (!s.includes("\\")) return s;
  // tmux control mode octal-escapes control bytes + backslash but passes
  // printable UTF-8 through RAW, so by the time node-pty has decoded the stream,
  // literal runs contain real multi-byte characters. Re-encode those runs as
  // UTF-8 (NOT per-code-unit, which would truncate to the low byte and mangle
  // every glyph), and splice the octal-escaped raw bytes back in between.
  const chunks: Buffer[] = [];
  let run = "";
  const flush = (): void => {
    if (run) {
      chunks.push(Buffer.from(run, "utf8"));
      run = "";
    }
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c !== "\\") {
      run += c;
      continue;
    }
    flush();
    const next = s[i + 1];
    if (next === "\\") {
      chunks.push(Buffer.from([0x5c]));
      i += 1;
    } else if (next !== undefined && next >= "0" && next <= "7") {
      const oct = s.slice(i + 1, i + 4);
      chunks.push(Buffer.from([parseInt(oct, 8) & 0xff]));
      i += oct.length;
    } else {
      chunks.push(Buffer.from([0x5c]));
    }
  }
  flush();
  return Buffer.concat(chunks).toString("utf8");
}
