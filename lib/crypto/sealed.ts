/**
 * Authenticated, self-expiring cookie payloads (AES-256-GCM).
 *
 * Two unrelated secrets now ride in cookies — a user's provider API key and an
 * account session — and both need the same three properties: tamper-evident,
 * opaque to page JavaScript, and dead after a fixed lifetime. This is that
 * mechanism written once, rather than the same twenty lines of crypto twice.
 *
 * Domain separation: the effective encryption key is derived from the configured
 * secret AND the codec's version tag, which is also the GCM additional data. Two
 * codecs reading the same environment secret therefore cannot unseal each
 * other's cookies, and bumping one codec's version invalidates only its own.
 *
 * Server-only: `node:crypto` and `process.env` mean this must never be imported
 * into a client component.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** The minimum secret length worth accepting; short secrets are a config bug. */
const MIN_SECRET_LENGTH = 32;

/**
 * Tolerance on the upper expiry bound. A cookie whose `expiresAt` is further
 * out than the codec's own lifetime allows was not minted by this codec's
 * current configuration, so it is rejected — the slack only absorbs clock skew
 * between sealing and reading.
 */
const EXPIRY_SKEW_MS = 60_000;

export interface Sealed {
  /** The cookie value: `version.iv.ciphertext.tag`, all base64url. */
  value: string;
  expiresAt: number;
}

/** A decrypted payload always carries the expiry the sealer stamped on it. */
export type Unsealed<T> = T & { expiresAt: number };

export interface SealedCodec<T> {
  maxAgeSeconds: number;
  seal(payload: T, now?: number): Sealed;
  /** Invalid, tampered, expired, or foreign-version values are treated as absent. */
  unseal(value: string, now?: number): Unsealed<T> | null;
}

export interface SealedCodecOptions<T> {
  /** Format + domain tag. Bump to invalidate every cookie this codec issued. */
  version: string;
  /** Environment variables holding the secret, in priority order. */
  secretEnv: [string, ...string[]];
  maxAgeSeconds: number;
  /**
   * Shape guard applied after decryption. Authenticity is already proven by the
   * GCM tag; this catches a payload written by an older build of the same
   * version whose fields no longer parse.
   */
  isPayload: (value: unknown) => value is T;
}

function encode(value: Buffer): string {
  return value.toString("base64url");
}

function decode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

export function createSealedCodec<T extends object>({
  version,
  secretEnv,
  maxAgeSeconds,
  isPayload,
}: SealedCodecOptions<T>): SealedCodec<T> {
  /** Resolved per call, not at module load: tests and scripts set env late. */
  function encryptionKey(): Buffer {
    const secret = secretEnv.map((name) => process.env[name]).find((value) => value && value.length >= MIN_SECRET_LENGTH);
    if (!secret) {
      throw new Error(`${secretEnv.join(" or ")} must be set to at least ${MIN_SECRET_LENGTH} characters`);
    }
    // The version tag is mixed into the key, not just the AAD, so the two are
    // cryptographically distinct keys rather than one key with a label.
    return createHash("sha256").update(`${secret}:${version}`, "utf8").digest();
  }

  return {
    maxAgeSeconds,

    seal(payload, now = Date.now()) {
      const expiresAt = now + maxAgeSeconds * 1000;
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
      cipher.setAAD(Buffer.from(version));
      const plaintext = Buffer.from(JSON.stringify({ ...payload, expiresAt }), "utf8");
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return {
        value: [version, encode(iv), encode(ciphertext), encode(cipher.getAuthTag())].join("."),
        expiresAt,
      };
    },

    unseal(value, now = Date.now()) {
      try {
        const [tag, ivText, ciphertextText, authTagText, extra] = value.split(".");
        if (tag !== version || !ivText || !ciphertextText || !authTagText || extra) return null;
        const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), decode(ivText));
        decipher.setAAD(Buffer.from(version));
        decipher.setAuthTag(decode(authTagText));
        const plaintext = Buffer.concat([
          decipher.update(decode(ciphertextText)),
          decipher.final(),
        ]).toString("utf8");

        const payload: unknown = JSON.parse(plaintext);
        if (!isPayload(payload)) return null;
        const { expiresAt } = payload as Unsealed<T>;
        if (
          typeof expiresAt !== "number" ||
          expiresAt <= now ||
          expiresAt > now + maxAgeSeconds * 1000 + EXPIRY_SKEW_MS
        ) {
          return null;
        }
        return payload as Unsealed<T>;
      } catch {
        // Malformed base64, a failed auth tag, a rotated secret, unparseable
        // JSON — all mean the same thing to a caller: there is no session here.
        return null;
      }
    },
  };
}
