import { defineStore } from 'pinia';
import { ref } from 'vue';
import api from '../composables/useApi';

interface Stats {
  drafts: number;
  posted: number;
  failed: number;
  approved: number;
  rejected: number;
}

interface GenerationRun {
  id: string;
  triggeredBy: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  sourceTopics: string[];
  errorMessage: string | null;
  _count: { posts: number };
}

/**
 * Stats store — dashboard stats + generation run history.
 * Used by Dashboard and Generate views.
 */
export const useStatsStore = defineStore('stats', () => {
  const stats = ref<Stats>({ drafts: 0, posted: 0, failed: 0, approved: 0, rejected: 0 });
  const runs = ref<GenerationRun[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function fetchStats() {
    loading.value = true;
    error.value = null;
    try {
      const [draftRes, postedRes, failedRes, approvedRes, rejectedRes] = await Promise.all([
        api.get('/posts', { params: { status: 'DRAFT', limit: 1 } }),
        api.get('/posts', { params: { status: 'POSTED', limit: 1 } }),
        api.get('/posts', { params: { status: 'FAILED', limit: 1 } }),
        api.get('/posts', { params: { status: 'APPROVED', limit: 1 } }),
        api.get('/posts', { params: { status: 'REJECTED', limit: 1 } }),
      ]);
      stats.value = {
        drafts: draftRes.data.total,
        posted: postedRes.data.total,
        failed: failedRes.data.total,
        approved: approvedRes.data.total,
        rejected: rejectedRes.data.total,
      };
    } catch (e: unknown) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  async function fetchRuns(limit = 20) {
    try {
      const res = await api.get('/generation/runs', { params: { limit } });
      runs.value = res.data;
    } catch (e: unknown) {
      error.value = (e as Error).message;
    }
  }

  async function triggerGeneration(count: number, networks: string[], sourceType: string) {
    const res = await api.post('/generation/run', { count, networks, sourceType });
    await fetchRuns();
    return res.data;
  }

  return { stats, runs, loading, error, fetchStats, fetchRuns, triggerGeneration };
});
