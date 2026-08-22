/**
 * DEP-001 fix: the parser implementation now lives in
 * infrastructure/content/google-trends-rss.ts so that infrastructure adapters
 * can import it without violating the hexagonal dependency direction
 * (infrastructure must not import from modules).
 *
 * This file re-exports for backward compatibility with existing module-level imports.
 */
export {
  parseGoogleTrendsRss,
  type ParsedTrend,
} from "../../infrastructure/content/google-trends-rss.js";
