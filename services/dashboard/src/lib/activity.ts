// Display label for the activity badge. The wire state "idle" collides with
// the grey "idle" status token (DESIGN.md); the badge is amber because an
// idle-while-running agent is waiting on the user — say that instead.
export function activityLabel(state: string): string {
  return state === "idle" ? "waiting" : state;
}
