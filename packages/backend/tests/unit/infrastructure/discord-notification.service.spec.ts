/**
 * DiscordNotificationService unit tests.
 *
 * Tests alert sending via Discord webhook, severity colors, embed fields,
 * graceful degradation when webhook not configured, fetch timeout handling,
 * and isEnabled() checks.
 *
 * Source: packages/backend/src/infrastructure/notifications/discord-notification.service.ts
 * Covers UTC-500 through UTC-508 (9 test cases).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ConfigService } from "@nestjs/config";
import { DiscordNotificationService } from "../../../src/infrastructure/notifications/discord-notification.service";

// ── Helpers ──

const WEBHOOK_URL = "https://discord.com/api/webhooks/test/test-token";

function createMockConfigService(overrides: Record<string, unknown> = {}): ConfigService {
  const defaults: Record<string, unknown> = {
    DISCORD_WEBHOOK_URL: WEBHOOK_URL,
    DISCORD_ALERTS_ENABLED: "true",
  };
  return {
    get: vi.fn((key: string, defaultValue?: unknown) => {
      if (key in overrides) return overrides[key];
      if (key in defaults) return defaults[key];
      return defaultValue;
    }),
  } as unknown as ConfigService;
}

function mockFetchOk() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 204,
    text: () => Promise.resolve(""),
  });
}

/** Extract the JSON body sent to fetch. */
function getFetchBody(fetchMock: ReturnType<typeof vi.fn>): any {
  const call = fetchMock.mock.calls[0];
  if (!call) return null;
  const opts = call[1];
  return JSON.parse(opts.body);
}

// ── Tests ──

describe("DiscordNotificationService (UTC-500 — Discord alerts)", () => {
  let service: DiscordNotificationService;
  let configService: ConfigService;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = mockFetchOk();
    vi.stubGlobal("fetch", fetchMock);
    configService = createMockConfigService();
    service = new DiscordNotificationService(configService);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // ── sendAlert ──

  it("UTC-500: sendAlert() POSTs to Discord webhook with embed structure", async () => {
    await service.sendAlert({
      severity: "info",
      title: "Test Alert",
      message: "Something happened",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toBe(WEBHOOK_URL);
    expect(opts.method).toBe("POST");
    expect(opts.headers).toEqual({ "Content-Type": "application/json" });

    const body = getFetchBody(fetchMock);
    expect(body.embeds).toHaveLength(1);
    expect(body.embeds[0].title).toContain("Test Alert");
    expect(body.embeds[0].description).toBe("Something happened");
    expect(body.embeds[0].color).toBeDefined();
    expect(body.embeds[0].timestamp).toBeDefined();
  });

  it("UTC-501: critical() sends embed with red color (0xe74c3c)", async () => {
    await service.critical("DLQ Alert", "Job failed after retries");

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = getFetchBody(fetchMock);
    expect(body.embeds[0].color).toBe(0xe74c3c);
    expect(body.embeds[0].title).toContain("DLQ Alert");
  });

  it("UTC-502: warning() sends embed with orange color (0xf39c12)", async () => {
    await service.warning("Rate Limit", "Approaching daily limit");

    const body = getFetchBody(fetchMock);
    expect(body.embeds[0].color).toBe(0xf39c12);
  });

  it("UTC-503: info() sends embed with blue color (0x3498db)", async () => {
    await service.info("Info", "Generation completed");

    const body = getFetchBody(fetchMock);
    expect(body.embeds[0].color).toBe(0x3498db);
  });

  it("UTC-504: sendAlert() is a no-op when webhook URL not configured (no fetch, no throw)", async () => {
    const noWebhookConfig = createMockConfigService({ DISCORD_WEBHOOK_URL: "" });
    const noWebhookService = new DiscordNotificationService(noWebhookConfig);

    await expect(
      noWebhookService.sendAlert({ severity: "critical", title: "X", message: "Y" }),
    ).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("UTC-505: sendAlert() is a no-op when DISCORD_ALERTS_ENABLED is false", async () => {
    const disabledConfig = createMockConfigService({ DISCORD_ALERTS_ENABLED: "false" });
    const disabledService = new DiscordNotificationService(disabledConfig);

    await expect(
      disabledService.sendAlert({ severity: "critical", title: "X", message: "Y" }),
    ).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("UTC-506: sendAlert() retries on transient fetch failures and does not throw", async () => {
    const abortError = new DOMException("The operation was aborted", "AbortError");
    // First two attempts fail, third succeeds
    fetchMock.mockRejectedValueOnce(abortError).mockRejectedValueOnce(abortError);

    await expect(
      service.sendAlert({ severity: "critical", title: "X", message: "Y" }),
    ).resolves.toBeUndefined();

    // 3 total attempts (2 retries + the final one that succeeds)
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("UTC-507: sendAlert() renders fields in embed as [{name, value, inline}]", async () => {
    const fields = [
      { name: "Account", value: "@test_user", inline: true },
      { name: "Error", value: "Session expired", inline: false },
    ];

    await service.sendAlert({
      severity: "critical",
      title: "Session Expired",
      message: "Re-login required",
      fields,
    });

    const body = getFetchBody(fetchMock);
    expect(body.embeds[0].fields).toEqual(fields);
  });

  // ── isEnabled ──

  it("UTC-508: isEnabled() returns true when webhook set + alerts enabled; false otherwise", () => {
    expect(service.isEnabled()).toBe(true);

    const noWebhookService = new DiscordNotificationService(
      createMockConfigService({ DISCORD_WEBHOOK_URL: "" }),
    );
    expect(noWebhookService.isEnabled()).toBe(false);

    const disabledService = new DiscordNotificationService(
      createMockConfigService({ DISCORD_ALERTS_ENABLED: "false" }),
    );
    expect(disabledService.isEnabled()).toBe(false);
  });

  // ── retry + circuit breaker ──

  describe("Retry and circuit breaker", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("retries up to 3 attempts and succeeds when the final attempt works", async () => {
      fetchMock
        .mockRejectedValueOnce(new Error("transient"))
        .mockRejectedValueOnce(new Error("transient"));

      const promise = service.sendAlert({ severity: "critical", title: "Retry", message: "Test" });
      await vi.runAllTimersAsync();
      await promise;

      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("opens the circuit after 3 consecutive sendAlert failures and skips further calls", async () => {
      fetchMock.mockRejectedValue(new Error("persistent failure"));

      // 3 failing alerts, each exhausts its 3 retries
      for (let i = 0; i < 3; i++) {
        const promise = service.sendAlert({
          severity: "critical",
          title: "Circuit",
          message: "Test",
        });
        await vi.runAllTimersAsync();
        await promise;
      }

      // Each alert attempted 3 times
      expect(fetchMock).toHaveBeenCalledTimes(9);

      // 4th alert should be skipped by the circuit breaker, no new fetch calls
      const promise = service.sendAlert({
        severity: "critical",
        title: "Circuit",
        message: "Skipped",
      });
      await vi.runAllTimersAsync();
      await promise;

      expect(fetchMock).toHaveBeenCalledTimes(9);
    });
  });
});
