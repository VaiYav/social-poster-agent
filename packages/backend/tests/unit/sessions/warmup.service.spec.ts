/**
 * F20: WarmupService unit tests.
 *
 * Tests warm-up phase calculation, canPost logic, phase transitions,
 * and completion flow.
 *
 * Source: packages/backend/src/modules/sessions/warmup.service.ts
 * Traces to: REQ-F20 (warmup)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfigService } from "@nestjs/config";
import { WarmupService } from "../../../src/modules/sessions/warmup.service.js";

// ── Mock Prisma ──

const mockPrisma = {
  socialAccount: {
    update: vi.fn(),
    findUnique: vi.fn(),
  },
  session: {
    create: vi.fn(),
    updateMany: vi.fn(),
  },
};

function createMockConfigService(overrides: Record<string, unknown> = {}): ConfigService {
  return {
    get: vi.fn((key: string, defaultValue?: unknown) => overrides[key] ?? defaultValue),
  } as unknown as ConfigService;
}

describe("WarmupService (F20 — Session Warm-up)", () => {
  let service: WarmupService;
  let configService: ConfigService;

  beforeEach(() => {
    vi.clearAllMocks();
    configService = createMockConfigService({ WARMUP_DAYS_TOTAL: 7 });
    service = new WarmupService(mockPrisma as never, configService);
  });

  // ── startWarmup() ──

  it("WU-001: startWarmup() sets warmupEnabled, warmupStartedAt, warmupDaysTotal", async () => {
    await service.startWarmup("account-123");

    expect(mockPrisma.socialAccount.update).toHaveBeenCalledWith({
      where: { id: "account-123" },
      data: {
        warmupEnabled: true,
        warmupStartedAt: expect.any(Date),
        warmupDaysTotal: 7,
      },
    });
  });

  it("WU-002: startWarmup() creates a WARMUP session", async () => {
    await service.startWarmup("account-123");

    expect(mockPrisma.session.create).toHaveBeenCalledWith({
      data: {
        accountId: "account-123",
        storageState: { cookies: [], origins: [] },
        status: "WARMUP",
      },
    });
  });

  // ── getWarmupStatus() ──

  it("WU-003: getWarmupStatus() returns null when account not found", async () => {
    mockPrisma.socialAccount.findUnique.mockResolvedValue(null);

    const status = await service.getWarmupStatus("nonexistent");
    expect(status).toBeNull();
  });

  it("WU-004: getWarmupStatus() returns null when warmup not enabled", async () => {
    mockPrisma.socialAccount.findUnique.mockResolvedValue({
      id: "acc-1",
      warmupEnabled: false,
      warmupStartedAt: null,
      warmupDaysTotal: 7,
    });

    const status = await service.getWarmupStatus("acc-1");
    expect(status).toBeNull();
  });

  it("WU-005: getWarmupStatus() returns null when warmupStartedAt is null", async () => {
    mockPrisma.socialAccount.findUnique.mockResolvedValue({
      id: "acc-1",
      warmupEnabled: true,
      warmupStartedAt: null,
      warmupDaysTotal: 7,
    });

    const status = await service.getWarmupStatus("acc-1");
    expect(status).toBeNull();
  });

  it("WU-006: getWarmupStatus() returns browse-only phase on day 0", async () => {
    mockPrisma.socialAccount.findUnique.mockResolvedValue({
      id: "acc-1",
      warmupEnabled: true,
      warmupStartedAt: new Date(), // today
      warmupDaysTotal: 7,
    });

    const status = await service.getWarmupStatus("acc-1");
    expect(status).not.toBeNull();
    expect(status!.phase).toBe("browse-only");
    expect(status!.canPost).toBe(false);
    expect(status!.canInteract).toBe(false);
    expect(status!.maxInteractionsPerDay).toBe(0);
  });

  it("WU-007: getWarmupStatus() returns light phase on day 3", async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    mockPrisma.socialAccount.findUnique.mockResolvedValue({
      id: "acc-1",
      warmupEnabled: true,
      warmupStartedAt: threeDaysAgo,
      warmupDaysTotal: 7,
    });

    const status = await service.getWarmupStatus("acc-1");
    expect(status).not.toBeNull();
    expect(status!.phase).toBe("light");
    expect(status!.canPost).toBe(false);
    expect(status!.canInteract).toBe(true);
    expect(status!.maxInteractionsPerDay).toBe(2);
  });

  it("WU-008: getWarmupStatus() returns moderate phase on day 6", async () => {
    const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
    mockPrisma.socialAccount.findUnique.mockResolvedValue({
      id: "acc-1",
      warmupEnabled: true,
      warmupStartedAt: sixDaysAgo,
      warmupDaysTotal: 7,
    });

    const status = await service.getWarmupStatus("acc-1");
    expect(status).not.toBeNull();
    expect(status!.phase).toBe("moderate");
    expect(status!.canPost).toBe(true);
    expect(status!.canInteract).toBe(true);
    expect(status!.maxInteractionsPerDay).toBe(5);
  });

  it("WU-009: getWarmupStatus() completes warmup when days >= total", async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    mockPrisma.socialAccount.findUnique.mockResolvedValue({
      id: "acc-1",
      warmupEnabled: true,
      warmupStartedAt: tenDaysAgo,
      warmupDaysTotal: 7,
    });

    const status = await service.getWarmupStatus("acc-1");
    expect(status).toBeNull();
    expect(mockPrisma.socialAccount.update).toHaveBeenCalledWith({
      where: { id: "acc-1" },
      data: { warmupEnabled: false },
    });
  });

  // ── canPost() ──

  it("WU-010: canPost() returns true when not in warmup", async () => {
    mockPrisma.socialAccount.findUnique.mockResolvedValue(null);
    const result = await service.canPost("acc-1");
    expect(result).toBe(true);
  });

  it("WU-011: canPost() returns false during browse-only phase", async () => {
    mockPrisma.socialAccount.findUnique.mockResolvedValue({
      id: "acc-1",
      warmupEnabled: true,
      warmupStartedAt: new Date(),
      warmupDaysTotal: 7,
    });
    const result = await service.canPost("acc-1");
    expect(result).toBe(false);
  });

  it("WU-012: canPost() returns true during moderate phase", async () => {
    const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
    mockPrisma.socialAccount.findUnique.mockResolvedValue({
      id: "acc-1",
      warmupEnabled: true,
      warmupStartedAt: sixDaysAgo,
      warmupDaysTotal: 7,
    });
    const result = await service.canPost("acc-1");
    expect(result).toBe(true);
  });

  // ── completeWarmup() ──

  it("WU-013: completeWarmup() disables warmup and updates sessions to ACTIVE", async () => {
    await service.completeWarmup("acc-1");

    expect(mockPrisma.socialAccount.update).toHaveBeenCalledWith({
      where: { id: "acc-1" },
      data: { warmupEnabled: false },
    });
    expect(mockPrisma.session.updateMany).toHaveBeenCalledWith({
      where: { accountId: "acc-1", status: "WARMUP" },
      data: { status: "ACTIVE" },
    });
  });

  // ── Short warmup (3 days) ──

  it("WU-014: short warmup (3 days) — day 0 is browse-only", async () => {
    mockPrisma.socialAccount.findUnique.mockResolvedValue({
      id: "acc-1",
      warmupEnabled: true,
      warmupStartedAt: new Date(),
      warmupDaysTotal: 3,
    });

    const status = await service.getWarmupStatus("acc-1");
    expect(status!.phase).toBe("browse-only");
  });

  it("WU-015: short warmup (3 days) — day 1 is light", async () => {
    const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    mockPrisma.socialAccount.findUnique.mockResolvedValue({
      id: "acc-1",
      warmupEnabled: true,
      warmupStartedAt: oneDayAgo,
      warmupDaysTotal: 3,
    });

    const status = await service.getWarmupStatus("acc-1");
    expect(status!.phase).toBe("light");
  });

  it("WU-016: short warmup (3 days) — day 2+ is full", async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    mockPrisma.socialAccount.findUnique.mockResolvedValue({
      id: "acc-1",
      warmupEnabled: true,
      warmupStartedAt: twoDaysAgo,
      warmupDaysTotal: 3,
    });

    const status = await service.getWarmupStatus("acc-1");
    expect(status!.phase).toBe("full");
    expect(status!.canPost).toBe(true);
    expect(status!.maxInteractionsPerDay).toBe(15);
  });
});
