"use client";

import { useEffect, useRef, useState } from "react";
import type { Workspace, ServerMessage } from "@agent-cc/shared";
import { SUPERVISOR_WS } from "@/lib/config";

// xterm.js pane wired to the supervisor WebSocket. Imports are loaded inside the
// effect because xterm touches window at module load (no SSR).
export function Terminal({
  workspace,
  onEnded,
  readOnly = false,
  fontSize = 13,
}: {
  workspace: Workspace;
  onEnded: () => void;
  // Read-only panes (the watch grid) stream output but never send input, and
  // never push resize — the tmux control client is shared, so a grid pane
  // resizing it would reflow the focused terminal.
  readOnly?: boolean;
  fontSize?: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [connecting, setConnecting] = useState(true);

  // Hold the latest onEnded in a ref so the connect effect does NOT depend on
  // its identity — otherwise every parent re-render (e.g. the 2s activity poll)
  // would recreate the inline callback, re-run the effect, and tear down +
  // reopen the WebSocket, which reads as the terminal flashing/refreshing.
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;

  useEffect(() => {
    setConnecting(true);
    let disposed = false;
    let cleanup = (): void => {};

    void (async () => {
      const { Terminal: XTerm } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      if (disposed || !hostRef.current) return;

      const term = new XTerm({
        fontFamily: '"JetBrains Mono", monospace',
        fontSize,
        // DESIGN.md locks the agent ANSI palette to the status tokens so
        // agent-output green matches the chrome's running-green (xterm's
        // defaults diverge, e.g. green #0dbc79).
        theme: {
          background: "#0a0a0a",
          foreground: "#ededed",
          black: "#1a1a1a",
          red: "#f87171",
          green: "#4ade80",
          yellow: "#fbbf24",
          blue: "#60a5fa",
          magenta: "#c084fc",
          cyan: "#22d3ee",
          white: "#ededed",
        },
        cursorBlink: !readOnly,
        disableStdin: readOnly,
        scrollback: readOnly ? 1000 : 5000,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostRef.current);
      fit.fit();

      const ws = new WebSocket(`${SUPERVISOR_WS}/workspaces/${workspace.id}/stream`);

      ws.onmessage = (ev: MessageEvent<string>) => {
        const msg = JSON.parse(ev.data) as ServerMessage;
        if (msg.type === "output") term.write(msg.data);
        else if (msg.type === "session.ended") {
          term.write("\r\n\x1b[90m[session ended]\x1b[0m\r\n");
          onEndedRef.current();
        } else if (msg.type === "error") {
          term.write(`\r\n\x1b[31m[${msg.code}] ${msg.message}\x1b[0m\r\n`);
        }
      };

      const sendResize = (): void => {
        fit.fit();
        // Read-only panes fit locally for display but never notify the shared
        // tmux client (see prop comment).
        if (!readOnly && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
      };
      ws.onopen = () => {
        setConnecting(false);
        sendResize();
      };

      const onData = readOnly
        ? null
        : term.onData((data) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "input", data }));
            }
          });

      const ro = new ResizeObserver(() => sendResize());
      ro.observe(hostRef.current);

      cleanup = () => {
        ro.disconnect();
        onData?.dispose();
        ws.close();
        term.dispose();
      };
    })();

    return () => {
      disposed = true;
      cleanup();
    };
    // Intentionally NOT depending on onEnded (held in a ref above) so parent
    // re-renders don't reconnect the socket. Only re-run when the pane identity
    // or render mode actually changes.
  }, [workspace.id, readOnly, fontSize]);

  return (
    <div className="term-wrap">
      {/* aria-live per DESIGN.md so screen readers announce new output */}
      <div className="term-host" ref={hostRef} aria-live="polite" />
      {connecting && (
        <div className="term-overlay">
          <span className="micro">Connecting to session…</span>
        </div>
      )}
    </div>
  );
}
