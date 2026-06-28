/**
 * EncryptionService unit tests — AES-256-GCM encrypt/decrypt roundtrip,
 * passthrough mode, tamper detection, and format validation.
 *
 * Uses real Node.js crypto (the service is a domain class with no external deps).
 *
 * Source: packages/backend/src/infrastructure/crypto/encryption.service.ts
 * Test IDs: UTC-420 through UTC-429
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'node:crypto';
import { EncryptionService } from '../../../src/infrastructure/crypto/encryption.service';

// ── Helpers ──

/** Generate a valid 32-byte (64 hex char) AES-256-GCM key. */
function generateKeyHex(): string {
  return crypto.randomBytes(32).toString('hex');
}

function createMockConfigService(overrides: Record<string, unknown> = {}): ConfigService {
  const defaults: Record<string, unknown> = {
    SESSION_ENCRYPTION_KEY: '',
    NODE_ENV: 'development',
  };
  return {
    get: vi.fn((key: string, defaultValue?: unknown) => overrides[key] ?? defaults[key] ?? defaultValue),
  } as unknown as ConfigService;
}

// ── Tests ──

describe('EncryptionService', () => {
  let keyHex: string;

  beforeEach(() => {
    vi.clearAllMocks();
    keyHex = generateKeyHex();
  });

  // ── encrypt / decrypt roundtrip ──

  it('UTC-420: encrypt → decrypt roundtrip: {cookies:[...]} → same object', () => {
    // Arrange
    const service = new EncryptionService(createMockConfigService({ SESSION_ENCRYPTION_KEY: keyHex }));
    const data = { cookies: [{ name: 'session', value: 'abc123', domain: '.x.com' }], origins: [] };

    // Act
    const encrypted = service.encrypt(data);
    const decrypted = service.decrypt<typeof data>(encrypted);

    // Assert
    expect(decrypted).toEqual(data);
  });

  it('UTC-421: encrypt returns v1 format: "v1:{iv}:{ciphertext}:{authTag}"', () => {
    // Arrange
    const service = new EncryptionService(createMockConfigService({ SESSION_ENCRYPTION_KEY: keyHex }));

    // Act
    const encrypted = service.encrypt({ foo: 'bar' });

    // Assert
    const parts = encrypted.split(':');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
    // iv is 12 bytes → 24 hex chars
    expect(parts[1]!.length).toBe(24);
    // authTag is 16 bytes → 32 hex chars
    expect(parts[3]!.length).toBe(32);
  });

  it('UTC-422: decrypt with wrong key → throws error', () => {
    // Arrange
    const serviceA = new EncryptionService(createMockConfigService({ SESSION_ENCRYPTION_KEY: keyHex }));
    const wrongKey = generateKeyHex();
    const serviceB = new EncryptionService(createMockConfigService({ SESSION_ENCRYPTION_KEY: wrongKey }));

    // Act / Assert
    const encrypted = serviceA.encrypt({ secret: 'data' });
    expect(() => serviceB.decrypt(encrypted)).toThrow();
  });

  // ── passthrough mode ──

  it('UTC-423: passthrough mode (no SESSION_ENCRYPTION_KEY) → JSON.stringify', () => {
    // Arrange
    const service = new EncryptionService(createMockConfigService({ SESSION_ENCRYPTION_KEY: '' }));

    // Act
    const result = service.encrypt({ hello: 'world' });

    // Assert
    expect(result).toBe(JSON.stringify({ hello: 'world' }));
    expect(service.isEncrypted(result)).toBe(false);
  });

  // ── isEncrypted ──

  it('UTC-424: isEncrypted: "v1:..." → true; "plain" → false', () => {
    // Arrange
    const service = new EncryptionService(createMockConfigService({ SESSION_ENCRYPTION_KEY: keyHex }));
    const encrypted = service.encrypt({ data: 1 });

    // Act / Assert
    expect(service.isEncrypted(encrypted)).toBe(true);
    expect(service.isEncrypted('plain text')).toBe(false);
    expect(service.isEncrypted(JSON.stringify({ a: 1 }))).toBe(false);
  });

  // ── isEnabled ──

  it('UTC-425: isEnabled: key configured → true; not set → false', () => {
    // Arrange
    const enabledService = new EncryptionService(createMockConfigService({ SESSION_ENCRYPTION_KEY: keyHex }));
    const disabledService = new EncryptionService(createMockConfigService({ SESSION_ENCRYPTION_KEY: '' }));

    // Act / Assert
    expect(enabledService.isEnabled()).toBe(true);
    expect(disabledService.isEnabled()).toBe(false);
  });

  // ── tamper detection ──

  it('UTC-426: tampered ciphertext → authTag fails → throws', () => {
    // Arrange
    const service = new EncryptionService(createMockConfigService({ SESSION_ENCRYPTION_KEY: keyHex }));
    const encrypted = service.encrypt({ value: 'original' });

    // Act — flip a bit in the ciphertext portion
    const parts = encrypted.split(':');
    const tamperedCiphertext = parts[2]!.slice(0, -2) + (parts[2]!.slice(-2) === '00' ? '01' : '00');
    const tampered = [parts[0], parts[1], tamperedCiphertext, parts[3]].join(':');

    // Assert
    expect(() => service.decrypt(tampered)).toThrow();
  });

  // ── large storageState ──

  it('UTC-427: large storageState (100 cookies) → encrypt → decrypt → same', () => {
    // Arrange
    const service = new EncryptionService(createMockConfigService({ SESSION_ENCRYPTION_KEY: keyHex }));
    const cookies = Array.from({ length: 100 }, (_, i) => ({
      name: `cookie_${i}`,
      value: `value_${i}_${'x'.repeat(50)}`,
      domain: '.example.com',
      path: '/',
      expires: Date.now() + 3600000,
    }));
    const data = { cookies, origins: [{ origin: 'https://example.com', localStorage: [] }] };

    // Act
    const encrypted = service.encrypt(data);
    const decrypted = service.decrypt<typeof data>(encrypted);

    // Assert
    expect(decrypted).toEqual(data);
    expect(decrypted.cookies).toHaveLength(100);
  });

  // ── decrypt passthrough (plaintext input) ──

  it('UTC-428: decrypt plaintext (no v1 prefix) → JSON.parse passthrough', () => {
    // Arrange
    const service = new EncryptionService(createMockConfigService({ SESSION_ENCRYPTION_KEY: keyHex }));
    const plaintext = JSON.stringify({ plain: true });

    // Act
    const result = service.decrypt(plaintext);

    // Assert
    expect(result).toEqual({ plain: true });
  });

  // ── decrypt encrypted data when key not set ──

  it('UTC-429: decrypt v1 data when key not set → throws (cannot decrypt)', () => {
    // Arrange
    const enabledService = new EncryptionService(createMockConfigService({ SESSION_ENCRYPTION_KEY: keyHex }));
    const disabledService = new EncryptionService(createMockConfigService({ SESSION_ENCRYPTION_KEY: '' }));
    const encrypted = enabledService.encrypt({ data: 'secret' });

    // Act / Assert
    expect(() => disabledService.decrypt(encrypted)).toThrow(
      /SESSION_ENCRYPTION_KEY not configured/,
    );
  });
});
