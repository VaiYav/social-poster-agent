/**
 * P1-07: IndexNow URL submission service.
 *
 * Submits canonical and syndicated URLs to the IndexNow protocol after a post is
 * published and verified, so search engines can discover and index the POSSE
 * source and its syndicated copies quickly.
 *
 * Uses the official IndexNow endpoint:
 *   POST https://api.indexnow.org/indexnow
 *
 * Payload:
 *   { host, key, keyLocation, urlList }
 *
 * Batches are limited to 10,000 URLs per request per spec.
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

const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';
const MAX_BATCH_SIZE = 10_000;

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
   * @param urls Canonical or syndicated URLs to submit. Duplicates and empty
   *             values are removed; large lists are batched per the 10,000-URL
   *             IndexNow limit.
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

    const list = (Array.isArray(urls) ? urls : [urls])
      .map((u) => u?.trim())
      .filter((u): u is string => Boolean(u));
    const unique = [...new Set(list)];

    if (unique.length === 0) {
      this.logger.debug('IndexNow: no URLs to submit');
      return;
    }

    // Determine host from explicit env or the first URL
    const first = unique[0]!;
    const host = this.host || this.extractHost(first);
    if (!host) {
      this.logger.warn(`IndexNow could not determine host for ${first} — skipping`);
      return;
    }

    const keyLocation = `https://${host}/${this.key}.txt`;

    for (let i = 0; i < unique.length; i += MAX_BATCH_SIZE) {
      const batch = unique.slice(i, i + MAX_BATCH_SIZE);
      await this.submitBatch(host, keyLocation, batch);
    }
  }

  private async submitBatch(host: string, keyLocation: string, urlList: string[]): Promise<void> {
    const payload = { host, key: this.key, keyLocation, urlList };

    try {
      const response = await fetch(INDEXNOW_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload),
      });
      if (response.ok) {
        this.logger.log(`IndexNow: submitted ${urlList.length} URL(s) for host ${host}`);
      } else {
        const body = await response.text().catch(() => '');
        this.logger.warn(`IndexNow ${INDEXNOW_ENDPOINT} returned ${response.status}: ${body.slice(0, 200)}`);
      }
    } catch (err) {
      this.logger.warn(`IndexNow ${INDEXNOW_ENDPOINT} request failed: ${(err as Error).message}`);
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
