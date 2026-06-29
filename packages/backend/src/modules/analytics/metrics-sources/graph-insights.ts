import type { PostMetricsData } from './metrics-source.port.js';

/**
 * AN1: parse the Meta Graph / Threads **insights** response envelope, which both
 * APIs share:
 *
 *   { "data": [ { "name": "likes", "period": "lifetime",
 *                 "values": [ { "value": 42 } ] }, ... ] }
 *
 * Some metrics return `total_value: { value }` instead of `values: [...]`, so we
 * accept both. Defensive: a missing/!ok/shape-mismatch payload yields a metric of
 * `null`, never throws.
 *
 * Pure + fully unit-tested. The live request URLs/field names + the platform
 * id-resolution (Threads media-id, FB `{pageId}_{postId}`) are verified against
 * real tokens — that's the part this parser is deliberately decoupled from.
 */
type InsightDatum = { name?: unknown; values?: unknown; total_value?: unknown };

export function extractMetric(json: unknown, name: string): number | null {
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) return null;
  const datum = (data as InsightDatum[]).find((d) => d?.name === name);
  if (!datum) return null;

  const total = (datum.total_value as { value?: unknown } | undefined)?.value;
  if (typeof total === 'number') return total;

  if (Array.isArray(datum.values) && datum.values.length > 0) {
    // Take the most recent data point.
    const last = (datum.values as Array<{ value?: unknown }>)[datum.values.length - 1]?.value;
    if (typeof last === 'number') return last;
  }
  return null;
}

/** Map our `PostMetricsData` fields to a network's insight metric names. */
export interface InsightMapping {
  likes: string;
  comments: string;
  shares: string;
  impressions?: string;
}

export function parseGraphInsights(json: unknown, mapping: InsightMapping): PostMetricsData {
  return {
    likes: extractMetric(json, mapping.likes) ?? 0,
    comments: extractMetric(json, mapping.comments) ?? 0,
    shares: extractMetric(json, mapping.shares) ?? 0,
    impressions: mapping.impressions ? extractMetric(json, mapping.impressions) : null,
  };
}
