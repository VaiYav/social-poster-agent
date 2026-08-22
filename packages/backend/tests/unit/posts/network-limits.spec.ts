/**
 * PO2: checkContentLength() unit tests.
 *
 * Source: packages/backend/src/modules/posts/network-limits.ts
 */
import { describe, it, expect } from "vitest";
import { SocialNetwork } from "../../../src/generated/prisma/client";

import { checkContentLength, NETWORK_LIMITS } from "../../../src/modules/posts/network-limits.js";

describe("checkContentLength (PO2 — server-side length validation)", () => {
  it("passes content within the X limit", () => {
    const r = checkContentLength(SocialNetwork.X, "short tweet");
    expect(r.ok).toBe(true);
    expect(r.limit).toBe(280);
    expect(r.length).toBe("short tweet".length);
  });

  it("fails content over the X limit (280)", () => {
    const r = checkContentLength(SocialNetwork.X, "a".repeat(281));
    expect(r.ok).toBe(false);
    expect(r.length).toBe(281);
    expect(r.limit).toBe(280);
  });

  it("passes content exactly at the limit", () => {
    expect(checkContentLength(SocialNetwork.X, "a".repeat(280)).ok).toBe(true);
  });

  it("counts by Unicode code points so emoji are not over-counted vs UTF-16 units", () => {
    // 200 workflow emoji = 200 code points (400 UTF-16 units) — within 280.
    const r = checkContentLength(SocialNetwork.X, "🌙".repeat(200));
    expect(r.length).toBe(200);
    expect(r.ok).toBe(true);
  });

  it("uses the higher 500 limit for Threads/Facebook", () => {
    expect(NETWORK_LIMITS[SocialNetwork.THREADS]).toBe(500);
    expect(checkContentLength(SocialNetwork.THREADS, "a".repeat(500)).ok).toBe(true);
    expect(checkContentLength(SocialNetwork.FACEBOOK, "a".repeat(501)).ok).toBe(false);
  });

  it("treats empty content as within limit", () => {
    expect(checkContentLength(SocialNetwork.X, "").ok).toBe(true);
  });
});
