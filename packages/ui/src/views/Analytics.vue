<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { BarChart3, TrendingUp, CheckCircle2, XCircle, Activity, ExternalLink, Zap, Award, RefreshCw } from '@lucide/vue';
import { useApi } from '../composables/useApi';
import { useToast } from '../composables/useToast';
import { Card, ProgressBar, Badge, SectionHeader, Button } from '../components/ui';
import StatCard from '../components/StatCard.vue';
import LoadingSpinner from '../components/LoadingSpinner.vue';
import ErrorState from '../components/ErrorState.vue';
import NetworkIcon from '../components/NetworkIcon.vue';
import { BarChart, DoughnutChart } from '../components/charts';

const api = useApi();
const toast = useToast();
const loading = ref(true);
const error = ref<string | null>(null);

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

const summary = ref<AnalyticsSummary | null>(null);
const topPosts = ref<TopPost[]>([]);
const hookPerformance = ref<HookPerformanceStats | null>(null);
const selectedNetwork = ref<'X' | 'THREADS' | 'FACEBOOK'>('X');

const HOOK_TECHNIQUE_LABELS: Record<string, string> = {
  question: 'Question',
  bold: 'Bold',
  counter_intuitive: 'Counter-intuitive',
  story: 'Story',
  data: 'Data',
};

async function loadAnalytics() {
  loading.value = true;
  error.value = null;
  try {
    const [summaryRes, topRes, hookRes] = await Promise.all([
      api.get<AnalyticsSummary>('/analytics/summary'),
      api.get<TopPost[]>('/analytics/top-posts?limit=10'),
      api.get<HookPerformanceStats>('/analytics/hook-performance').catch(() => ({ data: { networks: {}, lastUpdated: null } })),
    ]);
    summary.value = summaryRes.data;
    topPosts.value = topRes.data;
    hookPerformance.value = hookRes.data;
  } catch (err) {
    error.value = (err as Error).message ?? 'Failed to load analytics';
  } finally {
    loading.value = false;
  }
}

onMounted(loadAnalytics);

async function refreshHookStats() {
  try {
    await api.post('/analytics/hook-performance/aggregate');
    toast.success('Hook performance aggregation triggered');
    await loadAnalytics();
  } catch {
    toast.error('Failed to aggregate hook stats');
  }
}

