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

// Terminal escape sequences: CSI (colors, cursor movement, private modes like
// [?2026l), OSC (titles, hyperlinks), DCS/SOS/PM/APC strings, and lone ESC+char.
// String terminators (BEL / ESC \) are REQUIRED: captures sliced mid-sequence
// (the supervisor caps scrollback) must not let an unterminated OSC/DCS eat
// legitimate text to end-of-input — the fallback branch strips just the
// ESC+intro and leaves the content visible instead.
const ansiSequence =
  // eslint-disable-next-line no-control-regex
  /\x1b(?:\[[0-9;:<=>?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*\x1b\\|[ -/]*[0-~])/g;
// Remaining C0 control chars except tab/newline.
// eslint-disable-next-line no-control-regex
const controlChars = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/**
 * Strip terminal escape sequences and control characters from captured pane
 * output. Raw tmux captures are full of SGR/cursor/mode sequences that render
 * as garbage anywhere outside a terminal (memory summaries, injected context).
 * Carriage returns become newlines rather than vanishing: deleting them would
 * splice overwritten lines into strings that were never contiguous on screen,
 * which both fabricates credential-shaped matches for the redactors and lets
 * real ones hide.
 */
export function stripControlSequences(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(ansiSequence, "").replace(controlChars, "");
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
