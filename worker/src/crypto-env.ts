/**
 * worker/src/crypto-env.ts
 *
 * AES-256-GCM decrypt helper.
 * Mirrors frontend/lib/crypto-env.ts — must use the same AGENT_SECRET.
 */

import { createDecipheriv, createHash } from "crypto";

function getDerivedKey(): Buffer {
  const secret = process.env.AGENT_SECRET;
  if (!secret || !secret.trim()) {
    throw new Error("Missing required environment variable: AGENT_SECRET");
  }
  return createHash("sha256").update(secret).digest();
}

/**
 * Decrypts a string produced by the frontend's encryptEnvConfig().
 * Format: "<iv_hex>:<authTag_hex>:<ciphertext_hex>"
 * Throws if tampered or format is wrong.
 */
export function decryptEnvConfig(ciphertext: string): Record<string, string> {
  const key = getDerivedKey();
  const parts = ciphertext.split(":");
  if (parts.length !== 3) {
    throw new Error(`Invalid encrypted env format: expected 3 colon-separated parts, got ${parts.length}`);
  }
  const [ivHex, authTagHex, dataHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const data = Buffer.from(dataHex, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  return JSON.parse(plaintext) as Record<string, string>;
}