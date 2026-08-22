import { readFileSync } from "fs";
import { Injectable, Logger } from "@nestjs/common";

/**
 * F22: Trending Topic Detection — event calendar.
 *
 * Detects trending topics based on a configurable events list.
 * When an event is "hot" (within ±windowDays of peak), it is flagged as trending
 * for priority generation.
 *
 * By default the events list is empty. Set TRENDING_EVENTS_PATH to load events
 * from a JSON file at startup.
 */

interface CalendarEvent {
  name: string;
  date: string; // ISO date
  windowDays: number; // how many days before/after the event is "trending"
  topic: string; // suggested generation topic
  networks: ("X" | "THREADS" | "FACEBOOK")[]; // recommended networks
}

// Default trending window — how many days before/after an event it is considered "trending".
const DEFAULT_WINDOW_DAYS = 30;

// Configured events list. Empty by default; load from TRENDING_EVENTS_PATH if set.
const EVENTS: CalendarEvent[] = loadEvents();

function loadEvents(): CalendarEvent[] {
  const path = process.env.TRENDING_EVENTS_PATH;
  if (!path) return [];
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as CalendarEvent[];
  } catch {
    return [];
  }
}

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
   * Get all known events with trending status.
   * Events within ±windowDays of their date are marked as trending.
   * Past events (beyond their window) are filtered out to avoid stale content.
   */
  getTrendingTopics(): TrendingTopic[] {
    const now = new Date();
    return EVENTS.map((event) => {
      const eventDate = new Date(event.date);
      const diffMs = eventDate.getTime() - now.getTime();
      const daysUntil = Math.round(diffMs / (1000 * 60 * 60 * 24));
      const windowDays = event.windowDays ?? DEFAULT_WINDOW_DAYS;
      const trending = Math.abs(daysUntil) <= windowDays;

      return {
        event: event.name,
        topic: event.topic,
        daysUntil,
        trending,
        networks: event.networks,
        windowDays,
      };
    }).filter((t) => t.daysUntil >= -t.windowDays); // drop fully-past events
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
