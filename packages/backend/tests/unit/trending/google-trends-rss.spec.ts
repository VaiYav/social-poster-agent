/**
 * TR1: parseGoogleTrendsRss() unit tests.
 *
 * Source: packages/backend/src/modules/trending/google-trends-rss.ts
 */
import { describe, it, expect } from 'vitest';

import { parseGoogleTrendsRss } from '../../../src/modules/trending/google-trends-rss.js';

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:ht="https://trends.google.com/trends/trendingsearches/daily">
<channel>
  <title>Daily Search Trends</title>
  <item>
    <title><![CDATA[Tom &amp; Jerry]]></title>
    <ht:approx_traffic>50,000+</ht:approx_traffic>
    <link>https://trends.google.com/a</link>
  </item>
  <item>
    <title type="text">Workflow Trends</title>
    <link>https://trends.google.com/b</link>
  </item>
  <item>
    <title>
      Multi
      line topic
    </title>
  </item>
  <item>
    <title></title>
  </item>
</channel>
</rss>`;

describe('parseGoogleTrendsRss (TR1)', () => {
  it('parses CDATA titles and decodes HTML entities', () => {
    const [first] = parseGoogleTrendsRss(RSS, 10);
    expect(first.topic).toBe('Tom & Jerry');
    expect(first.traffic).toBe('50,000+');
    expect(first.url).toBe('https://trends.google.com/a');
    expect(first.rank).toBe(1);
  });

  it('parses plain titles with tag attributes and missing traffic', () => {
    const trends = parseGoogleTrendsRss(RSS, 10);
    const merc = trends.find((t) => t.topic === 'Workflow Trends');
    expect(merc).toBeDefined();
    expect(merc!.traffic).toBeUndefined();
    expect(merc!.url).toBe('https://trends.google.com/b');
  });

  it('collapses multi-line titles into a clean topic', () => {
    const trends = parseGoogleTrendsRss(RSS, 10);
    expect(trends.some((t) => t.topic === 'Multi line topic')).toBe(true);
  });

  it('skips items with an empty title and excludes the channel-level <title>', () => {
    const trends = parseGoogleTrendsRss(RSS, 10);
    expect(trends.every((t) => t.topic.length > 0)).toBe(true);
    expect(trends.some((t) => t.topic === 'Daily Search Trends')).toBe(false);
    expect(trends).toHaveLength(3); // empty-title item dropped
  });

  it('respects the limit', () => {
    expect(parseGoogleTrendsRss(RSS, 1)).toHaveLength(1);
    expect(parseGoogleTrendsRss(RSS, 2)).toHaveLength(2);
  });

  it('is stable across repeated calls (no leaked regex lastIndex)', () => {
    const a = parseGoogleTrendsRss(RSS, 10);
    const b = parseGoogleTrendsRss(RSS, 10);
    expect(a).toEqual(b);
  });

  it('returns [] for empty / non-matching input', () => {
    expect(parseGoogleTrendsRss('', 10)).toEqual([]);
    expect(parseGoogleTrendsRss('<rss></rss>', 10)).toEqual([]);
    expect(parseGoogleTrendsRss(RSS, 0)).toEqual([]);
  });
});
