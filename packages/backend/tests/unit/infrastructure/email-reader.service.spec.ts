/**
 * MOD-EMAIL: EmailReaderService unit tests.
 *
 * Traces to: Phase 5.5 + 5.6 — IMAP connection reuse and UID tracking.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { ConfigService } from '@nestjs/config';
import { EmailReaderService } from '../../../src/infrastructure/email/email-reader.service';
import { ImapFlow } from 'imapflow';

// Mock ImapFlow module so each new EmailReaderService gets a controlled client.
vi.mock('imapflow', () => ({
  ImapFlow: vi.fn(),
}));

function createMockClient() {
  const client = new EventEmitter() as {
    usable: boolean;
    connect: ReturnType<typeof vi.fn>;
    getMailboxLock: ReturnType<typeof vi.fn>;
    search: ReturnType<typeof vi.fn>;
    fetchOne: ReturnType<typeof vi.fn>;
    logout: ReturnType<typeof vi.fn>;
    on: EventEmitter['on'];
    emit: EventEmitter['emit'];
  };
  client.usable = true;
  client.connect = vi.fn().mockResolvedValue(undefined);
  client.getMailboxLock = vi.fn().mockResolvedValue({ release: vi.fn() });
  client.search = vi.fn().mockResolvedValue([]);
  client.fetchOne = vi.fn().mockResolvedValue(null);
  client.logout = vi.fn().mockResolvedValue(undefined);
  return client;
}

function createConfigService(values: Record<string, unknown> = {}): ConfigService {
  return {
    get: vi.fn((key: string, defaultValue?: unknown) =>
      key in values ? values[key] : defaultValue,
    ),
    getOrThrow: vi.fn((key: string) => {
      if (!(key in values)) throw new Error(`Missing: ${key}`);
      return values[key];
    }),
  } as unknown as ConfigService;
}

describe('MOD-EMAIL: EmailReaderService', () => {
  let service: EmailReaderService;
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockClient = createMockClient();
    const ImapFlowMock = vi.mocked(ImapFlow);
    ImapFlowMock.mockImplementation(() => mockClient as unknown as ImapFlow);

    service = new EmailReaderService(
      createConfigService({
        EMAIL_USER: 'test@gmail.com',
        EMAIL_PASSWORD: 'secret',
        EMAIL_FROM_FILTER: 'x.com',
        EMAIL_IMAP_IDLE_TIMEOUT_MS: 300_000,
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ER-001: fetchVerificationCode reuses a single IMAP connection across calls', async () => {
    await service.fetchVerificationCode();
    await service.fetchVerificationCode();

    expect(ImapFlow).toHaveBeenCalledTimes(1);
    expect(mockClient.connect).toHaveBeenCalledTimes(1);
  });

  it('ER-002: fetchVerificationCode searches by UID > last seen after initial poll', async () => {
    // First call: messages UIDs 101 and 102
    mockClient.search.mockResolvedValueOnce([101, 102]);
    mockClient.fetchOne.mockResolvedValueOnce({
      uid: 102,
      envelope: { subject: 'Your code is 123456' },
      source: Buffer.from(''),
    });

    const first = await service.fetchVerificationCode();
    expect(first).toBe('123456');

    // Second call should search UID 103:*
    mockClient.search.mockResolvedValueOnce([103]);
    mockClient.fetchOne.mockResolvedValueOnce({
      uid: 103,
      envelope: { subject: 'Code: 654321' },
      source: Buffer.from(''),
    });

    const second = await service.fetchVerificationCode();
    expect(second).toBe('654321');

    const [, searchOptions] = mockClient.search.mock.calls[1] as [unknown, { uid: boolean }];
    expect(searchOptions?.uid).toBe(true);

    const [secondQuery] = mockClient.search.mock.calls[1] as [{ uid?: string; from: string; since: Date }[]];
    expect(secondQuery.uid).toBe('103:*');
  });

  it('ER-003: fetchVerificationCode skips UIDs already seen', async () => {
    mockClient.search.mockResolvedValueOnce([42]);
    mockClient.fetchOne.mockResolvedValueOnce({
      uid: 42,
      envelope: { subject: 'Code 111111' },
      source: Buffer.from(''),
    });
    await service.fetchVerificationCode();

    mockClient.search.mockResolvedValueOnce([]);
    const result = await service.fetchVerificationCode();

    expect(result).toBeNull();
    const [query] = mockClient.search.mock.calls[1] as [{ uid?: string }[]];
    expect(query.uid).toBe('43:*');
  });

  it('ER-004: stale emails are not returned when UID cursor has advanced past them', async () => {
    // Simulate two messages on first poll; highest UID becomes cursor.
    mockClient.search.mockResolvedValueOnce([10, 12]);
    mockClient.fetchOne.mockResolvedValueOnce({
      uid: 12,
      envelope: { subject: 'Your code is 888888' },
      source: Buffer.from(''),
    });
    await service.fetchVerificationCode();

    // Next poll returns lower UID 11 (re-ordered/stale) — should be ignored.
    mockClient.search.mockResolvedValueOnce([]);
    const result = await service.fetchVerificationCode();

    expect(result).toBeNull();
  });

  it('ER-005: reconnects when the IMAP connection emits an error', async () => {
    await service.fetchVerificationCode();
    expect(mockClient.connect).toHaveBeenCalledTimes(1);

    const secondClient = createMockClient();
    const ImapFlowMock = vi.mocked(ImapFlow);
    ImapFlowMock.mockImplementation(() => secondClient as unknown as ImapFlow);

    mockClient.emit('error', new Error('connection reset'));

    await service.fetchVerificationCode();

    expect(ImapFlow).toHaveBeenCalledTimes(2);
    expect(secondClient.connect).toHaveBeenCalledTimes(1);
  });

  it('ER-006: closes the connection after idle timeout', async () => {
    await service.fetchVerificationCode();
    expect(mockClient.logout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300_001);

    expect(mockClient.logout).toHaveBeenCalledTimes(1);
  });

  it('ER-007: idle timeout is reset by active polling', async () => {
    await service.fetchVerificationCode();

    // Advance to just before idle timeout
    await vi.advanceTimersByTimeAsync(290_000);
    await service.fetchVerificationCode();

    // Now advance another full idle period — it should NOT close after the original timeout
    await vi.advanceTimersByTimeAsync(290_001);
    expect(mockClient.logout).not.toHaveBeenCalled();

    // But it should close after the new idle period from the second poll
    await vi.advanceTimersByTimeAsync(10_001);
    expect(mockClient.logout).toHaveBeenCalledTimes(1);
  });

  it('ER-008: disabled service returns null immediately', async () => {
    const disabled = new EmailReaderService(
      createConfigService({ EMAIL_USER: '', EMAIL_PASSWORD: '' }),
    );

    const result = await disabled.fetchVerificationCode();

    expect(result).toBeNull();
    expect(ImapFlow).not.toHaveBeenCalled();
  });
});
