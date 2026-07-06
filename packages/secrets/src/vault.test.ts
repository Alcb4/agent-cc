import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sodium from "sodium-native";
import { openVault, SecretsVault, resolveMasterKey } from "./index.js";

function freshKey(): Buffer {
  const k = Buffer.alloc(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
  sodium.crypto_aead_xchacha20poly1305_ietf_keygen(k);
  return k;
}

describe("SecretsVault", () => {
  let dir: string;
  let vault: SecretsVault;
  let key: Buffer;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-cc-vault-"));
    key = freshKey();
    vault = openVault(join(dir, "secrets.db"), key);
  });

  afterEach(() => {
    vault.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("round-trips a secret", () => {
    vault.set("gateway", "anthropic_api_key", "sk-ant-xxxx");
    expect(vault.get("gateway", "anthropic_api_key")).toBe("sk-ant-xxxx");
  });

  test("returns null for a missing key", () => {
    expect(vault.get("gateway", "nope")).toBeNull();
  });

  test("overwrites on set and lists keys per namespace", () => {
    vault.set("oauth", "github", "token-1");
    vault.set("oauth", "github", "token-2");
    vault.set("oauth", "slack", "token-3");
    expect(vault.get("oauth", "github")).toBe("token-2");
    expect(vault.listKeys("oauth")).toEqual(["github", "slack"]);
    expect(vault.listKeys("gateway")).toEqual([]);
  });

  test("delete removes a secret", () => {
    vault.set("gateway", "k", "v");
    vault.delete("gateway", "k");
    expect(vault.get("gateway", "k")).toBeNull();
  });

  test("persists across reopen with the same key", () => {
    vault.set("gateway", "k", "persisted");
    vault.close();
    const reopened = openVault(join(dir, "secrets.db"), key);
    expect(reopened.get("gateway", "k")).toBe("persisted");
    reopened.close();
  });

  test("a wrong key cannot decrypt (authentication fails)", () => {
    vault.set("gateway", "k", "secret");
    vault.close();
    const wrong = openVault(join(dir, "secrets.db"), freshKey());
    expect(() => wrong.get("gateway", "k")).toThrow();
    wrong.close();
  });
});

describe("resolveMasterKey (file fallback)", () => {
  test("creates a stable 0600 key file and returns the same key on reload", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-cc-key-"));
    const path = join(dir, "master.key");
    const a = resolveMasterKey(path, { forceFile: true });
    const b = resolveMasterKey(path, { forceFile: true });
    expect(a.provider).toBe("file");
    expect(a.key.equals(b.key)).toBe(true);
    expect(a.key.length).toBe(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
    rmSync(dir, { recursive: true, force: true });
  });
});
