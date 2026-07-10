/**
 * Sprint Q: Monitoring store — real-time agent status, queue health, and control.
 *
 * Aggregates data from:
 * - SSE events (post_status, health_alert, generation_progress, replies_monitor)
 * - REST API (/api/v1/health-monitor/dashboard, /api/v1/queue/stats)
 * - Agent control endpoints (pause/resume/stop/restart)
 */
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import api from '../composables/useApi';

export interface QueueStats {
  network: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: boolean;
}

export interface HealthAlert {
  severity: 'critical' | 'warning' | 'info';
  message: string;
  timestamp: number;
}

export interface AgentStatus {
  name: string;
  type: 'cron' | 'worker' | 'scheduler';
  status: 'running' | 'stopped' | 'paused' | 'error';
  lastRun?: string;
  nextRun?: string;
}

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

export const useMonitoringStore = defineStore('monitoring', () => {
  // ── State ──
  const queueStats = ref<QueueStats[]>([]);
  const healthAlerts = ref<HealthAlert[]>([]);
  const agentStatuses = ref<AgentStatus[]>([]);
  const pendingReplies = ref<ReplyPendingItem[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  // Real-time event feed (last 50 events)
  const eventFeed = ref<{ type: string; timestamp: number; data: Record<string, unknown> }[]>([]);

  // ── Computed ──
  const totalFailedJobs = computed(() =>
    queueStats.value.reduce((sum, q) => sum + q.failed, 0),
  );

  const totalWaitingJobs = computed(() =>
    queueStats.value.reduce((sum, q) => sum + q.waiting, 0),
  );

  const criticalAlerts = computed(() =>
    healthAlerts.value.filter((a) => a.severity === 'critical'),
  );

  const pausedQueues = computed(() =>
    queueStats.value.filter((q) => q.paused).map((q) => q.network),
  );

  // ── Actions ──

  async function fetchQueueStats() {
    try {
      const { data } = await api.get('/queue/stats');
      queueStats.value = data;
    } catch (err) {
      error.value = (err as Error).message;
    }
  }

  async function fetchHealthDashboard() {
    try {
      const { data } = await api.get('/health-monitor/dashboard');
      // Extract alerts from health dashboard
      if (data.alerts) {
        healthAlerts.value = data.alerts.map((a: { severity: string; message: string }) => ({
          severity: a.severity as 'critical' | 'warning' | 'info',
          message: a.message,
          timestamp: Date.now(),
        }));
      }
    } catch (err) {
      error.value = (err as Error).message;
    }
  }

  async function fetchPendingReplies() {
    try {
      const { data } = await api.get('/replies/pending');
      pendingReplies.value = data;
    } catch {
      // Replies endpoint may not be available if REPLIES_ENABLED=false
    }
  }

  async function pauseQueue(network: string) {
    try {
      await api.post(`/queue/${network}/pause`);
      const q = queueStats.value.find((q) => q.network === network);
      if (q) q.paused = true;
    } catch (err) {
      error.value = (err as Error).message;
    }
  }

  async function resumeQueue(network: string) {
    try {
      await api.post(`/queue/${network}/resume`);
      const q = queueStats.value.find((q) => q.network === network);
      if (q) q.paused = false;
    } catch (err) {
      error.value = (err as Error).message;
    }
  }

  async function retryFailedJobs(network: string) {
    try {
      await api.post(`/queue/${network}/retry-failed`);
      await fetchQueueStats();
    } catch (err) {
      error.value = (err as Error).message;
    }
  }

  async function triggerGeneration(count = 3) {
    try {
      await api.post('/generation/run', { count });
    } catch (err) {
      error.value = (err as Error).message;
    }
  }

  async function triggerRepliesCycle() {
    try {
      await api.post('/replies/run');
    } catch {
      // Replies endpoint may not be available
    }
  }

  async function manualReply(commentId: string, replyText: string) {
    try {
      await api.post(`/replies/${commentId}/manual-reply`, { replyText });
      pendingReplies.value = pendingReplies.value.filter((r) => r.id !== commentId);
    } catch (err) {
      error.value = (err as Error).message;
    }
  }

  async function dismissReply(commentId: string) {
    try {
      await api.post(`/replies/${commentId}/dismiss`);
      pendingReplies.value = pendingReplies.value.filter((r) => r.id !== commentId);
    } catch (err) {
      error.value = (err as Error).message;
    }
  }

  /**
   * Handle SSE events for real-time monitoring.
   */
  function handleSseEvent(data: { type: string; [key: string]: unknown }) {
    // Metrics snapshots are handled by the agents store; do not spam the live feed.
    if (data.type === 'metrics_snapshot') {
      return;
    }

    // Add to event feed
    eventFeed.value.unshift({ type: data.type, timestamp: Date.now(), data });
    if (eventFeed.value.length > 50) eventFeed.value.pop();

    // Handle specific event types
    if (data.type === 'health_alert') {
      healthAlerts.value.unshift({
        severity: (data.severity as 'critical' | 'warning' | 'info') ?? 'warning',
        message: (data.error as string) ?? 'Unknown health alert',
        timestamp: Date.now(),
      });
    }

    if (data.type === 'replies_monitor') {
      // Refresh pending replies when a monitoring cycle completes
      void fetchPendingReplies();
    }
  }

  async function fetchAll() {
    loading.value = true;
    error.value = null;
    try {
      await Promise.allSettled([
        fetchQueueStats(),
        fetchHealthDashboard(),
        fetchPendingReplies(),
      ]);
    } finally {
      loading.value = false;
    }
  }

  return {
    // State
    queueStats,
    healthAlerts,
    agentStatuses,
    pendingReplies,
    loading,
    error,
    eventFeed,
    // Computed
    totalFailedJobs,
    totalWaitingJobs,
    criticalAlerts,
    pausedQueues,
    // Actions
    fetchQueueStats,
    fetchHealthDashboard,
    fetchPendingReplies,
    pauseQueue,
    resumeQueue,
    retryFailedJobs,
    triggerGeneration,
    triggerRepliesCycle,
    manualReply,
    dismissReply,
    handleSseEvent,
    fetchAll,
  };
});
