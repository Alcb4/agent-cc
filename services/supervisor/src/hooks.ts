// Internal hook registry. The supervisor fires on_session_end after a tmux
// session ends; subscribers (the memory write-run wiring) run here, in addition
// to the session.ended event broadcast over the WebSocket. Hooks must not throw;
// a failing hook is logged and does not block the others.

export interface SessionEndPayload {
  workspaceId: string;
  exitCode: number | null;
  finalPaneState: string;
}

export type SessionEndHook = (payload: SessionEndPayload) => Promise<void> | void;

export class HookRegistry {
  private onSessionEnd: SessionEndHook[] = [];

  registerSessionEnd(hook: SessionEndHook): void {
    this.onSessionEnd.push(hook);
  }

  async fireSessionEnd(
    payload: SessionEndPayload,
    onError: (e: unknown) => void,
  ): Promise<void> {
    for (const hook of this.onSessionEnd) {
      try {
        await hook(payload);
      } catch (e) {
        onError(e);
      }
    }
  }
}
