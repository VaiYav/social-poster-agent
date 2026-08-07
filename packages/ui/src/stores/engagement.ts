/**
 * F1 UI Control Panel: engagement store.
 *
 * Aggregates data from:
 * - REST API (/engagement/scheduler/status, /engagement/stats, /engagement/browsing-sessions)
 * - SSE events (browsing_session_*, interaction_*)
 */
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import api from '../composables/useApi';
import type { SSEvent } from '@spa/shared';

export interface EngagementSchedulerStatus {
  enabled: boolean;
  sessionsPerDay: number;
  windows: string[];
  networks: string[];
  jitterMinutes: number;
  pendingSessions: number;
}

export interface EngagementStats {
  total: number;
  completed: number;
  failed: number;
  byType: Record<string, number>;
}

export interface BrowsingSession {
  id: string;
  network: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  postsViewed: number;
  interactionsCount: number;
  errorMessage?: string | null;
  interactions?: unknown[];
}

export interface Interaction {
  id: string;
  network: string;
  type: string;
  status: string;
  targetUrl: string | null;
  targetHandle: string | null;
  content: string | null;
  createdAt: string;
  completedAt: string | null;
  errorMessage?: string | null;
}

export const useEngagementStore = defineStore('engagement', () => {
  const scheduler = ref<EngagementSchedulerStatus | null>(null);
  const stats = ref<EngagementStats | null>(null);
  const browsingSessions = ref<BrowsingSession[]>([]);
  const interactions = ref<Interaction[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  const isEnabled = computed(() => scheduler.value?.enabled ?? false);
  const isPaused = computed(() => false); // driven by flowControl store for actual pause state

  async function fetchSchedulerStatus() {
    try {
      const { data } = await api.get<EngagementSchedulerStatus>('/engagement/scheduler/status');
      scheduler.value = data;
    } catch (err) {
      error.value = (err as Error).message;
    }
  }

  async function fetchStats(network?: string) {
    try {
      const url = network ? `/engagement/stats?network=${encodeURIComponent(network)}` : '/engagement/stats';
      const { data } = await api.get<EngagementStats>(url);
      stats.value = data;
    } catch (err) {
      error.value = (err as Error).message;
    }
  }

  async function fetchBrowsingSessions(network?: string, limit = 10) {
    try {
      let url = `/engagement/browsing-sessions?limit=${limit}`;
      if (network) url += `&network=${encodeURIComponent(network)}`;
      const { data } = await api.get<BrowsingSession[]>(url);
      browsingSessions.value = data;
    } catch (err) {
      error.value = (err as Error).message;
    }
  }

  async function fetchInteractions(network?: string, limit = 20) {
    try {
      let url = `/engagement/interactions?limit=${limit}`;
      if (network) url += `&network=${encodeURIComponent(network)}`;
      const { data } = await api.get<Interaction[]>(url);
      interactions.value = data;
    } catch (err) {
      error.value = (err as Error).message;
    }
  }

  async function startBrowsingSession(network: string, durationSec = 900) {
    try {
      const { data } = await api.post<BrowsingSession>('/engagement/browsing-session', {
        network,
        durationSec,
      });
      return data;
    } catch (err) {
      error.value = (err as Error).message;
      throw err;
    }
  }

  async function fetchAll(network?: string) {
    loading.value = true;
    error.value = null;
    try {
      await Promise.all([
        fetchSchedulerStatus(),
        fetchStats(network),
        fetchBrowsingSessions(network),
        fetchInteractions(network),
      ]);
    } finally {
      loading.value = false;
    }
  }

  /**
   * Handle SSE events for real-time engagement updates.
   */
  function handleSseEvent(data: SSEvent) {
    if (
      data.type === 'browsing_session_started' ||
      data.type === 'browsing_session_completed' ||
      data.type === 'browsing_session_failed'
    ) {
      void fetchAll(data.network);
    } else if (
      data.type === 'interaction_started' ||
      data.type === 'interaction_completed' ||
      data.type === 'interaction_failed'
    ) {
      void fetchStats(data.network);
      void fetchInteractions(data.network);
    }
  }

  return {
    scheduler,
    stats,
    browsingSessions,
    interactions,
    loading,
    error,
    isEnabled,
    isPaused,
    fetchSchedulerStatus,
    fetchStats,
    fetchBrowsingSessions,
    fetchInteractions,
    startBrowsingSession,
    fetchAll,
    handleSseEvent,
  };
});
