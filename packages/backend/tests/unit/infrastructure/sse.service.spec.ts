/**
 * MOD-05: Infrastructure Adapters Module — SseService unit tests.
 *
 * Covers UTC-089 through UTC-098 (10 test cases).
 *
 * Source: packages/backend/src/infrastructure/sse/sse.service.ts
 * Traces to: REQ-020, REQ-032, REQ-033, REQ-035
 * Hazards: HAZ-014, HAZ-015
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { ConfigService } from '@nestjs/config';
import { SseService } from '../../../src/infrastructure/sse/sse.service';
import { createMockRedis } from '../../mocks/index';

// ── Helpers ──

function createMockConfigService(overrides: Record<string, unknown> = {}): ConfigService {
  return {
    get: vi.fn((key: string, defaultValue?: unknown) => overrides[key] ?? defaultValue),
  } as unknown as ConfigService;
}

function createMockResponse() {
  return {
    write: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    headersSent: false,
    writableEnded: false,
    destroyed: false,
  } as unknown;
}

// ── Tests ──

describe('SseService (MOD-05 — Infrastructure Adapters)', () => {
  let service: SseService;
  let configService: ConfigService;
  let mockRedis: ReturnType<typeof createMockRedis>;
  let mockPublisher: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis = createMockRedis();
    mockPublisher = createMockRedis();
    configService = createMockConfigService({
      REDIS_URL: 'redis://localhost:6380',
      SSE_CHANNEL: 'spa:sse',
    });
    // Sprint L: SseService now receives Redis connections via DI
    service = new SseService(configService, mockRedis, mockPublisher);
  });

  // ── UTC-089 ──
  it('UTC-089: addClient() generates unique clientId, stores response, sends connected event', () => {
    const mockRes = createMockResponse();
    const clientId = service.addClient(mockRes);

    // clientId format: sse-{timestamp}-{random}
    expect(clientId).toMatch(/^sse-\d+-[a-z0-9]+$/);

    // Initial heartbeat (connected event) sent via res.write
    expect(mockRes.write).toHaveBeenCalledOnce();
    const writtenData = mockRes.write.mock.calls[0]![0] as string;
    expect(writtenData).toContain('data: ');
    const parsed = JSON.parse(writtenData.replace(/^data: /, '').replace(/\n\n$/, ''));
    expect(parsed.type).toBe('connected');
    expect(parsed.clientId).toBe(clientId);

    // Client is stored in the map
    expect(service.getConnectedCount()).toBe(1);
  });

  // ── UTC-090 ──
  it('UTC-090: addClient() generates unique IDs for multiple clients', () => {
    const mockRes1 = createMockResponse();
    const mockRes2 = createMockResponse();

    const id1 = service.addClient(mockRes1);
    const id2 = service.addClient(mockRes2);

    expect(id1).not.toBe(id2);
    expect(service.getConnectedCount()).toBe(2);
  });

  // ── UTC-091 ──
  it('UTC-091: removeClient() removes client from map', () => {
    const mockRes = createMockResponse();
    const clientId = service.addClient(mockRes);
    expect(service.getConnectedCount()).toBe(1);

    service.removeClient(clientId);

    expect(service.getConnectedCount()).toBe(0);
  });

  // ── UTC-092 ──
  it('UTC-092: removeClient() is safe when clientId not in map (no throw)', () => {
    expect(() => service.removeClient('nonexistent')).not.toThrow();
    expect(service.getConnectedCount()).toBe(0);
  });

  // ── UTC-093 ──
  it('UTC-093: publish() publishes JSON event to Redis channel when connected', async () => {
    const event = {
      type: 'post_status',
      postId: 'p1',
      status: 'POSTED',
      url: 'https://x.com/1',
    };

    await service.publish(event);

    // Sprint L: publish() uses this.publisher (separate connection)
    expect(mockPublisher.publish).toHaveBeenCalledOnce();
    expect(mockPublisher.publish).toHaveBeenCalledWith('spa:sse', JSON.stringify(event));
  });

  // ── UTC-093a ──
  it('UTC-093a: publish() swallows Redis PUBLISH errors and logs them', async () => {
    const error = new Error('Redis unavailable');
    mockPublisher.publish.mockRejectedValue(error);

    await expect(service.publish({ type: 'post_status' })).resolves.toBeUndefined();
    expect(mockPublisher.publish).toHaveBeenCalledOnce();
  });

  // ── UTC-094 ──
  it('UTC-094: publish() does nothing when Redis not connected', async () => {
    (service as unknown).publisher = null;

    await service.publish({ type: 'post_status' });

    expect(mockPublisher.publish).not.toHaveBeenCalled();
  });

  // ── UTC-095 ──
  it('UTC-095: broadcast() writes message to all connected clients', () => {
    const mockRes1 = createMockResponse();
    const mockRes2 = createMockResponse();
    service.addClient(mockRes1);
    service.addClient(mockRes2);

    // Clear initial connected-event writes so we only assert broadcast writes
    mockRes1.write.mockClear();
    mockRes2.write.mockClear();

    // broadcast is private — invoke directly
    (service as unknown).broadcast('test-event');

    expect(mockRes1.write).toHaveBeenCalledWith('data: test-event\n\n');
    expect(mockRes2.write).toHaveBeenCalledWith('data: test-event\n\n');
  });

  // ── UTC-096 ──
  it('UTC-096: broadcast() removes client on write error (disconnected client cleanup)', () => {
    const failingRes = createMockResponse();
    // First write (initial heartbeat in addClient) succeeds; subsequent writes fail
    failingRes.write
      .mockImplementationOnce(() => true)
      .mockImplementation(() => {
        throw new Error('write EPIPE');
      });
    const successRes = createMockResponse();

    service.addClient(failingRes);
    service.addClient(successRes);
    expect(service.getConnectedCount()).toBe(2);

    // Clear initial connected-event writes so we only assert broadcast writes
    successRes.write.mockClear();

    // Trigger broadcast — failing client should be removed
    (service as unknown).broadcast('test-event');

    // Failing client removed; succeeding client retained
    expect(service.getConnectedCount()).toBe(1);
    expect(successRes.write).toHaveBeenCalledWith('data: test-event\n\n');
  });

  // ── UTC-097 ──
  it('UTC-097: getConnectedCount() returns current client map size', () => {
    service.addClient(createMockResponse());
    service.addClient(createMockResponse());
    service.addClient(createMockResponse());

    expect(service.getConnectedCount()).toBe(3);
  });

  // ── UTC-098 ──
  it('UTC-098: init() subscribes to Redis channel and sets up message listener', async () => {
    // Sprint L: SseService now receives Redis connections via DI
    const initMockRedis = createMockRedis();
    const initMockPublisher = createMockRedis();
    const freshService = new SseService(configService, initMockRedis, initMockPublisher);

    await freshService.init();

    expect(initMockRedis.subscribe).toHaveBeenCalledWith('spa:sse');
    expect(initMockRedis.on).toHaveBeenCalledWith('message', expect.any(Function));

    // Verify the message handler forwards to broadcast
    const onCall = initMockRedis.on.mock.calls.find((c) => c[0] === 'message');
    expect(onCall).toBeDefined();
    const messageHandler = onCall![1];

    // Add a client, then simulate a Redis message
    const mockRes = createMockResponse();
    freshService.addClient(mockRes);
    mockRes.write.mockClear(); // clear connected event

    messageHandler('spa:sse', 'redis-payload');
    expect(mockRes.write).toHaveBeenCalledWith('data: redis-payload\n\n');
  });
});
