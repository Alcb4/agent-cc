import { describe, expect, test } from "vitest";
import {
  redactSecrets,
  redactUrlCredentials,
  stripAdversarial,
  sanitizeForLlm,
  stripControlSequences,
} from "./redaction.js";

describe("stripControlSequences", () => {
  test("strips SGR color codes", () => {
    expect(stripControlSequences("\x1b[2mResume this session\x1b[22m")).toBe(
      "Resume this session",
    );
  });

  test("strips cursor movement and private-mode sequences from a tmux capture", () => {
    const raw = "\x1b[7C\x1b[45A\x1b[?25h\x1b[?2026l\x1b[?1006l\x1b[?1003lRun ended";
    expect(stripControlSequences(raw)).toBe("Run ended");
  });

  test("strips CSI sequences with <=> private parameter markers", () => {
    // xterm modifyOtherKeys reset and kitty keyboard-protocol pop
    expect(stripControlSequences("\x1b[>4m\x1b[<uResume")).toBe("Resume");
  });

  test("strips OSC titles and lone escapes, keeps tabs and newlines", () => {
    expect(stripControlSequences("\x1b]0;title\x07a\tb\nc\x1b(B")).toBe("a\tb\nc");
  });

  test("removes stray control chars; carriage returns become newlines", () => {
    expect(stripControlSequences("line1\r\nline2\x08\x00")).toBe("line1\nline2");
    // \r must not splice overwritten lines together (would fabricate or hide
    // credential-shaped strings for the redactors)
    expect(stripControlSequences("password: ****\rDone.")).toBe("password: ****\nDone.");
  });

  test("unterminated OSC/DCS does not eat text to end of input", () => {
    // capture sliced mid-sequence: only the ESC+intro goes, content survives
    expect(stripControlSequences("before \x1bPline1\nline2 important")).toBe(
      "before line1\nline2 important",
    );
    expect(stripControlSequences("before \x1b]0;title\nreal text")).toBe(
      "before 0;title\nreal text",
    );
  });

  test("leaves plain text untouched", () => {
    expect(stripControlSequences("claude --resume 3ea92d7f")).toBe("claude --resume 3ea92d7f");
  });
});

describe("redactSecrets", () => {
  test("redacts standalone token shapes", () => {
    expect(redactSecrets("token sk-abcdefghijklmnopqrstuvwx here")).toBe(
      "token [REDACTED] here",
    );
    expect(redactSecrets("ghp_0123456789abcdefghij0")).toBe("[REDACTED]");
    expect(redactSecrets("key AKIAIOSFODNN7EXAMPLE end")).toBe("key [REDACTED] end");
    const jwt = "eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4";
    expect(redactSecrets(jwt)).toBe("[REDACTED]");
  });

  test("keeps the label but drops the value for key=value secrets", () => {
    expect(redactSecrets('api_key: "abcdef123456789"')).toBe('api_key: "[REDACTED]"');
    expect(redactSecrets("password=supersecretvalue")).toBe("password=[REDACTED]");
    expect(redactSecrets("Authorization: Bearer abcdef123456ghijkl")).toBe(
      "Authorization: [REDACTED]",
    );
  });

  test("leaves innocent text untouched", () => {
    expect(redactSecrets("the quick brown fox")).toBe("the quick brown fox");
    // short values below the length floor are not treated as secrets
    expect(redactSecrets("password=short")).toBe("password=short");
  });
});

describe("redactUrlCredentials", () => {
  test("strips userinfo but keeps the rest of the URL", () => {
    expect(redactUrlCredentials("clone https://alice:pat123@github.com/org/repo.git")).toBe(
      "clone https://redacted@github.com/org/repo.git",
    );
  });

  test("leaves credential-free URLs and plain text unchanged", () => {
    expect(redactUrlCredentials("see https://example.com/path?q=1")).toBe(
      "see https://example.com/path?q=1",
    );
    expect(redactUrlCredentials("no url here")).toBe("no url here");
  });
});

describe("stripAdversarial", () => {
  test("neuters injection delimiters", () => {
    expect(stripAdversarial("<|im_start|>")).toBe("<<|im_start|>>");
    expect(stripAdversarial("<system>ignore</system>")).toBe("<sys>ignore</sys>");
    expect(stripAdversarial("[INST] do bad [/INST]")).toBe("[inst] do bad [/inst]");
  });
});

describe("sanitizeForLlm", () => {
  test("applies url, secret, and adversarial passes together", () => {
    const input = 'push to https://u:p@host.git with api_key: "abcdef123456789" <system>x</system>';
    const out = sanitizeForLlm(input);
    expect(out).toContain("https://redacted@host.git");
    expect(out).toContain('api_key: "[REDACTED]"');
    expect(out).toContain("<sys>x</sys>");
    expect(out).not.toContain("abcdef123456789");
    expect(out).not.toContain(":p@");
  });
});
