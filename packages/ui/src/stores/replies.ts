/**
 * Sprint Q: Replies store — human-review queue and reply monitoring controls.
 *
 * Aggregates data from:
 * - REST API (/api/v1/replies/pending, /api/v1/replies/stats)
 * - SSE events (replies_monitor, reply_posted)
 */
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import api from '../composables/useApi';
import type { SSEvent } from '@spa/shared';

export interface ReplyPendingItem {
  id: string;
  postId: string;
  network: string;
  author: string;
  text: string;
  humanReviewReason: string | null;
  replyText: string | null;
  scrapedAt: string;
}

export interface RepliesStats {
  enabled: boolean;
  counts: {
    new: number;
    replied: number;
    skipped: number;
    humanReview: number;
    repliedManual: number;
  };
  pendingReview: number;
}

export interface RepliesCycleStats {
  postsChecked: number;
  commentsScraped: number;
  repliesPosted: number;
  repliesScheduled: number;
  humanReview: number;
}

export const useRepliesStore = defineStore('replies', () => {
  // ── State ──
  const pending = ref<ReplyPendingItem[]>([]);
  const stats = ref<RepliesStats | null>(null);
  const lastCycle = ref<RepliesCycleStats | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  // ── Computed ──
  const isEnabled = computed(() => stats.value?.enabled ?? false);
  const pendingCount = computed(() => pending.value.length);

  // ── Actions ──

  async function fetchPending() {
    try {
      const { data } = await api.get('/replies/pending');
      pending.value = data;
    } catch (err) {
      error.value = (err as Error).message;
    }
  }

  async function fetchStats() {
    try {
      const { data } = await api.get('/replies/stats');
      stats.value = data;
    } catch (err) {
      error.value = (err as Error).message;
    }
  }

  async function manualReply(commentId: string, replyText: string) {
    try {
      await api.post(`/replies/${commentId}/manual-reply`, { replyText });
      pending.value = pending.value.filter((r) => r.id !== commentId);
      if (stats.value) {
        stats.value.counts.humanReview = Math.max(0, stats.value.counts.humanReview - 1);
        stats.value.counts.repliedManual += 1;
        stats.value.pendingReview = Math.max(0, stats.value.pendingReview - 1);
      }
    } catch (err) {
      error.value = (err as Error).message;
    }
  }

  async function dismiss(commentId: string) {
    try {
      await api.post(`/replies/${commentId}/dismiss`);
      pending.value = pending.value.filter((r) => r.id !== commentId);
      if (stats.value) {
        stats.value.counts.humanReview = Math.max(0, stats.value.counts.humanReview - 1);
        stats.value.counts.skipped += 1;
        stats.value.pendingReview = Math.max(0, stats.value.pendingReview - 1);
      }
    } catch (err) {
      error.value = (err as Error).message;
    }
  }

  async function runCycle() {
    try {
      loading.value = true;
      const { data } = await api.post('/replies/run');
      lastCycle.value = data;
      await Promise.all([fetchPending(), fetchStats()]);
    } catch (err) {
      error.value = (err as Error).message;
    } finally {
      loading.value = false;
    }
  }

  async function fetchAll() {
    loading.value = true;
    error.value = null;
    try {
      await Promise.all([fetchPending(), fetchStats()]);
    } finally {
      loading.value = false;
    }
  }

  /**
   * Handle SSE events for real-time reply updates.
   */
  function handleSseEvent(data: SSEvent) {
    if (data.type === 'replies_monitor' || data.type === 'reply_posted') {
      void fetchAll();
    }
  }

  return {
    // State
    pending,
    stats,
    lastCycle,
    loading,
    error,
    // Computed
    isEnabled,
    pendingCount,
    // Actions
    fetchPending,
    fetchStats,
    manualReply,
    dismiss,
    runCycle,
    fetchAll,
    handleSseEvent,
  };
});
