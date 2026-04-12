/**
 * frontend/lib/crypto-env.ts
 *
 * AES-256-GCM helpers for encrypting/decrypting agent envConfig.
 *
 * Used by:
 *   - /api/agents/save-bot  →  encryptEnvConfig() before writing to DB
 *   - Worker reads from DB and decrypts using its own copy of this logic
 *
 * AGENT_SECRET must be set identically in both the frontend and worker
 * environment. If unset, a weak default is used (fine for local dev only).
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";

function getDerivedKey(): Buffer {
  const secret = process.env.AGENT_SECRET ?? "synth-default-secret-change-me";
  // SHA-256 of the secret gives a stable 32-byte key
  return createHash("sha256").update(secret).digest();
}

/**
 * Encrypts a UTF-8 plaintext string using AES-256-GCM.
 *
 * Returns: "<iv_hex>:<authTag_hex>:<ciphertext_hex>"
 *
 * The 12-byte IV is random per call (safe to store alongside ciphertext).
 * The 16-byte auth tag guarantees integrity — decryption throws on tampering.
 */
export function encryptEnvConfig(plaintext: string): string {
  const key = getDerivedKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypts a string produced by encryptEnvConfig.
 * Throws on bad format or auth tag mismatch (tamper-evident).
 */
export function decryptEnvConfig(ciphertext: string): string {
  const key = getDerivedKey();
  const parts = ciphertext.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted env format (expected 3 colon-separated parts)");
  const [ivHex, authTagHex, dataHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const data = Buffer.from(dataHex, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}