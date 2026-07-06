// Guardrail vocabulary for agent takeover / context injection. Combines two
// models from the repos we surveyed:
//   - no-mistakes' three-way finding-action taxonomy (auto-fix / ask-user /
//     no-op) plus its standing-consent (`--yes`) model, and
//   - firstmate's hard carve-out: even under standing consent, anything
//     destructive / irreversible / security-sensitive still escalates.
// This gives the supervisor one shared answer to "may the agent act here, or
// must the human decide?" — used when an agent proposes an action the human
// has not directly approved.

export type FindingSeverity = "info" | "low" | "medium" | "high" | "critical";

// What kind of decision the finding represents.
//   auto-fix  — mechanical; the agent may resolve it on its own judgment.
//   ask-user  — challenges the user's deliberate intent or changes product
//               behavior; must stop and be relayed to the human verbatim.
//   no-op     — informational; nothing to resolve.
export type FindingAction = "auto-fix" | "ask-user" | "no-op";

export interface Finding {
  id: string;
  action: FindingAction;
  severity: FindingSeverity;
  description: string;
  file?: string;
  line?: number;
  // Hard carve-outs. When either is true the finding ALWAYS escalates, even
  // with standing consent — a session cannot pre-authorise data loss or a
  // security-sensitive change.
  irreversible?: boolean; // deletes/overwrites unrecoverable state, force-push, etc.
  securitySensitive?: boolean; // touches secrets, auth, permissions, exfiltration
}

// Standing consent a session may carry — the `--yes` equivalent. Absent it, the
// default is to stop on every ask-user finding and relay it to the human.
export interface Consent {
  // The human granted this session leave to resolve ordinary ask-user findings
  // unattended (firstmate's `+yolo`).
  standing: boolean;
}

export type FindingDisposition =
  | "auto-resolve" // agent proceeds without asking
  | "escalate" // stop and relay to the human, verbatim
  | "ignore"; // no-op, nothing to do

const DEFAULT_CONSENT: Consent = { standing: false };

/**
 * Decide what to do with a finding given the session's consent. The hard
 * carve-out wins over standing consent: irreversible or security-sensitive
 * findings always escalate.
 */
export function disposition(
  finding: Finding,
  consent: Consent = DEFAULT_CONSENT,
): FindingDisposition {
  switch (finding.action) {
    case "no-op":
      return "ignore";
    case "auto-fix":
      // Still refuse to silently auto-resolve destructive/security work.
      if (finding.irreversible || finding.securitySensitive) return "escalate";
      return "auto-resolve";
    case "ask-user":
      if (finding.irreversible || finding.securitySensitive) return "escalate";
      return consent.standing ? "auto-resolve" : "escalate";
  }
}

/** True when the agent must stop and hand this finding to the human. */
export function mustEscalate(finding: Finding, consent: Consent = DEFAULT_CONSENT): boolean {
  return disposition(finding, consent) === "escalate";
}
