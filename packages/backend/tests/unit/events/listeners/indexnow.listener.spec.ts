import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { IndexNowListener } from '../../../../src/events/listeners/indexnow.listener';
import type { IndexNowService } from '../../../../src/infrastructure/indexnow/indexnow.service';
import type { PostVerifiedEvent } from '../../../../src/events/post-verified.event';

function createConfigService(enabled: string): ConfigService {
  return { get: (key: string) => key === 'INDEXNOW_ENABLED' ? enabled : '' } as unknown as ConfigService;
}

function createMockIndexNowService(): IndexNowService {
  return {
    submit: vi.fn().mockResolvedValue(undefined),
  } as unknown as IndexNowService;
}

describe('P1-07: IndexNowListener', () => {
  it('does nothing when IndexNow is disabled', async () => {
    const indexNow = createMockIndexNowService();
    const listener = new IndexNowListener(createConfigService('false'), indexNow);

    const payload: PostVerifiedEvent = {
      postId: 'post-1',
      network: 'DEVTO',
      postUrl: 'https://dev.to/testuser/post-1',
    };

    await listener.handlePostVerified(payload);
    expect(indexNow.submit).not.toHaveBeenCalled();
  });

  it('submits canonical + syndicated URLs from the POST_VERIFIED payload', async () => {
    const indexNow = createMockIndexNowService();
    const listener = new IndexNowListener(createConfigService('true'), indexNow);

    const payload: PostVerifiedEvent = {
      postId: 'post-1',
      network: 'DEVTO',
      postUrl: 'https://dev.to/testuser/post-1',
      canonicalUrl: 'https://example.com/blog/post-1',
      syndicatedUrl: 'https://dev.to/testuser/post-1',
      contentType: 'ARTICLE',
    };

    await listener.handlePostVerified(payload);
    expect(indexNow.submit).toHaveBeenCalledWith([
      'https://example.com/blog/post-1',
      'https://dev.to/testuser/post-1',
    ]);
  });

  it('falls back to postUrl when canonical and syndicated are missing', async () => {
    const indexNow = createMockIndexNowService();
    const listener = new IndexNowListener(createConfigService('true'), indexNow);

    const payload: PostVerifiedEvent = {
      postId: 'post-2',
      network: 'X',
      postUrl: 'https://x.com/testuser/status/123',
    };

    await listener.handlePostVerified(payload);
    expect(indexNow.submit).toHaveBeenCalledWith(['https://x.com/testuser/status/123']);
  });

  it('does not throw or call submit when no URL is present', async () => {
    const indexNow = createMockIndexNowService();
    const listener = new IndexNowListener(createConfigService('true'), indexNow);

    const payload: PostVerifiedEvent = {
      postId: 'post-3',
      network: 'X',
    };

    await expect(listener.handlePostVerified(payload)).resolves.toBeUndefined();
    expect(indexNow.submit).not.toHaveBeenCalled();
  });
});