function formatDate(date: string): string {
  return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Chart data: 7-day posting activity
const weeklyChartData = computed(() => {
  if (!summary.value) return { labels: [], datasets: [] };
  return {
    labels: summary.value.last7Days.map(d => formatDate(d.date)),
    datasets: [
      {
        label: 'Posted',
        data: summary.value.last7Days.map(d => d.posted),
        backgroundColor: 'rgba(34, 197, 94, 0.6)',
        borderColor: 'rgba(34, 197, 94, 1)',
        borderWidth: 1,
      },
      {
        label: 'Failed',
        data: summary.value.last7Days.map(d => d.failed),
        backgroundColor: 'rgba(239, 68, 68, 0.6)',
        borderColor: 'rgba(239, 68, 68, 1)',
        borderWidth: 1,
      },
    ],
  };
});

// Chart data: Hook performance (quality score by technique)
const hookQualityChartData = computed(() => {
  if (!hookPerformance.value) return { labels: [], datasets: [] };
  const networkStats = hookPerformance.value.networks[selectedNetwork.value] || {};
  const techniques = Object.keys(HOOK_TECHNIQUE_LABELS);
  return {
    labels: techniques.map(t => HOOK_TECHNIQUE_LABELS[t]),
    datasets: [
      {
        label: 'Avg Quality Score (1-10)',
        data: techniques.map(t => {
          const s = networkStats[t];
          return s && s.qualityCount > 0 ? Number(s.avgQuality.toFixed(1)) : 0;
        }),
        backgroundColor: 'rgba(99, 102, 241, 0.6)',
        borderColor: 'rgba(99, 102, 241, 1)',
        borderWidth: 1,
      },
      {
        label: 'Avg Engagement',
        data: techniques.map(t => {
          const s = networkStats[t];
          return s && s.count > 0 ? Number(s.avg.toFixed(1)) : 0;
        }),
        backgroundColor: 'rgba(234, 179, 8, 0.6)',
        borderColor: 'rgba(234, 179, 8, 1)',
        borderWidth: 1,
      },
    ],
  };
});

// Chart data: Network distribution doughnut
const networkDistributionData = computed(() => {
  if (!summary.value) return { labels: [], datasets: [] };
  const networks = Object.entries(summary.value.byNetwork);
  return {
    labels: networks.map(([n]) => n),
    datasets: [{
      data: networks.map(([, s]) => s.total),
      backgroundColor: ['rgba(99, 102, 241, 0.7)', 'rgba(168, 85, 247, 0.7)', 'rgba(59, 130, 246, 0.7)'],
      borderColor: ['rgba(99, 102, 241, 1)', 'rgba(168, 85, 247, 1)', 'rgba(59, 130, 246, 1)'],
      borderWidth: 1,
    }],
  };
});

const statIcons = {
  total: BarChart3,
  posted: CheckCircle2,
  failed: XCircle,
  rate: TrendingUp,
};
</script>

<template>
  <div>
    <SectionHeader
      title="Analytics"
      description="Posting performance, hook quality feedback loop, and network insights."
    />

    <LoadingSpinner v-if="loading" />
    <ErrorState v-else-if="error" :message="error" />
    <div v-else-if="summary" class="space-y-6">
      <!-- Summary stat cards -->
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total Posts" :value="summary.totalPosts" :icon="statIcons.total" />
        <StatCard label="Posted" :value="summary.posted" :icon="statIcons.posted" color="text-status-posted" />
        <StatCard label="Failed" :value="summary.failed" :icon="statIcons.failed" color="text-status-failed" />
        <StatCard label="Success Rate" :value="`${summary.successRate}%`" :icon="statIcons.rate" color="text-status-approved" />
      </div>

      <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <!-- Weekly activity chart -->
        <Card>
          <template #header>
            <div class="flex items-center gap-2">
              <BarChart3 class="h-5 w-5 text-primary" />
              <h2 class="text-lg font-semibold text-text-primary">Last 7 Days</h2>
            </div>
          </template>
          <div style="height: 200px;">
            <BarChart :data="weeklyChartData" />
          </div>
        </Card>

        <!-- Network distribution doughnut -->
        <Card>
          <template #header>
            <div class="flex items-center gap-2">
              <Activity class="h-5 w-5 text-primary" />
              <h2 class="text-lg font-semibold text-text-primary">Network Distribution</h2>
            </div>
          </template>
          <div style="height: 200px;">
            <DoughnutChart :data="networkDistributionData" />
          </div>
        </Card>
      </div>

      <!-- Per-network breakdown -->
      <Card>
        <template #header>
          <div class="flex items-center gap-2">
            <Activity class="h-5 w-5 text-primary" />
            <h2 class="text-lg font-semibold text-text-primary">Per-Network Breakdown</h2>
          </div>
        </template>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div
            v-for="(stats, network) in summary.byNetwork"
            :key="network"
            class="rounded-lg bg-surface-elevated p-4"
          >
            <div class="flex items-center justify-between">
              <NetworkIcon :network="network" />
              <div class="flex items-center gap-2">
                <Badge variant="success">{{ stats.posted }} posted</Badge>
                <Badge v-if="stats.failed > 0" variant="error">{{ stats.failed }} failed</Badge>
              </div>
            </div>
            <div class="mt-3">
              <ProgressBar
                :value="stats.total > 0 ? (stats.posted / stats.total) * 100 : 0"
                color="success"
                :show-label="false"
              />
            </div>
            <div class="mt-2 flex justify-between text-xs text-text-muted">
              <span>{{ stats.total }} total</span>
              <span>{{ stats.total > 0 ? Math.round((stats.posted / stats.total) * 100) : 0 }}% success</span>
            </div>
          </div>
        </div>
      </Card>

      <!-- Hook Performance (Quality Feedback Loop) -->
      <Card>
        <template #header>
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <Award class="h-5 w-5 text-primary" />
              <div>
                <h2 class="text-lg font-semibold text-text-primary">Hook Performance</h2>
                <p class="text-sm text-text-secondary">Quality feedback loop — which hook techniques produce highest quality content</p>
              </div>
            </div>
            <div class="flex items-center gap-3">
              <select
                v-model="selectedNetwork"
                class="h-9 rounded-md border border-border bg-surface-elevated px-3 text-sm text-text-primary"
              >
                <option value="X">X</option>
                <option value="THREADS">Threads</option>
                <option value="FACEBOOK">Facebook</option>
              </select>
              <Button size="sm" variant="outline" @click="refreshHookStats">
                <RefreshCw class="mr-1 h-3.5 w-3.5" />
                Aggregate
              </Button>
            </div>
          </div>
        </template>

        <div v-if="hookPerformance && hookPerformance.lastUpdated" style="height: 250px;">
          <BarChart :data="hookQualityChartData" />
        </div>
        <div v-else class="py-12 text-center text-text-muted">
          <Zap class="mx-auto mb-3 h-10 w-10 opacity-40" />
          <p>No hook performance data yet.</p>
          <p class="text-sm mt-1">Click "Aggregate" to compute stats from posted content.</p>
        </div>

        <div v-if="hookPerformance && hookPerformance.lastUpdated" class="mt-3 text-xs text-text-muted">
          Last updated: {{ new Date(hookPerformance.lastUpdated).toLocaleString() }}
        </div>
      </Card>

      <!-- Top posts -->
      <Card>
        <template #header>
          <div class="flex items-center gap-2">
            <TrendingUp class="h-5 w-5 text-primary" />
            <h2 class="text-lg font-semibold text-text-primary">Top Recent Posts</h2>
          </div>
        </template>
        <div class="space-y-3">
          <div
            v-for="post in topPosts"
            :key="post.id"
            class="border-b border-border pb-3 last:border-0"
          >
            <div class="flex items-center gap-3 text-xs text-text-muted">
              <NetworkIcon :network="post.network" />
              <span v-if="post.postedAt">{{ formatDate(post.postedAt) }}</span>
              <a
                v-if="post.postUrl"
                :href="post.postUrl"
                target="_blank"
                class="inline-flex items-center gap-1 text-primary hover:text-primary-hover hover:underline"
              >
                <ExternalLink class="h-3 w-3" />
                View
              </a>
            </div>
            <p class="mt-1.5 text-sm text-text-primary line-clamp-2">{{ post.content }}</p>
          </div>
        </div>
      </Card>
    </div>
  </div>
</template>
