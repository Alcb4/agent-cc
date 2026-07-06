// Redaction at the LLM boundary. Adopted from no-mistakes (internal/intent/
// redact.go + internal/safeurl). We inject curated context into fresh agent
// sessions and proxy prompts through the gateway; credentials must never reach
// a model (see the global "never output secrets unredacted" rule). Matching is
// intentionally loose — we would rather redact a few innocent strings than leak
// one real key. Apply on the way INTO the model and on the way OUT.

const REDACTED = "[REDACTED]";

// Standalone credential shapes. Each replaces the whole match with [REDACTED].
const tokenPatterns: readonly RegExp[] = [
  /sk-[A-Za-z0-9]{20,}/g, // OpenAI-style
  /ghp_[A-Za-z0-9]{20,}/g, // GitHub personal access token
  /gho_[A-Za-z0-9]{20,}/g, // GitHub OAuth token
  /xox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, // JWT
  /\b[Bb]earer\s+[A-Za-z0-9_\-./+=]{12,}/g, // "Bearer <token>" (space-separated; the label pattern below only catches `:`/`=` forms)
];

// key=value / key: "value" shapes. Keeps the label so the model still sees that
// (e.g.) an api_key was present, but drops the value.
const labelledSecret =
  /(api[_-]?key|access[_-]?token|secret[_-]?(?:key|token)?|password|passwd|bearer|authorization)(\s*[:=]\s*['"]?)([A-Za-z0-9_\-./+=]{12,})/gi;

// https://user:pass@host — strip the userinfo, keep the rest of the URL.
const httpUrl = /https?:\/\/[^\s'"<>]+/g;

/**
 * Replace likely credentials in free text with [REDACTED].
 */
export function redactSecrets(text: string): string {
  let out = text.replace(labelledSecret, (_m, label, sep) => `${label}${sep}${REDACTED}`);
  for (const pat of tokenPatterns) {
    out = out.replace(pat, REDACTED);
  }
  return out;
}

/**
 * Strip userinfo (user:pass@) from any http(s) URLs in the text, leaving
 * credential-free URLs and non-URL text unchanged.
 */
export function redactUrlCredentials(text: string): string {
  return text.replace(httpUrl, (raw) => {
    try {
      const u = new URL(raw);
      if (!u.username && !u.password) return raw;
      u.username = "redacted";
      u.password = "";
      return u.toString();
    } catch {
      return raw;
    }
  });
}

/**
 * Neuter common prompt-injection delimiters so text lifted from a transcript or
 * a tool result cannot escape the surrounding instructions. This is a stop-gap,
 * not a real defense — the real defense is framing the text explicitly as data,
 * not instructions.
 */
export function stripAdversarial(text: string): string {
  return text
    .replaceAll("<|", "<<|")
    .replaceAll("|>", "|>>")
    .replaceAll("<system>", "<sys>")
    .replaceAll("</system>", "</sys>")
    .replaceAll("[INST]", "[inst]")
    .replaceAll("[/INST]", "[/inst]");
}

/**
 * Full sanitisation for text crossing into a model: redact URL credentials and
 * secrets, then neuter injection delimiters. Use this at prompt-construction
 * boundaries (context injection, gateway) unless you need a single pass only.
 */
export function sanitizeForLlm(text: string): string {
  return stripAdversarial(redactSecrets(redactUrlCredentials(text)));
}
