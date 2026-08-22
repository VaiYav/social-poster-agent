/**
 * AN1: parseGraphInsights / extractMetric — pure parser for the Meta Graph /
 * Threads insights envelope. This is the unit-tested core decoupled from live HTTP.
 *
 * Source: packages/backend/src/modules/analytics/metrics-sources/graph-insights.ts
 */
import { describe, it, expect } from "vitest";

import {
  extractMetric,
  parseGraphInsights,
  type InsightMapping,
} from "../../../../src/modules/analytics/metrics-sources/graph-insights.js";

const THREADS: InsightMapping = {
  likes: "likes",
  comments: "replies",
  shares: "reposts",
  impressions: "views",
};

const envelope = {
  data: [
    { name: "views", period: "lifetime", values: [{ value: 1500 }] },
    { name: "likes", period: "lifetime", values: [{ value: 42 }] },
    { name: "replies", period: "lifetime", values: [{ value: 7 }] },
    { name: "reposts", period: "lifetime", total_value: { value: 3 } }, // total_value form
  ],
};

describe("extractMetric (AN1)", () => {
  it("reads a metric from the values[] form (most recent point)", () => {
    expect(
      extractMetric({ data: [{ name: "likes", values: [{ value: 1 }, { value: 9 }] }] }, "likes"),
    ).toBe(9);
  });
  it("reads a metric from the total_value form", () => {
    expect(
      extractMetric({ data: [{ name: "reposts", total_value: { value: 3 } }] }, "reposts"),
    ).toBe(3);
  });
  it("returns null for a missing metric", () => {
    expect(extractMetric(envelope, "clicks")).toBeNull();
  });
  it("returns null for a non-array / malformed payload", () => {
    expect(extractMetric({}, "likes")).toBeNull();
    expect(extractMetric(null, "likes")).toBeNull();
    expect(extractMetric({ data: "oops" }, "likes")).toBeNull();
    expect(extractMetric({ data: [{ name: "likes", values: [] }] }, "likes")).toBeNull();
  });
});

describe("parseGraphInsights (AN1)", () => {
  it("maps a full Threads envelope to PostMetricsData", () => {
    expect(parseGraphInsights(envelope, THREADS)).toEqual({
      likes: 42,
      comments: 7,
      shares: 3,
      impressions: 1500,
    });
  });

  it("defaults missing counts to 0 and impressions to null", () => {
    expect(
      parseGraphInsights({ data: [{ name: "likes", values: [{ value: 5 }] }] }, THREADS),
    ).toEqual({
      likes: 5,
      comments: 0,
      shares: 0,
      impressions: null,
    });
  });

  it("never throws on a garbage payload", () => {
    expect(parseGraphInsights({ nonsense: true }, THREADS)).toEqual({
      likes: 0,
      comments: 0,
      shares: 0,
      impressions: null,
    });
  });

  it("omits impressions (null) when the mapping has no impressions metric", () => {
    const noImpr: InsightMapping = { likes: "likes", comments: "replies", shares: "reposts" };
    expect(parseGraphInsights(envelope, noImpr).impressions).toBeNull();
  });
});
