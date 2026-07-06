import type { ActivityState } from "@agent-cc/shared";

// Display label for the activity badge. The wire state "idle" collides with
// the grey "idle" status token (DESIGN.md); the badge is amber because an
// idle-while-running agent is waiting on the user — say that instead. (The
// CSS hook stays `act-idle`, keyed on the wire state, not this label.)
// WorkspaceActivity.state is nullable on the wire (null when not live);
// callers gate on `.live`, so null never renders, but the type keeps the
// compiler pointing here when ActivityState grows a new value.
export function activityLabel(state: ActivityState | null): string {
  return state === "idle" ? "waiting" : (state ?? "");
}
