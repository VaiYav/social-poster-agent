/**
 * PrismaService unit tests.
 *
 * Traces to: Phase 5.12 — slow-query logging middleware via Prisma $on('query').
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PrismaService } from "../../../src/infrastructure/prisma/prisma.service";
import { createMockConfigService } from "../../mocks/index.js";

describe("PrismaService", () => {
  let service: PrismaService;

  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://spa:spa@localhost:5433/social_poster");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("PR-001: registers a query event listener on module init and logs slow queries", async () => {
    const config = createMockConfigService({ SLOW_QUERY_THRESHOLD_MS: "100" });
    service = new PrismaService(config as any);

    const connectSpy = vi.spyOn(service, "$connect").mockResolvedValue(undefined);
    const warnSpy = vi.spyOn(service["logger"], "warn");

    let queryCallback: ((event: { duration: number; query: string }) => void) | undefined;
    vi.spyOn(service, "$on").mockImplementation((event: string, cb: any) => {
      if (event === "query") queryCallback = cb;
    });

    await service.onModuleInit();

    expect(connectSpy).toHaveBeenCalled();
    expect(queryCallback).toBeDefined();

    // Fast query — below threshold, no warning.
    queryCallback!({ duration: 50, query: "SELECT fast" });
    expect(warnSpy).not.toHaveBeenCalled();

    // Slow query — at threshold, should warn.
    queryCallback!({ duration: 100, query: "SELECT slow" });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Slow query (100ms >= 100ms): SELECT slow"),
    );
  });

  it("PR-002: disables slow-query logging when threshold is 0", async () => {
    const config = createMockConfigService({ SLOW_QUERY_THRESHOLD_MS: "0" });
    service = new PrismaService(config as any);

    vi.spyOn(service, "$connect").mockResolvedValue(undefined);
    const onSpy = vi.spyOn(service, "$on");

    await service.onModuleInit();

    expect(onSpy).not.toHaveBeenCalled();
  });
});
