/**
 * P0-H3: AES-256-GCM encryption service for sensitive data at rest.
 *
 * Used to encrypt Playwright storageState (cookies, localStorage) before
 * storing in the database. Without encryption, a DB leak = full access
 * to all social media accounts.
 *
 * Best practice (NIST SP 800-38D):
 *   - 32-byte (256-bit) key from env var (SESSION_ENCRYPTION_KEY, hex)
 *   - 12-byte (96-bit) random IV per encryption
 *   - 16-byte (128-bit) auth tag for integrity
 *   - Storage format: "v1:{iv_hex}:{ciphertext_hex}:{authTag_hex}"
 *
 * The "v1:" prefix enables future key rotation / algorithm migration.
 *
 * If SESSION_ENCRYPTION_KEY is not set, the service operates in passthrough
 * mode (no encryption) — backwards compatible with existing plaintext data.
 * A warning is logged on init. Production MUST set the key.
 */

import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12; // 96 bits (NIST recommended for GCM)
const AUTH_TAG_LENGTH = 16; // 128 bits
const VERSION_PREFIX = "v1";
export const KEY_HEX_REGEX = /^[a-f0-9]{64}$/i;
const HEX_REGEX = /^[a-f0-9]*$/i;

@Injectable()
export class EncryptionService {
  private readonly logger = new Logger(EncryptionService.name);
  private readonly key: Buffer | null;
  private readonly enabled: boolean;

  constructor(private readonly configService: ConfigService) {
    const keyHex = this.configService.get<string>("SESSION_ENCRYPTION_KEY", "");
    const nodeEnv = this.configService.get<string>("NODE_ENV", "development");

    if (keyHex && KEY_HEX_REGEX.test(keyHex)) {
      this.key = Buffer.from(keyHex, "hex");
      this.enabled = true;
      this.logger.log("Session encryption enabled (AES-256-GCM)");
    } else if (keyHex) {
      // Key present but wrong length — always an error
      const msg =
        `SESSION_ENCRYPTION_KEY must be ${KEY_LENGTH * 2} hex characters (32 bytes), ` +
        `got ${keyHex.length} characters — encryption DISABLED`;
      if (nodeEnv === "production") {
        // Fail-fast: a malformed key in production is a misconfiguration that
        // would silently store session cookies in plaintext. Refuse to boot.
        throw new Error(msg);
      }
      this.logger.error(msg);
      this.key = null;
      this.enabled = false;
    } else {
      // Key absent
      const msg =
        "SESSION_ENCRYPTION_KEY not set — storageState stored in plaintext. " +
        "Set it in production for security (use: openssl rand -hex 32)";
      if (nodeEnv === "production") {
        // Fail-fast: plaintext storage of session cookies in production is
        // an unacceptable risk (DB leak = full account takeover).
        throw new Error(
          "SESSION_ENCRYPTION_KEY is required in production but not set. " +
            "Generate one with: openssl rand -hex 32",
        );
      }
      this.logger.warn(msg);
      this.key = null;
      this.enabled = false;
    }
  }

  /** Returns true if encryption is active (key configured). */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Encrypt arbitrary data. Returns "v1:{iv}:{ciphertext}:{authTag}" string.
   * If encryption is disabled, returns JSON.stringify(data) (passthrough).
   */
  encrypt(data: unknown): string {
    if (!this.enabled || !this.key) {
      return JSON.stringify(data);
    }

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });

    const plaintext = JSON.stringify(data);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [
      VERSION_PREFIX,
      iv.toString("hex"),
      encrypted.toString("hex"),
      authTag.toString("hex"),
    ].join(":");
  }

  /**
   * Decrypt a string produced by encrypt(). Returns the original data.
   * If the string doesn't have the "v1:" prefix, assumes plaintext (passthrough).
   * Throws if decryption fails (tampered data or wrong key).
   */
  decrypt<T = unknown>(encryptedString: string): T {
    // Passthrough: not encrypted (no v1: prefix)
    if (!encryptedString.startsWith(`${VERSION_PREFIX}:`)) {
      return JSON.parse(encryptedString) as T;
    }

    if (!this.enabled || !this.key) {
      throw new Error(
        "Cannot decrypt: SESSION_ENCRYPTION_KEY not configured, but data is encrypted. " +
          "Set SESSION_ENCRYPTION_KEY to the correct value.",
      );
    }

    const parts = encryptedString.split(":");
    if (parts.length !== 4) {
      throw new Error(
        'Invalid encrypted string format — expected "v1:{iv}:{ciphertext}:{authTag}"',
      );
    }

    const [, ivHex, encryptedHex, authTagHex] = parts;
    if (!ivHex || !encryptedHex || !authTagHex) {
      throw new Error("Invalid encrypted string format — missing components");
    }
    const iv = Buffer.from(ivHex, "hex");
    const encrypted = Buffer.from(encryptedHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");

    const decipher = crypto.createDecipheriv(ALGORITHM, this.key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

    return JSON.parse(decrypted.toString("utf8")) as T;
  }

  /**
   * Check if a string is encrypted and has the expected v1 structure.
   * The format must be "v1:{iv_hex}:{ciphertext_hex}:{authTag_hex}" with
   * valid hex components and the correct IV/authTag byte lengths.
   */
  isEncrypted(value: string): boolean {
    if (!value.startsWith(`${VERSION_PREFIX}:`)) {
      return false;
    }
    const parts = value.split(":");
    if (parts.length !== 4) {
      return false;
    }
    const [version, ivHex, encryptedHex, authTagHex] = parts;
    if (version !== VERSION_PREFIX) {
      return false;
    }
    if (!ivHex || !encryptedHex || !authTagHex) {
      return false;
    }
    if (!HEX_REGEX.test(ivHex) || !HEX_REGEX.test(encryptedHex) || !HEX_REGEX.test(authTagHex)) {
      return false;
    }
    if (ivHex.length !== IV_LENGTH * 2 || authTagHex.length !== AUTH_TAG_LENGTH * 2) {
      return false;
    }
    return true;
  }
}
