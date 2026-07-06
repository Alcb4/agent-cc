// Quick CTA buttons (N5). Each CTA types `command` into the focused pane and
// submits it (the sender appends "\r"). The default set bakes in the user's
// session-wrap / session-start skills; the list is customisable and persisted
// to localStorage so it survives reloads without a backend round-trip.

export interface Cta {
  id: string;
  label: string;
  command: string; // sent verbatim, then submitted with a trailing CR
}

export const DEFAULT_CTAS: Cta[] = [
  { id: "wrap", label: "Wrap", command: "/session-wrap" },
  { id: "continue", label: "Continue", command: "/session-start" },
  { id: "clear", label: "Clear", command: "/clear" },
];

const KEY = "agent-cc.ctas";

export function loadCtas(): Cta[] {
  if (typeof window === "undefined") return DEFAULT_CTAS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_CTAS;
    const parsed = JSON.parse(raw) as Cta[];
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_CTAS;
    return parsed.filter((c) => c && typeof c.command === "string" && typeof c.label === "string");
  } catch {
    return DEFAULT_CTAS;
  }
}

export function saveCtas(ctas: Cta[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(ctas));
  } catch {
    /* ignore quota / private-mode errors — CTAs fall back to defaults */
  }
}
