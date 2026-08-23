import { describe, expect, it, vi } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import { LocalhostGuard } from "../../../src/infrastructure/guards/localhost.guard.js";

function config(values: Record<string, unknown> = {}) {
  return {
    get: vi.fn((key: string, fallback?: unknown) => (key in values ? values[key] : fallback)),
  };
}

function context(remoteAddress: string, headers: Record<string, string | string[]> = {}) {
  const request = {
    method: "GET",
    url: "/internal/dangerous-operation",
    socket: { remoteAddress },
    headers,
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as never;
}

describe("LocalhostGuard", () => {
  it("bypasses only when NODE_ENV is test", () => {
    const guard = new LocalhostGuard(config({ NODE_ENV: "test" }) as never);

    expect(guard.canActivate(context("203.0.113.8"))).toBe(true);
  });

  it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1", "172.16.0.1", "172.31.255.254"])(
    "allows trusted direct address %s",
    (remoteAddress) => {
      const guard = new LocalhostGuard(config({ NODE_ENV: "production" }) as never);

      expect(guard.canActivate(context(remoteAddress))).toBe(true);
    },
  );

  it("allows loopback forwarded by a configured trusted proxy", () => {
    const guard = new LocalhostGuard(
      config({ NODE_ENV: "production", TRUSTED_PROXY_IPS: "10.0.0.2" }) as never,
    );

    expect(
      guard.canActivate(context("10.0.0.2", { "x-forwarded-for": "127.0.0.1, 10.0.0.2" })),
    ).toBe(true);
    expect(
      guard.canActivate(context("10.0.0.2", { "x-forwarded-for": ["172.20.0.4, 10.0.0.2"] })),
    ).toBe(true);
  });

  it.each([
    ["203.0.113.8", ""],
    ["172.15.0.1", ""],
    ["172.32.0.1", ""],
    ["10.0.0.3", "127.0.0.1"],
    ["10.0.0.2", "203.0.113.4"],
  ])("rejects untrusted address %s with forwarded value %s", (remoteAddress, forwarded) => {
    const guard = new LocalhostGuard(
      config({ NODE_ENV: "production", TRUSTED_PROXY_IPS: "10.0.0.2" }) as never,
    );
    const headers = forwarded ? { "x-forwarded-for": forwarded } : {};

    expect(() => guard.canActivate(context(remoteAddress, headers))).toThrow(ForbiddenException);
  });

  it("does not trust X-Forwarded-For from an unconfigured proxy", () => {
    const guard = new LocalhostGuard(config({ NODE_ENV: "production" }) as never);

    expect(() =>
      guard.canActivate(context("10.0.0.2", { "x-forwarded-for": "127.0.0.1" })),
    ).toThrow("only accessible from localhost");
  });
});
