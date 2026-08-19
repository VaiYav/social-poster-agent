import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// Mock the axios API client before importing the store
vi.mock('../../src/composables/useApi', () => {
  const api = {
    get: vi.fn(),
    post: vi.fn(),
  };
  return { default: api, useApi: () => api };
});

import { useRepliesStore } from '../../src/stores/replies';
import api from '../../src/composables/useApi';

describe('replies store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('initial state is empty and not loading', () => {
    const store = useRepliesStore();
    expect(store.pending).toEqual([]);
    expect(store.stats).toBeNull();
    expect(store.loading).toBe(false);
    expect(store.error).toBeNull();
    expect(store.isEnabled).toBe(false);
    expect(store.pendingCount).toBe(0);
  });

  it('fetchPending populates pending comments', async () => {
    const pendingData = [
      {
        id: 'c1',
        postId: 'p1',
        network: 'X',
        author: 'alice',
        text: 'When is the next product release?',
        humanReviewReason: 'question',
        replyText: null,
        scrapedAt: '2026-08-06T18:00:00.000Z',
      },
    ];
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: pendingData });

    const store = useRepliesStore();
    await store.fetchPending();

    expect(api.get).toHaveBeenCalledWith('/replies/pending');
    expect(store.pending).toEqual(pendingData);
    expect(store.pendingCount).toBe(1);
  });

  it('fetchStats populates stats and enabled flag', async () => {
    const statsData = {
      enabled: true,
      counts: { new: 5, replied: 3, skipped: 1, humanReview: 2, repliedManual: 1 },
      pendingReview: 2,
    };
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: statsData });

    const store = useRepliesStore();
    await store.fetchStats();

    expect(api.get).toHaveBeenCalledWith('/replies/stats');
    expect(store.stats).toEqual(statsData);
    expect(store.isEnabled).toBe(true);
  });

  it('manualReply posts and removes comment from pending', async () => {
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [] });
    (api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { success: true } });

    const store = useRepliesStore();
    store.stats = {
      enabled: true,
      counts: { new: 0, replied: 0, skipped: 0, humanReview: 1, repliedManual: 0 },
      pendingReview: 1,
    };
    store.pending = [
      {
        id: 'c1',
        postId: 'p1',
        network: 'X',
        author: 'alice',
        text: 'Hello',
        humanReviewReason: null,
        replyText: null,
        scrapedAt: '2026-08-06T18:00:00.000Z',
      },
    ];

    await store.manualReply('c1', 'Hi there!');

    expect(api.post).toHaveBeenCalledWith('/replies/c1/manual-reply', { replyText: 'Hi there!' });
    expect(store.pending).toEqual([]);
    expect(store.stats?.counts.humanReview).toBe(0);
    expect(store.stats?.counts.repliedManual).toBe(1);
    expect(store.stats?.pendingReview).toBe(0);
  });

  it('dismiss posts and removes comment from pending', async () => {
    (api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { success: true } });

    const store = useRepliesStore();
    store.stats = {
      enabled: true,
      counts: { new: 0, replied: 0, skipped: 0, humanReview: 1, repliedManual: 0 },
      pendingReview: 1,
    };
    store.pending = [
      {
        id: 'c1',
        postId: 'p1',
        network: 'X',
        author: 'alice',
        text: 'Spam',
        humanReviewReason: 'troll',
        replyText: null,
        scrapedAt: '2026-08-06T18:00:00.000Z',
      },
    ];

    await store.dismiss('c1');

    expect(api.post).toHaveBeenCalledWith('/replies/c1/dismiss');
    expect(store.pending).toEqual([]);
    expect(store.stats?.counts.humanReview).toBe(0);
    expect(store.stats?.counts.skipped).toBe(1);
    expect(store.stats?.pendingReview).toBe(0);
  });

  it('runCycle triggers monitoring cycle and refreshes data', async () => {
    const cycleData = { postsChecked: 1, commentsScraped: 2, repliesPosted: 0, repliesScheduled: 0, humanReview: 1 };
    (api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: cycleData });
    (api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) =>
      url === '/replies/pending'
        ? Promise.resolve({ data: [] })
        : Promise.resolve({
            data: {
              enabled: true,
              counts: { new: 0, replied: 0, skipped: 0, humanReview: 0, repliedManual: 0 },
              pendingReview: 0,
            },
          }),
    );

    const store = useRepliesStore();
    await store.runCycle();

    expect(api.post).toHaveBeenCalledWith('/replies/run');
    expect(store.lastCycle).toEqual(cycleData);
    expect(api.get).toHaveBeenCalledWith('/replies/pending');
    expect(api.get).toHaveBeenCalledWith('/replies/stats');
  });

  it('fetchAll fetches both pending and stats', async () => {
    (api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) =>
      url === '/replies/pending'
        ? Promise.resolve({ data: [] })
        : Promise.resolve({
            data: {
              enabled: true,
              counts: { new: 0, replied: 0, skipped: 0, humanReview: 0, repliedManual: 0 },
              pendingReview: 0,
            },
          }),
    );

    const store = useRepliesStore();
    await store.fetchAll();

    expect(api.get).toHaveBeenCalledWith('/replies/pending');
    expect(api.get).toHaveBeenCalledWith('/replies/stats');
    expect(store.loading).toBe(false);
  });

  it('sets error on failed API call', async () => {
    (api.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network down'));

    const store = useRepliesStore();
    await store.fetchAll();

    expect(store.error).toBe('Network down');
    expect(store.loading).toBe(false);
  });
});
