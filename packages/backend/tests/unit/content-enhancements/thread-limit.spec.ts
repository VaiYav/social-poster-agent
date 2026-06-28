/**
 * AU8: truncateForThread() unit tests.
 *
 * Source: packages/backend/src/modules/content-enhancements/thread-limit.ts
 */
import { describe, it, expect } from 'vitest';

import { truncateForThread } from '../../../src/modules/content-enhancements/thread-limit';

describe('truncateForThread (AU8)', () => {
  it('leaves content within the limit unchanged', () => {
    expect(truncateForThread('short tweet', 280)).toBe('short tweet');
  });

  it('truncates over-limit content to <= limit code points with an ellipsis', () => {
    const out = truncateForThread('word '.repeat(100), 280);
    expect([...out].length).toBeLessThanOrEqual(280);
    expect(out.endsWith('…')).toBe(true);
  });

  it('cuts at a word boundary when possible', () => {
    const out = truncateForThread('alpha beta gamma delta', 12);
    expect(out).toBe('alpha beta…');
    expect([...out].length).toBeLessThanOrEqual(12);
  });

  it('counts by Unicode code points (emoji not over-counted)', () => {
    const out = truncateForThread('🌙'.repeat(300), 280);
    expect([...out].length).toBeLessThanOrEqual(280);
  });

  it('handles empty input', () => {
    expect(truncateForThread('', 280)).toBe('');
  });
});
