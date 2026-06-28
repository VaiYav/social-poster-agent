/**
 * A1/BUG-12: AutoCheckService is a pure content-safety gate.
 *
 * Verifies the four content checks (engagement-bait, char-limit, forbidden
 * phrases, SimHash dedup) AND — critically — that there is NO quality-score
 * check anymore. The score decision moved entirely to AutoApproveService so the
 * HUMAN_REVIEW band can't be pre-empted by an AutoCheck score floor (BUG-12).
 *
 * Source: packages/backend/src/modules/autonomy/auto-check.service.ts
 */
import { describe, it, expect, vi } from 'vitest';
import { SocialNetwork } from '@prisma/client';

import { AutoCheckService } from '../../../src/modules/autonomy/auto-check.service';

function build(recentPosts: Array<{ simhash: string | null; content: string }> = []) {
  const prisma = {
    post: { findMany: vi.fn().mockResolvedValue(recentPosts) },
  };
  return { service: new AutoCheckService(prisma as never), prisma };
}

const CLEAN = 'Mercury stations direct today — a gentle nudge to revisit what felt stalled.';

describe('AutoCheckService (A1/BUG-12 — pure content-safety gate)', () => {
  it('passes clean content and runs exactly the four content checks', async () => {
    const { service } = build();
    const res = await service.check(CLEAN, SocialNetwork.X);

    expect(res.passed).toBe(true);
    expect(res.checks.map((c) => c.name)).toEqual([
      'engagement_bait',
      'char_limit',
      'forbidden_phrases',
      'simhash_dedup',
    ]);
  });

  it('never emits a quality_score check — score is NOT AutoCheck’s job (BUG-12)', async () => {
    const { service } = build();
    const res = await service.check(CLEAN, SocialNetwork.X);

    expect(res.checks.find((c) => c.name === 'quality_score')).toBeUndefined();
    // check() no longer accepts a score argument at all.
    expect(service.check.length).toBe(2);
  });

  it('fails char_limit when content exceeds the network maximum', async () => {
    const { service } = build();
    const res = await service.check('a'.repeat(281), SocialNetwork.X); // X limit = 280

    expect(res.passed).toBe(false);
    expect(res.rejectionReason).toMatch(/char_limit/);
  });

  it('fails forbidden_phrases on brand-voice violations', async () => {
    const { service } = build();
    const res = await service.check('Here is some financial advice for your sign.', SocialNetwork.THREADS);

    expect(res.passed).toBe(false);
    expect(res.rejectionReason).toMatch(/forbidden_phrases/);
  });

  it('fails simhash_dedup when a near-duplicate exists in recent posts', async () => {
    // loadRecentHashes computes simhash(content) when the stored simhash is null,
    // so an identical recent post yields Hamming distance 0 → duplicate.
    const { service } = build([{ simhash: null, content: CLEAN }]);
    const res = await service.check(CLEAN, SocialNetwork.X);

    expect(res.passed).toBe(false);
    expect(res.rejectionReason).toMatch(/simhash_dedup/);
  });
});
