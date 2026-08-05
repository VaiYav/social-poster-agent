/**
 * P1-07: IndexNow URL submission service.
 *
 * Submits canonical URLs to Bing and Yandex after a post is published and
 * verified, so search engines can discover and index the POSSE canonical
 * article quickly.
 *
 * Requires:
 *   INDEXNOW_ENABLED=true
 *   INDEXNOW_KEY=<random-key>
 *   INDEXNOW_HOST=<your-domain-or-empty>
 *
 * The key file at https://{host}/{key}.txt must be served by the host.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseBool } from '../config/parse-bool.js';

@Injectable()
export class IndexNowService {
  private readonly logger = new Logger(IndexNowService.name);
  private readonly enabled: boolean;
  private readonly key: string;
  private readonly host: string;

  constructor(private readonly configService: ConfigService) {
    this.enabled = parseBool(this.configService.get<string>('INDEXNOW_ENABLED', 'false'));
    this.key = this.configService.get<string>('INDEXNOW_KEY', '');
    this.host = this.configService.get<string>('INDEXNOW_HOST', '');
  }

  /**
   * Submit one or more URLs to IndexNow-enabled search engines.
   *
   * @param urls Canonical URLs to submit. Only URLs on the configured host
   *             (or the host derived from the first URL) are submitted.
   */
  async submit(urls: string | string[]): Promise<void> {
    if (!this.enabled) {
      this.logger.debug('IndexNow disabled — skipping');
      return;
    }
    if (!this.key) {
      this.logger.warn('IndexNow enabled but INDEXNOW_KEY is empty — skipping');
      return;
    }

    const list = Array.isArray(urls) ? urls : [urls];
    const first = list[0];
    if (!first) return;

    // Determine host from explicit env or the first URL
    const host = this.host || this.extractHost(first);
    if (!host) {
      this.logger.warn(`IndexNow could not determine host for ${first} — skipping`);
      return;
    }

    const payload = { host, key: this.key, urlList: list };
    const endpoints = [
      'https://www.bing.com/indexnow',
      'https://yandex.com/indexnow',
    ];

    for (const endpoint of endpoints) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify(payload),
        });
        if (response.ok) {
          this.logger.log(`IndexNow: submitted ${list.length} URL(s) to ${endpoint} for host ${host}`);
        } else {
          const body = await response.text().catch(() => '');
          this.logger.warn(`IndexNow ${endpoint} returned ${response.status}: ${body.slice(0, 200)}`);
        }
      } catch (err) {
        this.logger.warn(`IndexNow ${endpoint} request failed: ${(err as Error).message}`);
      }
    }
  }

  private extractHost(url: string): string | null {
    try {
      return new URL(url).host;
    } catch {
      return null;
    }
  }
}
