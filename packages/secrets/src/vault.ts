// Encrypted secrets store. Field-level encryption with XChaCha20-Poly1305: each
// value gets a fresh random nonce; nonce + ciphertext (with auth tag) are stored
// in secrets.db. The DB file alone is useless without the master key.
//
// Namespaces keep services' secrets apart (e.g. "gateway", "oauth"). Argon2id
// passphrase-unlock is deferred; the master key is a random key held by the OS
// keychain (or the 0600 fallback file), not derived from a user passphrase.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import sodium from "sodium-native";

const NONCEBYTES = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
const ABYTES = sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES;

export class SecretsVault {
  constructor(
    private readonly db: Database.Database,
    private readonly key: Buffer,
  ) {
    this.db.pragma("journal_mode = WAL");
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS secrets (
         namespace   TEXT NOT NULL,
         key         TEXT NOT NULL,
         nonce       BLOB NOT NULL,
         ciphertext  BLOB NOT NULL,
         created_at  TEXT NOT NULL,
         PRIMARY KEY (namespace, key)
       )`,
    );
  }

  set(namespace: string, key: string, plaintext: string): void {
    const nonce = Buffer.alloc(NONCEBYTES);
    sodium.randombytes_buf(nonce);
    const msg = Buffer.from(plaintext, "utf8");
    const ciphertext = Buffer.alloc(msg.length + ABYTES);
    sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(ciphertext, msg, null, null, nonce, this.key);
    this.db
      .prepare(
        `INSERT INTO secrets (namespace, key, nonce, ciphertext, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(namespace, key)
         DO UPDATE SET nonce = excluded.nonce, ciphertext = excluded.ciphertext, created_at = excluded.created_at`,
      )
      .run(namespace, key, nonce, ciphertext, new Date().toISOString());
  }

  // Returns the plaintext, or null if absent. Throws if the ciphertext fails
  // authentication (wrong key or tampering) — callers must not swallow that.
  get(namespace: string, key: string): string | null {
    const row = this.db
      .prepare(`SELECT nonce, ciphertext FROM secrets WHERE namespace = ? AND key = ?`)
      .get(namespace, key) as { nonce: Buffer; ciphertext: Buffer } | undefined;
    if (!row) return null;
    const msg = Buffer.alloc(row.ciphertext.length - ABYTES);
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(msg, null, row.ciphertext, null, row.nonce, this.key);
    return msg.toString("utf8");
  }

  delete(namespace: string, key: string): void {
    this.db.prepare(`DELETE FROM secrets WHERE namespace = ? AND key = ?`).run(namespace, key);
  }

  listKeys(namespace: string): string[] {
    const rows = this.db
      .prepare(`SELECT key FROM secrets WHERE namespace = ? ORDER BY key`)
      .all(namespace) as Array<{ key: string }>;
    return rows.map((r) => r.key);
  }

  close(): void {
    this.db.close();
  }
}

export function openVault(dbPath: string, key: Buffer): SecretsVault {
  mkdirSync(dirname(dbPath), { recursive: true });
  return new SecretsVault(new Database(dbPath), key);
}
