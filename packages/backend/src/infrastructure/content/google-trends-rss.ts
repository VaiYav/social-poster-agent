/**
 * TR1: robust, dependency-free parser for the Google Trends RSS feed.
 *
 * Extracted as a pure function so it can be unit-tested directly. Hardened over the previous
 * inline regex: handles multi-line titles ([\s\S] instead of .), both CDATA and plain <title>,
 * tag attributes (<title type="...">), HTML entities (&amp; &#39; …), and missing traffic/link.
 */
export interface ParsedTrend {
  topic: string;
  rank: number;
  url?: string;
  traffic?: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&'); // decode &amp; last so "&amp;lt;" → "&lt;" not "<"
}

const ITEM_RE = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
const TITLE_RE = /<title\b[^>]*>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))\s*<\/title>/i;
const TRAFFIC_RE = /<ht:approx_traffic>([\s\S]*?)<\/ht:approx_traffic>/i;
const LINK_RE = /<link\b[^>]*>([\s\S]*?)<\/link>/i;

export function parseGoogleTrendsRss(xml: string, limit: number): ParsedTrend[] {
  const out: ParsedTrend[] = [];
  if (!xml || limit <= 0) return out;

  ITEM_RE.lastIndex = 0; // module-level global regex retains state between calls
  let match: RegExpExecArray | null;
  while ((match = ITEM_RE.exec(xml)) !== null && out.length < limit) {
    const itemXml = match[1] ?? '';
    const titleMatch = TITLE_RE.exec(itemXml);
    const rawTitle = (titleMatch?.[1] ?? titleMatch?.[2] ?? '').trim();
    const topic = decodeEntities(rawTitle).replace(/\s+/g, ' ').trim();
    if (!topic) continue;

    const traffic = TRAFFIC_RE.exec(itemXml)?.[1]?.trim();
    const url = LINK_RE.exec(itemXml)?.[1]?.trim();
    out.push({
      topic,
      rank: out.length + 1,
      url: url || undefined,
      traffic: traffic || undefined,
    });
  }
  return out;
}
