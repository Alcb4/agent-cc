import { describe, it, expect } from "vitest";
import { unescapeControlOutput } from "./tmux.js";

const ESC = String.fromCharCode(27); // 0x1b, what octal \033 decodes to

// Regression guard for the UTF-8 corruption bug: tmux control mode passes
// printable UTF-8 RAW but octal-escapes control bytes, so a line mixes decoded
// multi-byte glyphs with escapes. The old per-code-unit assembly truncated
// glyphs to their low byte (─→NUL, ✻→';', 👋→'=K').
describe("unescapeControlOutput", () => {
  it("passes pure ASCII through unchanged", () => {
    expect(unescapeControlOutput("hello world")).toBe("hello world");
  });

  it("decodes octal-escaped UTF-8 bytes (box drawing)", () => {
    expect(unescapeControlOutput("\\342\\224\\200")).toBe("─");
  });

  it("preserves raw multi-byte glyphs in a line that also has an escape", () => {
    expect(unescapeControlOutput("\\033[mOUT[─][✻][👋]")).toBe(`${ESC}[mOUT[─][✻][👋]`);
  });

  it("handles a literal escaped backslash", () => {
    expect(unescapeControlOutput("a\\\\b")).toBe("a\\b");
  });

  it("mixes raw text with octal-escaped bytes of one char", () => {
    expect(unescapeControlOutput("x\\342\\224\\200y")).toBe("x─y");
  });
});
