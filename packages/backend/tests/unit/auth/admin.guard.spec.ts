/**
 * AdminGuard unit tests — role-based admin access control.
 *
 * Source: packages/backend/src/modules/auth/admin.guard.ts
 */
import { describe, it, expect, vi } from "vitest";
import { ForbiddenException, type ExecutionContext } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AdminGuard } from "../../../src/modules/auth/admin.guard.js";

function cfg(values: Record<string, string>): ConfigService {
  return { get: vi.fn((k: string, d?: unknown) => values[k] ?? d) } as unknown as ConfigService;
}

function ctx(req: Record<string, unknown>): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

describe("AdminGuard", () => {
  it("passes through when AUTH_ENABLED=false (dev / VPN-only)", () => {
    const guard = new AdminGuard(cfg({ AUTH_ENABLED: "false" }));
    expect(guard.canActivate(ctx({ user: undefined }))).toBe(true);
  });

  it("allows admin role when AUTH_ENABLED=true", () => {
    const guard = new AdminGuard(cfg({ AUTH_ENABLED: "true" }));
    expect(guard.canActivate(ctx({ user: { sub: "1", username: "admin", role: "admin" } }))).toBe(
      true,
    );
  });

  it("throws 403 for non-admin role when AUTH_ENABLED=true", () => {
    const guard = new AdminGuard(cfg({ AUTH_ENABLED: "true" }));
    expect(() =>
      guard.canActivate(ctx({ user: { sub: "2", username: "user", role: "user" } })),
    ).toThrow(ForbiddenException);
  });

  it("throws 403 for missing user when AUTH_ENABLED=true", () => {
    const guard = new AdminGuard(cfg({ AUTH_ENABLED: "true" }));
    expect(() => guard.canActivate(ctx({}))).toThrow(ForbiddenException);
  });
});
