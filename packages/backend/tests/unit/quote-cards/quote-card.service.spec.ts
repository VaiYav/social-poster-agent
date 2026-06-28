/**
 * QC1: QuoteCardService renders a real PNG (Satori + resvg), end to end.
 *
 * Before the fix Satori was called with `fonts: []` and threw on every render —
 * the feature was dead. This drives the REAL render (no mocks) and asserts a
 * non-empty PNG is produced, proving the bundled Inter font loads.
 *
 * Source: packages/backend/src/modules/quote-cards/quote-card.service.ts
 */
import { describe, it, expect, afterAll } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { QuoteCardService } from '../../../src/modules/quote-cards/quote-card.service';

const OUT_DIR = join(tmpdir(), `spa-qc-test-${Date.now()}`);

function makeConfig(enabled: boolean): ConfigService {
  const map: Record<string, unknown> = {
    QUOTE_CARDS_ENABLED: enabled ? 'true' : 'false',
    QUOTE_CARDS_DIR: OUT_DIR,
    QUOTE_CARD_WIDTH: 240,
    QUOTE_CARD_HEIGHT: 135,
  };
  return { get: (k: string, d?: unknown) => map[k] ?? d } as unknown as ConfigService;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('QuoteCardService (QC1 — real Satori render)', () => {
  afterAll(async () => {
    await fs.rm(OUT_DIR, { recursive: true, force: true }).catch(() => {});
  });

  it('renders a non-empty PNG to disk when enabled', async () => {
    const service = new QuoteCardService(makeConfig(true));

    const filepath = await service.generateQuoteCard(
      'Mercury stations direct — revisit what felt stalled.',
      { author: 'Cosmic Insights' },
    );

    expect(filepath).toBeTruthy();
    expect(filepath!.endsWith('.png')).toBe(true);
    const buf = await fs.readFile(filepath!);
    expect(buf.length).toBeGreaterThan(0);
    expect(buf.subarray(0, 8)).toEqual(PNG_MAGIC); // valid PNG header
  });

  it('returns null without rendering when disabled', async () => {
    const service = new QuoteCardService(makeConfig(false));
    expect(await service.generateQuoteCard('anything')).toBeNull();
  });
});
