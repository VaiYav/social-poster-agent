import { defineStore } from 'pinia';
import { ref } from 'vue';
import api from '../composables/useApi';

interface QueueStats {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

interface FailedJob {
  id: string;
  data: unknown;
  failedReason: string;
  timestamp: number;
}

/**
 * Queue store — BullMQ job stats and failed jobs per network.
 * Used by Queue view.
 */
export const useQueueStore = defineStore('queue', () => {
  const stats = ref<Record<string, QueueStats>>({});
  const failedJobs = ref<Record<string, FailedJob[]>>({});
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function fetchStats(network: string) {
    loading.value = true;
    error.value = null;
    try {
      const res = await api.get(`/queue/${network}/stats`);
      stats.value[network] = res.data;
    } catch (e: unknown) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  async function fetchFailed(network: string) {
    try {
      const res = await api.get(`/queue/${network}/failed`);
      failedJobs.value[network] = res.data;
    } catch (e: unknown) {
      error.value = (e as Error).message;
    }
  }

  async function fetchAll() {
    const networks = ['X', 'THREADS', 'FACEBOOK'];
    await Promise.all(networks.flatMap((n) => [fetchStats(n), fetchFailed(n)]));
  }

  return { stats, failedJobs, loading, error, fetchStats, fetchFailed, fetchAll };
});
