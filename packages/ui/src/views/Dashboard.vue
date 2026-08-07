<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import {
  FileText,
  CheckCircle,
  CheckCircle2,
  XCircle,
  Ban,
  ArrowRight,
  Zap,
  Pause,
  Play,
  AlertTriangle,
  Award,
  Bot,
  TrendingUp,
  Flame,
  RefreshCw,
} from '@lucide/vue';
import { usePostsStore } from '../stores/posts';
import { useStatsStore } from '../stores/stats';
import { useAgentsStore } from '../stores/agents';
import { useMonitoringStore } from '../stores/monitoring';
import { useApi } from '../composables/useApi';
import { Card, Button, SectionHeader, Badge } from '../components/ui';
import StatCard from '../components/StatCard.vue';
import PostCard from '../components/PostCard.vue';
import LoadingSpinner from '../components/LoadingSpinner.vue';
import ErrorState from '../components/ErrorState.vue';
import AgentGrid from '../components/agents/AgentGrid.vue';
import LiveEventFeed from '../components/agents/LiveEventFeed.vue';
import { useRouter } from 'vue-router';

const postsStore = usePostsStore();
const statsStore = useStatsStore();
const agentsStore = useAgentsStore();
const monitoringStore = useMonitoringStore();
const router = useRouter();
const api = useApi();

// Flow control + autonomous status
interface FlowControlState {
  generationPaused: boolean;
  postingPaused: boolean;
  engagementPaused: boolean;
  repliesPaused: boolean;
  crisisMode: boolean;
}
const flowState = ref<FlowControlState | null>(null);
const avgQualityScore = ref<number | null>(null);
const autonomousRuns = ref<number | null>(null);

onMounted(async () => {
  await Promise.all([
    statsStore.fetchStats(),
    statsStore.fetchTrending(),
    statsStore.fetchMergedTrends(),
    postsStore.fetchPosts({ limit: 5 }),
    fetchFlowControl(),
    fetchQualityMetrics(),
  ]);
});

async function fetchFlowControl() {
  try {
    const res = await api.get<FlowControlState>('/flow-control/state');
    flowState.value = res.data;
  } catch {
    // Endpoint may not exist in all environments
  }
}

async function fetchQualityMetrics() {
  try {
    // Fetch hook performance to get avg quality
    const res = await api.get<{
      networks: Record<string, Record<string, { avgQuality: number; qualityCount: number }>>;
      lastUpdated: number | null;
    }>('/analytics/hook-performance');
    if (res.data.lastUpdated) {
      // Compute weighted average quality across all networks
      let totalScore = 0;
      let totalCount = 0;
      for (const networkStats of Object.values(res.data.networks)) {
        for (const stats of Object.values(networkStats)) {
          if (stats.qualityCount > 0) {
            totalScore += stats.avgQuality * stats.qualityCount;
            totalCount += stats.qualityCount;
          }
        }
      }
      avgQualityScore.value = totalCount > 0 ? totalScore / totalCount : null;
    }
  } catch {
    // Graceful degradation
  }
}

const allPaused = computed(() => {
  if (!flowState.value) return false;
  return flowState.value.crisisMode ||
    (flowState.value.generationPaused && flowState.value.postingPaused);
});

const sourceLabels: Record<string, string> = {
  astro: 'Astro',
  google_trends: 'Google',
  x_trends: 'X',
};

function formatSources(sources: string[]) {
  return sources.map((s) => sourceLabels[s] ?? s).join(' · ');
}

// F22: show merged real-time trends when available, fall back to astro-only active trends.
const activeTrends = computed(() => {
  if (statsStore.mergedTrending.length > 0) {
    return statsStore.mergedTrending.slice(0, 5).map((t) => ({
      type: 'merged' as const,
      title: t.topic,
      subtitle: formatSources(t.sources),
      priority: t.priority,
      networks: t.networks,
    }));
  }
  return statsStore.trending.filter((t) => t.trending).slice(0, 5).map((t) => ({
    type: 'astro' as const,
    title: t.event,
    subtitle: t.topic,
    daysUntil: t.daysUntil,
    networks: t.networks,
  }));
});

const upcomingTrends = computed(() =>
  statsStore.trending.filter((t) => !t.trending && t.daysUntil > 0 && t.daysUntil <= 14).slice(0, 5),
);

