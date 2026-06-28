// DwellTimeCalculator — estimates how long a real human would "read" a post.
//
// Replaces the fixed randomDelay(2000, 5000) in the browsing session with
// content-aware dwell times: longer posts = more reading time, media adds
// viewing time, very short posts get a quick glance.
//
// Based on reading-speed research: average silent reading ~200-250 WPM,
// but social media scanning is faster (~400 WPM for short-form content).

/**
 * Calculate the dwell time (reading time) for a post in milliseconds.
 *
 * @param postText - The text content of the post
 * @param hasMedia - Whether the post has an image/video
 * @returns Dwell time in ms (with human-like jitter)
 */
export function calculateDwellTimeMs(postText: string, hasMedia: boolean): number {
  const wordCount = postText.trim().split(/\s+/).filter(Boolean).length;

  // Base reading time: ~400 WPM for social media scanning = 150ms/word
  const baseReadingMs = Math.max(800, wordCount * 150);

  // Media viewing time: images ~2-4s, videos ~3-6s (use 3s average)
  const mediaMs = hasMedia ? 3000 : 0;

  // Cap at reasonable maximum (no one reads a single post for >30s in a feed)
  const totalMs = Math.min(baseReadingMs + mediaMs, 30_000);

  // Add human-like jitter ±20% (so the same post doesn't always get the same time)
  const jitterFactor = 0.8 + Math.random() * 0.4; // 0.8 to 1.2
  return Math.round(totalMs * jitterFactor);
}

/**
 * Calculate a "re-read" dwell time — when a user opens the comments thread
 * and reads through replies. Longer than initial dwell.
 *
 * @param replyCount - Approximate number of replies to read
 * @returns Dwell time in ms
 */
export function calculateThreadReadTimeMs(replyCount: number): number {
  // ~1.5s per reply (scanning, not full reading)
  const baseMs = Math.max(2000, replyCount * 1500);
  const capped = Math.min(baseMs, 20_000);
  const jitterFactor = 0.8 + Math.random() * 0.4;
  return Math.round(capped * jitterFactor);
}
