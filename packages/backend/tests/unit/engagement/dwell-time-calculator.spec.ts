/**
 * DwellTimeCalculator unit tests.
 *
 * Tests reading time calculation for posts of varying lengths and media.
 *
 * Source: packages/backend/src/modules/engagement/dwell-time-calculator.ts
 */
import { describe, it, expect } from "vitest";
import {
  calculateDwellTimeMs,
  calculateThreadReadTimeMs,
} from "../../../src/modules/engagement/dwell-time-calculator.js";

describe("DwellTimeCalculator", () => {
  // ── calculateDwellTimeMs ──

  it("DT-001: returns minimum 800ms for empty/very short posts", () => {
    const result = calculateDwellTimeMs("", false);
    expect(result).toBeGreaterThanOrEqual(640); // 800 * 0.8 (min jitter)
    expect(result).toBeLessThanOrEqual(960); // 800 * 1.2 (max jitter)
  });

  it("DT-002: scales with word count", () => {
    const short = calculateDwellTimeMs("one two three", false);
    const long = calculateDwellTimeMs(
      "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen",
      false,
    );
    // Long post should generally take longer (accounting for jitter)
    // Use multiple samples to reduce jitter noise
    let shortTotal = 0;
    let longTotal = 0;
    for (let i = 0; i < 20; i++) {
      shortTotal += calculateDwellTimeMs("one two three", false);
      longTotal += calculateDwellTimeMs(
        "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen",
        false,
      );
    }
    expect(longTotal).toBeGreaterThan(shortTotal);
  });

  it("DT-003: adds media viewing time", () => {
    let noMediaTotal = 0;
    let withMediaTotal = 0;
    for (let i = 0; i < 20; i++) {
      noMediaTotal += calculateDwellTimeMs("same text here", false);
      withMediaTotal += calculateDwellTimeMs("same text here", true);
    }
    // Posts with media should take longer on average (3000ms media bonus)
    expect(withMediaTotal).toBeGreaterThan(noMediaTotal);
  });

  it("DT-004: caps at 30 seconds maximum", () => {
    // Very long post (200 words)
    const longText = Array(200).fill("word").join(" ");
    const result = calculateDwellTimeMs(longText, true);
    // 200 words * 150ms = 30000ms base + 3000ms media = 33000, capped at 30000
    // With max jitter 1.2: 30000 * 1.2 = 36000... wait, cap is applied before jitter
    // Actually: min(30000 + 3000, 30000) = 30000, then * 1.2 = 36000
    // Let me re-read the code... cap is on totalMs before jitter
    // totalMs = min(baseReadingMs + mediaMs, 30000) = min(33000, 30000) = 30000
    // then * jitterFactor (0.8-1.2) = 24000-36000
    expect(result).toBeLessThanOrEqual(36000);
    expect(result).toBeGreaterThanOrEqual(24000);
  });

  it("DT-005: produces varied results (jitter)", () => {
    const results = new Set<number>();
    for (let i = 0; i < 10; i++) {
      results.add(calculateDwellTimeMs("test post text here", false));
    }
    // Should produce at least some variation (not all identical)
    expect(results.size).toBeGreaterThan(1);
  });

  // ── calculateThreadReadTimeMs ──

  it("TR-001: returns minimum 2000ms for 0 replies", () => {
    const result = calculateThreadReadTimeMs(0);
    expect(result).toBeGreaterThanOrEqual(1600); // 2000 * 0.8
    expect(result).toBeLessThanOrEqual(2400); // 2000 * 1.2
  });

  it("TR-002: scales with reply count", () => {
    let fewRepliesTotal = 0;
    let manyRepliesTotal = 0;
    for (let i = 0; i < 20; i++) {
      fewRepliesTotal += calculateThreadReadTimeMs(2);
      manyRepliesTotal += calculateThreadReadTimeMs(10);
    }
    expect(manyRepliesTotal).toBeGreaterThan(fewRepliesTotal);
  });

  it("TR-003: caps at 20 seconds maximum", () => {
    const result = calculateThreadReadTimeMs(100);
    // 100 * 1500 = 150000, capped at 20000, * 1.2 = 24000
    expect(result).toBeLessThanOrEqual(24000);
  });
});
