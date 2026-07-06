import { describe, expect, test } from "vitest";
import { disposition, mustEscalate, type Finding } from "./findings.js";

function finding(overrides: Partial<Finding>): Finding {
  return {
    id: "f1",
    action: "ask-user",
    severity: "medium",
    description: "test",
    ...overrides,
  };
}

describe("disposition", () => {
  test("no-op is always ignored", () => {
    expect(disposition(finding({ action: "no-op" }))).toBe("ignore");
  });

  test("auto-fix resolves without asking", () => {
    expect(disposition(finding({ action: "auto-fix" }))).toBe("auto-resolve");
  });

  test("ask-user escalates by default, auto-resolves under standing consent", () => {
    expect(disposition(finding({ action: "ask-user" }))).toBe("escalate");
    expect(disposition(finding({ action: "ask-user" }), { standing: true })).toBe("auto-resolve");
  });

  test("irreversible always escalates, even with standing consent", () => {
    const f = finding({ action: "ask-user", irreversible: true });
    expect(disposition(f, { standing: true })).toBe("escalate");
    // even an otherwise-mechanical auto-fix can't silently do irreversible work
    expect(disposition(finding({ action: "auto-fix", irreversible: true }), { standing: true })).toBe(
      "escalate",
    );
  });

  test("security-sensitive always escalates, even with standing consent", () => {
    const f = finding({ action: "auto-fix", securitySensitive: true });
    expect(disposition(f, { standing: true })).toBe("escalate");
  });
});

describe("mustEscalate", () => {
  test("is the escalate predicate", () => {
    expect(mustEscalate(finding({ action: "ask-user" }))).toBe(true);
    expect(mustEscalate(finding({ action: "auto-fix" }))).toBe(false);
  });
});
