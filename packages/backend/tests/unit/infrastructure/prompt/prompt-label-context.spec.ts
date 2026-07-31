/**
 * PromptLabelContext unit tests.
 *
 * Source: packages/backend/src/infrastructure/prompt/prompt-label-context.ts
 */
import { describe, it, expect, vi } from 'vitest';
import {
  withPromptLabelContext,
  recordPromptLabel,
  getRecordedPromptLabels,
} from '../../../../src/infrastructure/prompt/prompt-label-context.js';

describe('PromptLabelContext', () => {
  it('records prompt labels inside withPromptLabelContext', async () => {
    await withPromptLabelContext(async () => {
      recordPromptLabel('research-extract', '0.4.0', false);
      recordPromptLabel('draft-post', 'experimental', false);

      expect(getRecordedPromptLabels()).toEqual({
        'research-extract': { label: '0.4.0', isFallback: false },
        'draft-post': { label: 'experimental', isFallback: false },
      });
    });
  });

  it('returns an empty map outside of any context', () => {
    expect(getRecordedPromptLabels()).toEqual({});
  });

  it('isolates contexts from each other', async () => {
    const runA = withPromptLabelContext(async () => {
      recordPromptLabel('draft-post', 'v1');
      return getRecordedPromptLabels();
    });

    const runB = withPromptLabelContext(async () => {
      recordPromptLabel('draft-post', 'v2');
      return getRecordedPromptLabels();
    });

    const [labelsA, labelsB] = await Promise.all([runA, runB]);
    expect(labelsA).toEqual({ 'draft-post': { label: 'v1' } });
    expect(labelsB).toEqual({ 'draft-post': { label: 'v2' } });
  });

  it('overwrites the same prompt with the last recorded label', async () => {
    await withPromptLabelContext(async () => {
      recordPromptLabel('draft-post', 'v1');
      recordPromptLabel('draft-post', 'v2');

      expect(getRecordedPromptLabels()).toEqual({
        'draft-post': { label: 'v2' },
      });
    });
  });
});
