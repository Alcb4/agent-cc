// Master key provider. The locked design uses the OS keychain as the master-key
// vault. Where the keychain is unavailable (common on WSL with no Secret Service
// / D-Bus), this degrades to a 0600 key file under the data dir. The crypto is
// identical either way; only where the 32-byte master key is stored differs.

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import sodium from "sodium-native";

const KEYBYTES = sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES;
const KEYCHAIN_SERVICE = "agent-cc";
const KEYCHAIN_ACCOUNT = "master-key";

export type ProviderKind = "keychain" | "file";

export interface MasterKey {
  key: Buffer;
  provider: ProviderKind;
}

function generateKey(): Buffer {
  const k = Buffer.alloc(KEYBYTES);
  sodium.crypto_aead_xchacha20poly1305_ietf_keygen(k);
  return k;
}

interface KeychainEntry {
  get(): string | null;
  set(value: string): void;
}

// Load the optional OS-keychain binding. Returns null if it isn't installed.
// Read/write may still fail at call time if the platform has no usable backend
// (e.g. WSL with no Secret Service) — resolveMasterKey handles that by falling
// back to the file. get() returns null on any read failure; set() may throw.
function openKeychain(): KeychainEntry | null {
  try {
    const require = createRequire(import.meta.url);
    const { Entry } = require("@napi-rs/keyring") as {
      Entry: new (service: string, account: string) => {
        getPassword(): string;
        setPassword(v: string): void;
      };
    };
    const entry = new Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    return {
      get: () => {
        try {
          return entry.getPassword();
        } catch {
          return null;
        }
      },
      set: (v) => entry.setPassword(v),
    };
  } catch {
    return null;
  }
}

function fromFile(filePath: string): Buffer {
  if (existsSync(filePath)) {
    return Buffer.from(readFileSync(filePath, "utf8").trim(), "base64");
  }
  mkdirSync(dirname(filePath), { recursive: true });
  const key = generateKey();
  writeFileSync(filePath, key.toString("base64"), { mode: 0o600 });
  chmodSync(filePath, 0o600);
  return key;
}

// Resolve (or create) the 32-byte master key. Prefers the OS keychain; falls
// back to a 0600 file at keyFilePath. forceFile skips the keychain (tests).
export function resolveMasterKey(keyFilePath: string, opts?: { forceFile?: boolean }): MasterKey {
  if (!opts?.forceFile) {
    try {
      const kc = openKeychain();
      if (kc) {
        const existing = kc.get();
        if (existing) return { key: Buffer.from(existing, "base64"), provider: "keychain" };
        const key = generateKey();
        kc.set(key.toString("base64")); // throws if there is no keychain backend
        return { key, provider: "keychain" };
      }
    } catch {
      // Keychain unusable (e.g. WSL with no Secret Service) — fall back to file.
    }
  }
  return { key: fromFile(keyFilePath), provider: "file" };
}
