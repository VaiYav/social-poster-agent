// TargetingService — rotates engagement sources for realistic browsing patterns.
//
// A real user doesn't only scroll their home feed — they check hashtags,
// visit competitor profiles, browse Explore/For You, and check notifications.
// This service provides source rotation so browsing sessions vary their
// entry points across sessions.
//
// Sources:
//   1. home-feed — the default algorithmic feed
//   2. hashtag — #astrology #horoscope #zodiac (configurable list)
//   3. competitor — Co-Star, The Pattern, Sanctuary profiles
//   4. explore — Explore / For You page
//   5. notifications — check who interacted with us

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SocialNetwork } from '@spa/shared';
import type { EngagementSource } from '../../domain/ports/engagement-decision.port.js';

/**
 * A targeting source with its URL and metadata.
 */
export interface TargetSource {
  source: EngagementSource;
  /** URL to navigate to for this source. */
  url: string;
  /** Human-readable label for logging. */
  label: string;
  /** Hashtag (if source is 'hashtag'). */
  hashtag?: string;
  /** Competitor handle (if source is 'competitor'). */
  competitorHandle?: string;
}

@Injectable()
export class TargetingService {
  private readonly logger = new Logger(TargetingService.name);
  private readonly hashtags: string[];
  private readonly competitors: string[];
  private readonly sourceWeights: Record<EngagementSource, number>;

  constructor(private readonly configService: ConfigService) {
    this.hashtags = this.parseList(
      // Multilingual hashtags — covers English, Russian, Ukrainian, Spanish, Italian markets.
      // Mixed feed: each browsing session picks a random hashtag, so the agent engages
      // with posts in different languages and replies in the same language as the post.
      this.configService.get<string>(
        'ENGAGEMENT_HASHTAGS',
        '#astrology,#horoscope,#zodiac,#astrologytips,#moonsign,' + // English
        '#астрология,#гороскоп,#зодиак,#лунавзнаке,' +             // Russian
        '#астрологія,#гороскоп,#зодіак,#місяцьвзнаку,' +           // Ukrainian
        '#astrologia,#horoscopo,#zodiaco,#lunaensigno,' +          // Spanish
        '#astrologia,#oroscopo,#zodiaco,#lunanelsegno',            // Italian
      ),
    );
    this.competitors = this.parseList(
      this.configService.get<string>('ENGAGEMENT_COMPETITORS', 'costarastrology,thepatternapp,sanctuaryworldco'),
    );
    this.sourceWeights = {
      'home-feed': this.configService.get<number>('ENGAGEMENT_WEIGHT_HOME_FEED', 40),
      'hashtag': this.configService.get<number>('ENGAGEMENT_WEIGHT_HASHTAG', 25),
      'competitor': this.configService.get<number>('ENGAGEMENT_WEIGHT_COMPETITOR', 15),
      'explore': this.configService.get<number>('ENGAGEMENT_WEIGHT_EXPLORE', 10),
      'notifications': this.configService.get<number>('ENGAGEMENT_WEIGHT_NOTIFICATIONS', 10),
    };
  }

  /**
   * Pick a target source for a browsing session using weighted random.
   * Different sessions will start from different entry points.
   *
   * P0: when `conversationReady` is true, boost the 'notifications' source so the
   * agent checks existing interactions instead of only the algorithmic feed.
   */
  pickSource(network: SocialNetwork, opts: { conversationReady?: boolean } = {}): TargetSource {
    const sources = this.getAvailableSources(network);
    const conversationReady = !!opts.conversationReady;
    const conversationBoost = conversationReady ? 5 : 1;

    const totalWeight = sources.reduce((sum, s) => {
      const base = this.sourceWeights[s.source];
      const boost = s.source === 'notifications' ? conversationBoost : 1;
      return sum + base * boost;
    }, 0);
    let random = Math.random() * totalWeight;

    for (const source of sources) {
      const boost = source.source === 'notifications' ? conversationBoost : 1;
      random -= this.sourceWeights[source.source] * boost;
      if (random <= 0) {
        this.logger.debug(`Picked source: ${source.label} for ${network} (conversationReady=${conversationReady})`);
        return source;
      }
    }

    // Fallback to home feed
    return sources[0]!;
  }

  /**
   * Get all available sources for a network.
   * Some sources may not be available on all networks (e.g. Explore is X-only).
   */
  getAvailableSources(network: SocialNetwork): TargetSource[] {
    const sources: TargetSource[] = [];

    // Home feed — always available
    sources.push({
      source: 'home-feed',
      url: this.getHomeFeedUrl(network),
      label: 'Home Feed',
    });

    // Hashtags — pick a random one for this session
    if (this.hashtags.length > 0) {
      const hashtag = this.hashtags[Math.floor(Math.random() * this.hashtags.length)]!;
      sources.push({
        source: 'hashtag',
        url: this.getHashtagUrl(network, hashtag),
        label: `Hashtag ${hashtag}`,
        hashtag,
      });
    }

    // Competitors — pick a random one
    if (this.competitors.length > 0) {
      const competitor = this.competitors[Math.floor(Math.random() * this.competitors.length)]!;
      sources.push({
        source: 'competitor',
        url: this.getCompetitorUrl(network, competitor),
        label: `Competitor @${competitor}`,
        competitorHandle: competitor,
      });
    }

    // Explore / For You — X.com has Explore, Threads has search
    if (network === 'X') {
      sources.push({
        source: 'explore',
        url: 'https://x.com/explore',
        label: 'X Explore',
      });
    } else if (network === 'THREADS') {
      sources.push({
        source: 'explore',
        url: 'https://www.threads.com/search?q=astrology',
        label: 'Threads Search',
      });
    }

    // Notifications
    sources.push({
      source: 'notifications',
      url: this.getNotificationsUrl(network),
      label: 'Notifications',
    });

    return sources;
  }

  /**
   * Get the configured hashtags.
   */
  getHashtags(): string[] {
    return [...this.hashtags];
  }

  /**
   * Get the configured competitor handles.
   */
  getCompetitors(): string[] {
    return [...this.competitors];
  }

  // ── URL Builders ────────────────────────────────────────────────────────────

  private getHomeFeedUrl(network: SocialNetwork): string {
    switch (network) {
      case 'X': return 'https://x.com/home';
      case 'THREADS': return 'https://www.threads.com/';
      case 'FACEBOOK': return ''; // FB uses page slug, resolved by engager
      default: return '';
    }
  }

  private getHashtagUrl(network: SocialNetwork, hashtag: string): string {
    const tag = hashtag.replace('#', '');
    switch (network) {
      case 'X': return `https://x.com/search?q=${encodeURIComponent(`#${tag}`)}&f=top`;
      case 'THREADS': return `https://www.threads.com/search?q=${encodeURIComponent(`#${tag}`)}`;
      case 'FACEBOOK': return `https://www.facebook.com/hashtag/${tag}`;
      default: return '';
    }
  }

  private getCompetitorUrl(network: SocialNetwork, handle: string): string {
    switch (network) {
      case 'X': return `https://x.com/${handle}`;
      case 'THREADS': return `https://www.threads.com/@${handle}`;
      case 'FACEBOOK': return `https://www.facebook.com/${handle}`;
      default: return '';
    }
  }

  private getNotificationsUrl(network: SocialNetwork): string {
    switch (network) {
      case 'X': return 'https://x.com/notifications';
      case 'THREADS': return 'https://www.threads.com/activity';
      case 'FACEBOOK': return 'https://www.facebook.com/notifications';
      default: return '';
    }
  }

  private parseList(value: string): string[] {
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
}
