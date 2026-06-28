/**
 * Analytics store — extended for autonomous metrics, hook performance, and reports.
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { useApi } from '../composables/useApi';

interface AnalyticsSummary {
  totalPosts: number;
  posted: number;
  failed: number;
  pending: number;
  successRate: number;
  byNetwork: Record<string, { total: number; posted: number; failed: number }>;
  last7Days: { date: string; posted: number; failed: number }[];
}

interface TopPost {
  id: string;
  network: string;
  content: string;
  postedAt: string | null;
  postUrl: string | null;
}

interface HookPerformanceStats {
  networks: Record<string, Record<string, {
    avg: number;
    count: number;
    avgQuality: number;
    qualityCount: number;
  }>>;
  lastUpdated: number | null;
}

interface AutonomousStats {
  totalGenerated: number;
  autoApproved: number;
  rejected: number;
  humanReview: number;
  avgQualityScore: number;
  qualityDistribution: { score: number; count: number }[];
  rejectReasons: { reason: string; count: number }[];
}

export const useAnalyticsStore = defineStore('analytics', () => {
  const api = useApi();
  const summary = ref<AnalyticsSummary | null>(null);
  const topPosts = ref<TopPost[]>([]);
  const hookPerformance = ref<HookPerformanceStats | null>(null);
  const autonomousStats = ref<AutonomousStats | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function fetchSummary() {
    try {
      const res = await api.get<AnalyticsSummary>('/analytics/summary');
      summary.value = res.data;
    } catch (err) {
      error.value = (err as Error).message;
    }
  }

  async function fetchTopPosts(limit = 10) {
    try {
      const res = await api.get<TopPost[]>(`/analytics/top-posts?limit=${limit}`);
      topPosts.value = res.data;
    } catch (err) {
      error.value = (err as Error).message;
    }
  }

  async function fetchHookPerformance() {
    try {
      const res = await api.get<HookPerformanceStats>('/analytics/hook-performance');
      hookPerformance.value = res.data;
    } catch (err) {
      error.value = (err as Error).message;
    }
  }

  async function triggerHookAggregation() {
    try {
      await api.post('/analytics/hook-performance/aggregate');
      await fetchHookPerformance();
    } catch (err) {
      error.value = (err as Error).message;
    }
  }

  async function fetchAutonomousStats() {
    try {
      const res = await api.get<AutonomousStats>('/analytics/autonomous');
      autonomousStats.value = res.data;
    } catch {
      // Endpoint may not exist yet — graceful degradation
      autonomousStats.value = null;
    }
  }

  async function fetchAll() {
    loading.value = true;
    error.value = null;
    await Promise.all([
      fetchSummary(),
      fetchTopPosts(),
      fetchHookPerformance(),
      fetchAutonomousStats(),
    ]);
    loading.value = false;
  }

  return {
    summary,
    topPosts,
    hookPerformance,
    autonomousStats,
    loading,
    error,
    fetchSummary,
    fetchTopPosts,
    fetchHookPerformance,
    triggerHookAggregation,
    fetchAutonomousStats,
    fetchAll,
  };
});
