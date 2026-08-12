import "server-only";
import crypto from "crypto";
import { env } from "./env";

/**
 * Symmetric encryption for secrets we must store but must never expose:
 * currently Google/YouTube OAuth access & refresh tokens.
 *
 * AES-256-GCM with a random 12-byte IV per record and the auth tag kept
 * alongside the ciphertext, so tampering fails loudly on decrypt instead of
 * yielding garbage. The key is derived from SESSION_SECRET via HKDF with a
 * fixed info string, which keeps the token key domain-separated from anything
 * else derived from the same secret.
 */

const KEY = crypto.hkdfSync("sha256", env.SESSION_SECRET, "academy-support-token-salt", "oauth-token-encryption", 32);
const IV_BYTES = 12;

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(KEY), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptSecret(payload: string): string {
  // Validate by structure, not truthiness: a legitimately encrypted empty string
  // has an empty ciphertext segment, and `!dataPart` would reject it as malformed.
  const parts = payload.split(".");
  const [version, ivPart, tagPart, dataPart] = parts;
  if (parts.length !== 4 || version !== "v1" || !ivPart || !tagPart || dataPart === undefined) {
    throw new Error("Malformed encrypted payload");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(KEY), Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataPart, "base64url")), decipher.final()]).toString("utf8");
}

/** Timing-safe string comparison for tokens/hashes of equal expected length. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Timing-safe comparison for values whose length is itself secret.
 *
 * safeEqual() short-circuits on a length mismatch, which reveals the expected
 * length. Hashing both sides first makes every comparison the same fixed width,
 * so neither the length nor the contents leak through timing.
 */
export function safeEqualHashed(a: string, b: string): boolean {
  return crypto.timingSafeEqual(
    crypto.createHash("sha256").update(a).digest(),
    crypto.createHash("sha256").update(b).digest()
  );
}

/** Derives a purpose-scoped secret from SESSION_SECRET via HKDF. */
export function derivedSecret(purpose: string, bytes = 32): string {
  return Buffer.from(
    crypto.hkdfSync("sha256", env.SESSION_SECRET, "academy-support-derive-salt", purpose, bytes)
  ).toString("base64url");
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}