const statItems = [
  { label: 'Drafts', value: 'drafts', icon: FileText, color: 'text-status-draft' },
  { label: 'Approved', value: 'approved', icon: CheckCircle, color: 'text-status-approved' },
  { label: 'Posted', value: 'posted', icon: CheckCircle2, color: 'text-status-posted' },
  { label: 'Failed', value: 'failed', icon: XCircle, color: 'text-status-failed' },
  { label: 'Rejected', value: 'rejected', icon: Ban, color: 'text-status-rejected' },
] as const;
</script>

<template>
  <div>
    <SectionHeader
      title="Dashboard"
      description="Overview of your content pipeline, autonomous status, and recent activity."
    />

    <!-- Crisis mode banner -->
    <div
      v-if="allPaused"
      class="mb-6 flex items-center gap-3 rounded-lg border border-error/30 bg-error/10 p-4"
    >
      <AlertTriangle class="h-5 w-5 text-error" />
      <div class="flex-1">
        <p class="font-medium text-error">All flows paused</p>
        <p class="text-sm text-text-secondary">
          {{ flowState?.crisisMode ? 'Crisis mode is active.' : 'Generation and posting are paused.' }}
        </p>
      </div>
      <Button size="sm" variant="outline" @click="router.push('/flow-control')">
        Manage
        <ArrowRight class="h-4 w-4" />
      </Button>
    </div>

    <LoadingSpinner v-if="statsStore.loading" />
    <ErrorState v-else-if="statsStore.error" :message="statsStore.error" />
    <template v-else>
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard
          v-for="item in statItems"
          :key="item.value"
          :label="item.label"
          :value="statsStore.stats[item.value]"
          :icon="item.icon"
          :color="item.color"
        />
      </div>
    </template>

    <!-- Autonomous + Quality mini widgets -->
    <div class="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
      <!-- Avg Quality Score -->
      <Card>
        <div class="flex items-center gap-3">
          <div class="rounded-lg bg-primary/10 p-3">
            <Award class="h-6 w-6 text-primary" />
          </div>
          <div>
            <p class="text-sm text-text-secondary">Avg Quality Score</p>
            <p class="text-2xl font-bold text-text-primary">
              {{ avgQualityScore !== null ? avgQualityScore.toFixed(1) : '—' }}
              <span class="text-sm font-normal text-text-muted">/ 10</span>
            </p>
          </div>
        </div>
      </Card>

      <!-- Autonomous Status -->
      <Card>
        <div class="flex items-center gap-3">
          <div class="rounded-lg bg-primary/10 p-3">
            <Bot class="h-6 w-6 text-primary" />
          </div>
          <div>
            <p class="text-sm text-text-secondary">Autonomous Mode</p>
            <div class="flex items-center gap-2">
              <Badge :variant="flowState && !allPaused ? 'success' : 'warning'">
                {{ flowState && !allPaused ? 'Active' : 'Paused' }}
              </Badge>
              <Button size="sm" variant="ghost" @click="router.push('/flow-control')">
                Configure
              </Button>
            </div>
          </div>
        </div>
      </Card>

      <!-- Flow Control Quick -->
      <Card>
        <div class="flex items-center gap-3">
          <div class="rounded-lg bg-primary/10 p-3">
            <Zap class="h-6 w-6 text-primary" />
          </div>
          <div class="flex-1">
            <p class="text-sm text-text-secondary">Flow Status</p>
            <div class="flex flex-wrap gap-1.5 mt-1">
              <Badge v-if="flowState" :variant="flowState.generationPaused ? 'warning' : 'success'" class="text-xs">
                Gen {{ flowState.generationPaused ? 'off' : 'on' }}
              </Badge>
              <Badge v-if="flowState" :variant="flowState.postingPaused ? 'warning' : 'success'" class="text-xs">
                Post {{ flowState.postingPaused ? 'off' : 'on' }}
              </Badge>
              <Badge v-if="flowState" :variant="flowState.engagementPaused ? 'warning' : 'success'" class="text-xs">
                Eng {{ flowState.engagementPaused ? 'off' : 'on' }}
              </Badge>
            </div>
          </div>
        </div>
      </Card>
    </div>

    <div class="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-3">
      <!-- Recent Posts -->
      <Card class="lg:col-span-2">
        <template #header>
          <div class="flex items-center justify-between">
            <div>
              <h2 class="text-lg font-semibold text-text-primary">Recent Posts</h2>
              <p class="text-sm text-text-secondary">Latest activity across all networks</p>
            </div>
            <Button variant="outline" size="sm" @click="router.push('/history')">
              View all
              <ArrowRight class="h-4 w-4" />
            </Button>
          </div>
        </template>

        <LoadingSpinner v-if="postsStore.loading" />
        <ErrorState v-else-if="postsStore.error" :message="postsStore.error" />
        <div v-else-if="postsStore.posts.length === 0" class="py-8 text-center">
          <p class="text-sm text-text-muted">
            No posts yet. Generate some from the Generate page.
          </p>
          <Button class="mt-4" size="sm" @click="router.push('/generate')">
            Generate posts
          </Button>
        </div>
        <div v-else class="space-y-4">
          <PostCard
            v-for="post in postsStore.posts"
            :key="post.id"
            :post="post"
            :truncate="120"
          />
        </div>
      </Card>

      <!-- Quick Actions + Trending -->
      <div class="space-y-6">
        <Card>
          <template #header>
            <h2 class="text-lg font-semibold text-text-primary">Quick Actions</h2>
            <p class="text-sm text-text-secondary">Jump to common workflows</p>
          </template>

          <div class="space-y-2">
            <Button class="w-full justify-between" @click="router.push('/queue')">
              Review queue
              <ArrowRight class="h-4 w-4" />
            </Button>
            <Button class="w-full justify-between" variant="secondary" @click="router.push('/generate')">
              Generate posts
              <ArrowRight class="h-4 w-4" />
            </Button>
            <Button class="w-full justify-between" variant="outline" @click="router.push('/analytics')">
              View analytics
              <ArrowRight class="h-4 w-4" />
            </Button>
            <Button class="w-full justify-between" variant="outline" @click="router.push('/flow-control')">
              Flow control
              <ArrowRight class="h-4 w-4" />
            </Button>
            <Button class="w-full justify-between" variant="outline" @click="router.push('/reports')">
              Reports
              <ArrowRight class="h-4 w-4" />
            </Button>
          </div>
        </Card>

        <!-- F22: Trending snapshot -->
        <Card v-if="activeTrends.length > 0 || upcomingTrends.length > 0">
          <template #header>
            <div class="flex items-center gap-2">
              <TrendingUp class="h-5 w-5 text-primary" />
              <h2 class="text-lg font-semibold text-text-primary">Trending Snapshot</h2>
            </div>
          </template>

          <div v-if="activeTrends.length > 0" class="mb-4 space-y-2">
            <p class="text-xs font-medium uppercase tracking-wide text-text-muted">Now trending</p>
            <div
              v-for="t in activeTrends"
              :key="t.title"
              class="flex items-center gap-2 rounded-lg bg-primary-subtle p-2"
            >
              <Flame class="h-4 w-4 text-primary" />
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-medium text-text-primary">{{ t.title }}</p>
                <p class="truncate text-xs text-text-secondary">{{ t.subtitle }}</p>
              </div>
              <Badge v-if="t.type === 'merged' && t.priority" variant="secondary" class="text-xs">
                {{ t.priority }}
              </Badge>
            </div>
          </div>

          <div v-if="upcomingTrends.length > 0" class="space-y-2">
            <p class="text-xs font-medium uppercase tracking-wide text-text-muted">Upcoming</p>
            <div
              v-for="t in upcomingTrends"
              :key="t.event"
              class="flex items-center justify-between text-sm"
            >
              <span class="text-text-secondary">{{ t.event }}</span>
              <Badge variant="info">in {{ t.daysUntil }} days</Badge>
            </div>
          </div>

          <Button variant="ghost" size="sm" class="mt-3 w-full" @click="router.push('/trending')">
            View all trends
            <ArrowRight class="h-4 w-4" />
          </Button>
        </Card>
      </div>
    </div>

    <!-- Real-time Agent Grid -->
    <div class="mt-8">
      <div class="mb-4 flex items-center justify-between">
        <div>
          <h2 class="text-lg font-semibold text-text-primary">Agent Subsystems</h2>
          <p class="text-sm text-text-secondary">Live status and control for all agents</p>
        </div>
        <Button variant="outline" size="sm" :loading="agentsStore.loading" @click="agentsStore.fetchSnapshot">
          <RefreshCw class="mr-1 h-3.5 w-3.5" />
          Refresh
        </Button>
      </div>
      <AgentGrid />
    </div>

    <!-- Live Event Feed -->
    <div class="mt-8">
      <LiveEventFeed :events="monitoringStore.eventFeed" />
    </div>
  </div>
</template>
