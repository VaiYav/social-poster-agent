import { Injectable, Logger } from '@nestjs/common';

/**
 * F22: Trending Topic Detection — astrological events calendar.
 *
 * Detects trending astrology topics based on known celestial events
 * (Mercury retrograde, eclipses, planetary ingresses). When an event
 * is "hot" (within ±2 days of peak), it's flagged as trending for
 * priority generation.
 *
 * Future enhancement: integrate Google Trends API + X trending topics
 * for real-time trend detection. For now, the astro calendar provides
 * predictable, high-value trending topics.
 */

interface AstroEvent {
  name: string;
  date: string; // ISO date
  windowDays: number; // how many days before/after the event is "trending"
  topic: string; // suggested generation topic
  networks: ('X' | 'THREADS' | 'FACEBOOK')[]; // recommended networks
}

// Default trending window — how many days before/after an event it's considered "trending".
// Expanded from per-event 3-10 days to a global 30-day window so upcoming astro events
// feed into generation earlier (e.g. Solar Eclipse 45 days out was previously excluded).
const DEFAULT_WINDOW_DAYS = 30;

// Known upcoming astrological events (2026-2027)
// In production, this would be fetched from CAP astro MCP or Swiss Ephemeris
// Past events are filtered out in getTrendingTopics() to avoid stale content.
const ASTRO_EVENTS_2026: AstroEvent[] = [
  {
    name: 'Solar Eclipse (Aug 2026)',
    date: '2026-08-12',
    windowDays: DEFAULT_WINDOW_DAYS,
    topic: 'Solar Eclipse August 2026 — new beginnings and intentions',
    networks: ['X', 'THREADS', 'FACEBOOK'],
  },
  {
    name: 'Mercury Retrograde (Nov 2026)',
    date: '2026-11-09',
    windowDays: DEFAULT_WINDOW_DAYS,
    topic: 'Mercury Retrograde November 2026 — reflection and review',
    networks: ['X', 'THREADS', 'FACEBOOK'],
  },
  {
    name: 'Lunar Eclipse (Dec 2026)',
    date: '2026-12-14',
    windowDays: DEFAULT_WINDOW_DAYS,
    topic: 'Lunar Eclipse December 2026 — emotional release and closure',
    networks: ['X', 'THREADS', 'FACEBOOK'],
  },
  {
    name: 'Saturn enters Aries (Apr 2026)',
    date: '2026-04-12',
    windowDays: DEFAULT_WINDOW_DAYS,
    topic: 'Saturn in Aries — discipline meets initiative, a new 29-year cycle',
    networks: ['X', 'THREADS'],
  },
  {
    name: 'Jupiter enters Cancer (Jun 2026)',
    date: '2026-06-09',
    windowDays: DEFAULT_WINDOW_DAYS,
    topic: 'Jupiter in Cancer — growth through emotional security and home',
    networks: ['X', 'THREADS', 'FACEBOOK'],
  },
  {
    name: 'Pluto enters Aquarius (Mar 2026)',
    date: '2026-03-23',
    windowDays: DEFAULT_WINDOW_DAYS,
    topic: 'Pluto in Aquarius — transformation of technology and collective ideals',
    networks: ['X', 'THREADS'],
  },
  {
    name: 'Mercury Retrograde (Mar 2027)',
    date: '2027-03-15',
    windowDays: DEFAULT_WINDOW_DAYS,
    topic: 'Mercury Retrograde March 2027 — reassess partnerships and communication',
    networks: ['X', 'THREADS', 'FACEBOOK'],
  },
  {
    name: 'Jupiter enters Leo (Jul 2027)',
    date: '2027-07-22',
    windowDays: DEFAULT_WINDOW_DAYS,
    topic: 'Jupiter in Leo — bold self-expression and creative expansion',
    networks: ['X', 'THREADS', 'FACEBOOK'],
  },
  {
    name: 'Solar Eclipse (Aug 2027)',
    date: '2027-08-02',
    windowDays: DEFAULT_WINDOW_DAYS,
    topic: 'Solar Eclipse August 2027 — a powerful new cycle of leadership',
    networks: ['X', 'THREADS', 'FACEBOOK'],
  },
];

export interface TrendingTopic {
  event: string;
  topic: string;
  daysUntil: number; // negative = already passed, 0 = today, positive = upcoming
  trending: boolean; // true if within window
  networks: string[];
  windowDays: number; // used for filtering past events
}

@Injectable()
export class TrendingService {
  private readonly logger = new Logger(TrendingService.name);

  /**
   * Get all known astrological events with trending status.
   * Events within ±windowDays of their date are marked as trending.
   * Past events (beyond their window) are filtered out to avoid stale content.
   */
  getTrendingTopics(): TrendingTopic[] {
    const now = new Date();
    return ASTRO_EVENTS_2026
      .map((event) => {
        const eventDate = new Date(event.date);
        const diffMs = eventDate.getTime() - now.getTime();
        const daysUntil = Math.round(diffMs / (1000 * 60 * 60 * 24));
        const trending = Math.abs(daysUntil) <= event.windowDays;

        return {
          event: event.name,
          topic: event.topic,
          daysUntil,
          trending,
          networks: event.networks,
          windowDays: event.windowDays,
        };
      })
      .filter((t) => t.daysUntil >= -t.windowDays); // drop fully-past events
  }

  /**
   * Get only currently trending topics (within their window).
   * These should be prioritized for generation.
   */
  getActiveTrending(): TrendingTopic[] {
    return this.getTrendingTopics().filter((t) => t.trending);
  }

  /**
   * Get the next upcoming trending topic (for proactive generation).
   */
  getNextUpcoming(): TrendingTopic | null {
    const upcoming = this.getTrendingTopics()
      .filter((t) => t.daysUntil > 0)
      .sort((a, b) => a.daysUntil - b.daysUntil);
    return upcoming[0] ?? null;
  }
}
