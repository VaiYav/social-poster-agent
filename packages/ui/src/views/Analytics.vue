<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import {
  BarChart3,
  TrendingUp,
  CheckCircle2,
  XCircle,
  Activity,
  ExternalLink,
  Zap,
  Award,
  RefreshCw,
  Bot,
  MousePointerClick,
  CircleDollarSign,
} from "@lucide/vue";
import { useApi } from "../composables/useApi";
import { useToast } from "../composables/useToast";
import { Card, ProgressBar, Badge, SectionHeader, Button, Select, Table } from "../components/ui";
import StatCard from "../components/StatCard.vue";
import LoadingSpinner from "../components/LoadingSpinner.vue";
import ErrorState from "../components/ErrorState.vue";
import NetworkIcon from "../components/NetworkIcon.vue";
import { BarChart, DoughnutChart } from "../components/charts";
import { useAnalyticsStore } from "../stores/analytics";
import type { ABTest, ABTestVariant } from "@spa/shared";

const api = useApi();
const toast = useToast();
const analyticsStore = useAnalyticsStore();
const loading = ref(true);
const scraping = ref(false);
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
  networks: Record<
    string,
    Record<
      string,
      {
        avg: number;
        count: number;
        avgQuality: number;
        qualityCount: number;
      }
    >
  >;
  lastUpdated: number | null;
}

const summary = ref<AnalyticsSummary | null>(null);
const topPosts = ref<TopPost[]>([]);
const hookPerformance = ref<HookPerformanceStats | null>(null);
const selectedNetwork = ref<"X" | "THREADS" | "FACEBOOK">("X");

const abTests = ref<ABTest[]>([]);
const abTestsLoading = ref(true);
const abTestsError = ref<string | null>(null);
const abDays = ref(30);
const abNetwork = ref<"ALL" | "X" | "THREADS" | "FACEBOOK">("ALL");

interface ConversionPost {
  postId: string;
  network: string;
  status: string;
  postedAt: string | null;
  topic: string | null;
  ctaUrl?: string;
  attributionSlug?: string;
  deliveryMode: "inline" | "reply";
  source: "provider" | "utm-fallback";
  clicks: number;
  conversions: number;
}

interface ConversionSummary {
  windowDays: number;
  totals: {
    posts: number;
    clicks: number;
    conversions: number;
    conversionRate: number | null;
  };
  degradedLinks: number;
  posts: ConversionPost[];
}

interface ReviewCalibrationReport {
  windowDays: number;
  totalDecisions: number;
  byDecision: Record<string, number>;
  syncStatus: Record<string, number>;
  averageEditDistance: number | null;
  evidenceCoverage: {
    reasonCodes: number;
    rubric: number;
    trace: number;
    contentHashes: number;
  };
  calibration: {
    pairedSamples: number;
    agreementRate: number | null;
    kappa: number | null;
    precision: number | null;
    recall: number | null;
    tpr: number | null;
    tnr: number | null;
    status: "INSUFFICIENT_SAMPLE" | "READY_FOR_REVIEW";
  };
}

interface OnlineEvaluationDashboard {
  slo: {
    sampleCount: number;
    deterministicPassRate: number | null;
    taskCompletionRate: number | null;
    unknownProviderRate: number | null;
    usageCostCoverage: number | null;
    promptLinkCoverage: number | null;
    fallbackDepthP95: number | null;
    semanticSampleCoverage: number | null;
  } | null;
  alerts: Array<{ id: string; severity: string; message: string; fields: string[]; at: number }>;
  timestamp: string;
}

interface CostAnalytics {
  totalCostUsd: number;
  totalTokensIn: number;
  totalTokensOut: number;
  cacheHits: number;
  events: number;
}

const conversion = ref<ConversionSummary | null>(null);
const conversionDays = ref(30);
const conversionLoading = ref(true);
const conversionError = ref<string | null>(null);
const reviewCalibration = ref<ReviewCalibrationReport | null>(null);
const onlineEvaluation = ref<OnlineEvaluationDashboard | null>(null);
const costAnalytics = ref<CostAnalytics | null>(null);

const HOOK_TECHNIQUE_LABELS: Record<string, string> = {
  question: "Question",
  bold: "Bold",
  counter_intuitive: "Counter-intuitive",
  story: "Story",
  data: "Data",
};

async function loadAnalytics() {
  loading.value = true;
  error.value = null;
  try {
    const [summaryRes, topRes, hookRes, reviewRes, onlineRes, costRes] = await Promise.all([
      api.get<AnalyticsSummary>("/analytics/summary"),
      api.get<TopPost[]>("/analytics/top-posts?limit=10"),
      api
        .get<HookPerformanceStats>("/analytics/hook-performance")
        .catch(() => ({ data: { networks: {}, lastUpdated: null } })),
      api
        .get<ReviewCalibrationReport>("/analytics/review-calibration?days=30")
        .catch(() => ({ data: null })),
      api
        .get<OnlineEvaluationDashboard>("/analytics/online-evaluation")
        .catch(() => ({ data: null })),
      api.get<CostAnalytics>("/analytics/cost").catch(() => ({ data: null })),
    ]);
    summary.value = summaryRes.data;
    topPosts.value = topRes.data;
    hookPerformance.value = hookRes.data;
    reviewCalibration.value = reviewRes.data;
    onlineEvaluation.value = onlineRes.data;
    costAnalytics.value = costRes.data;
  } catch (err) {
    error.value = errorMessage(err) ?? "Failed to load analytics";
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  loadAnalytics();
  loadAbTests();
  loadConversionSummary();
  analyticsStore.fetchAutonomousStats();
});

async function loadConversionSummary() {
  conversionLoading.value = true;
  conversionError.value = null;
  try {
    const res = await api.get<ConversionSummary>(
      `/link-attribution/summary?days=${conversionDays.value}`,
    );
    conversion.value = res.data;
  } catch (err) {
    conversionError.value = errorMessage(err) ?? "Conversion data unavailable";
  } finally {
    conversionLoading.value = false;
  }
}

async function scrapeMetrics() {
  scraping.value = true;
  try {
    const res = await api.post<{ collected: number; failed: number; skipped: number }>(
      "/analytics/scrape",
    );
    toast.success(
      `Metrics scraped: ${res.data.collected} collected, ${res.data.failed} failed, ${res.data.skipped} skipped`,
    );
  } catch (err) {
    toast.error((err as Error).message ?? "Failed to scrape metrics");
  } finally {
    scraping.value = false;
  }
}

async function refreshHookStats() {
  try {
    await api.post("/analytics/hook-performance/aggregate");
    toast.success("Hook performance aggregation triggered");
    await loadAnalytics();
  } catch {
    toast.error("Failed to aggregate hook stats");
  }
}

async function loadAbTests() {
  abTestsLoading.value = true;
  abTestsError.value = null;
  try {
    const params: Record<string, string | number> = { days: abDays.value };
    if (abNetwork.value !== "ALL") params.network = abNetwork.value;
    const res = await api.get<ABTest[]>("/analytics/ab-tests", { params });
    abTests.value = res.data;
  } catch (err) {
    abTestsError.value = errorMessage(err) ?? "Failed to load A/B tests";
  } finally {
    abTestsLoading.value = false;
  }
}

function formatDate(date: string): string {
  return new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Chart data: 7-day posting activity
const weeklyChartData = computed(() => {
  if (!summary.value) return { labels: [], datasets: [] };
  return {
    labels: summary.value.last7Days.map((d) => formatDate(d.date)),
    datasets: [
      {
        label: "Posted",
        data: summary.value.last7Days.map((d) => d.posted),
        backgroundColor: "rgba(34, 197, 94, 0.6)",
        borderColor: "rgba(34, 197, 94, 1)",
        borderWidth: 1,
      },
      {
        label: "Failed",
        data: summary.value.last7Days.map((d) => d.failed),
        backgroundColor: "rgba(239, 68, 68, 0.6)",
        borderColor: "rgba(239, 68, 68, 1)",
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
    labels: techniques.map((t) => HOOK_TECHNIQUE_LABELS[t]),
    datasets: [
      {
        label: "Avg Quality Score (1-10)",
        data: techniques.map((t) => {
          const s = networkStats[t];
          return s && s.qualityCount > 0 ? Number(s.avgQuality.toFixed(1)) : 0;
        }),
        backgroundColor: "rgba(99, 102, 241, 0.6)",
        borderColor: "rgba(99, 102, 241, 1)",
        borderWidth: 1,
      },
      {
        label: "Avg Engagement",
        data: techniques.map((t) => {
          const s = networkStats[t];
          return s && s.count > 0 ? Number(s.avg.toFixed(1)) : 0;
        }),
        backgroundColor: "rgba(234, 179, 8, 0.6)",
        borderColor: "rgba(234, 179, 8, 1)",
        borderWidth: 1,
      },
    ],
  };
});

// Chart data: Quality score distribution from autonomous stats
const qualityDistributionData = computed(() => {
  const dist = analyticsStore.autonomousStats?.qualityDistribution ?? [];
  return {
    labels: dist.map((d) => d.score.toString()),
    datasets: [
      {
        label: "Posts",
        data: dist.map((d) => d.count),
        backgroundColor: "rgba(99, 102, 241, 0.6)",
        borderColor: "rgba(99, 102, 241, 1)",
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
    datasets: [
      {
        data: networks.map(([, s]) => s.total),
        backgroundColor: [
          "rgba(99, 102, 241, 0.7)",
          "rgba(168, 85, 247, 0.7)",
          "rgba(59, 130, 246, 0.7)",
        ],
        borderColor: ["rgba(99, 102, 241, 1)", "rgba(168, 85, 247, 1)", "rgba(59, 130, 246, 1)"],
        borderWidth: 1,
      },
    ],
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
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="Total Posts" :value="summary.totalPosts" :icon="statIcons.total" />
        <StatCard
          label="Posted"
          :value="summary.posted"
          :icon="statIcons.posted"
          color="text-status-posted"
        />
        <StatCard
          label="Failed"
          :value="summary.failed"
          :icon="statIcons.failed"
          color="text-status-failed"
        />
        <StatCard
          label="Success Rate"
          :value="`${summary.successRate}%`"
          :icon="statIcons.rate"
          color="text-status-approved"
        />
        <StatCard
          label="LLM Cost (7d)"
          :value="costAnalytics ? `$${costAnalytics.totalCostUsd.toFixed(4)}` : '—'"
          :icon="CircleDollarSign"
          color="text-secondary"
        />
      </div>

      <!-- M2.4: conversion funnel. Revenue is deliberately explicit until the
           external funnel provider returns a revenue field. -->
      <Card>
        <template #header>
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex items-center gap-2">
              <MousePointerClick class="h-5 w-5 text-primary" />
              <div>
                <h2 class="text-lg font-semibold text-text-primary">Conversion Funnel</h2>
                <p class="text-sm text-text-secondary">
                  Trackable CTA performance by post and network.
                </p>
              </div>
            </div>
            <div class="flex items-center gap-2">
              <Select
                :model-value="String(conversionDays)"
                :options="[
                  { value: '7', label: '7 days' },
                  { value: '30', label: '30 days' },
                  { value: '90', label: '90 days' },
                ]"
                class="w-28"
                @update:model-value="
                  conversionDays = Number($event);
                  loadConversionSummary();
                "
              />
              <Button
                size="sm"
                variant="outline"
                :loading="conversionLoading"
                @click="loadConversionSummary"
              >
                <RefreshCw class="h-3.5 w-3.5" />
                Refresh
              </Button>
            </div>
          </div>
        </template>

        <LoadingSpinner v-if="conversionLoading" message="Loading funnel data…" />
        <div
          v-else-if="conversionError"
          class="flex items-center justify-between gap-3 rounded-md border border-warning/30 bg-warning-subtle p-4 text-sm text-warning"
          role="status"
        >
          <span>{{ conversionError }}</span>
          <Button size="sm" variant="outline" @click="loadConversionSummary">Retry</Button>
        </div>
        <div v-else-if="conversion" class="space-y-5">
          <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div class="rounded-md bg-surface-elevated p-4">
              <p class="text-xs text-text-muted">CTA posts</p>
              <p class="mt-1 text-2xl font-semibold text-text-primary">
                {{ conversion.totals.posts }}
              </p>
            </div>
            <div class="rounded-md bg-surface-elevated p-4">
              <p class="text-xs text-text-muted">Clicks</p>
              <p class="mt-1 text-2xl font-semibold text-text-primary">
                {{ conversion.totals.clicks }}
              </p>
            </div>
            <div class="rounded-md bg-surface-elevated p-4">
              <p class="text-xs text-text-muted">Conversions</p>
              <p class="mt-1 text-2xl font-semibold text-success">
                {{ conversion.totals.conversions }}
              </p>
            </div>
            <div class="rounded-md bg-surface-elevated p-4">
              <p class="text-xs text-text-muted">Revenue</p>
              <p class="mt-1 flex items-center gap-1 text-2xl font-semibold text-text-muted">
                <CircleDollarSign class="h-5 w-5" aria-hidden="true" />
                —
              </p>
              <p class="mt-1 text-xs text-text-muted">Provider field pending</p>
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-2 text-sm text-text-secondary">
            <Badge variant="info">
              {{
                conversion.totals.conversionRate === null
                  ? "No funnel rate"
                  : `${(conversion.totals.conversionRate * 100).toFixed(2)}% conversion rate`
              }}
            </Badge>
            <Badge v-if="conversion.degradedLinks > 0" variant="warning">
              {{ conversion.degradedLinks }} link report{{
                conversion.degradedLinks === 1 ? "" : "s"
              }}
              degraded
            </Badge>
            <span>Window: {{ conversion.windowDays }} days</span>
          </div>

          <div
            v-if="conversion.posts.length === 0"
            class="py-8 text-center text-sm text-text-muted"
          >
            No CTA-bearing posts in this window.
          </div>
          <Table v-else>
            <table class="w-full min-w-[42rem] text-left text-sm">
              <caption class="sr-only">
                Recent CTA performance
              </caption>
              <thead class="border-b border-border text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th class="px-3 py-2 font-medium">Post</th>
                  <th class="px-3 py-2 font-medium">Network</th>
                  <th class="px-3 py-2 font-medium">Source</th>
                  <th class="px-3 py-2 text-right font-medium">Clicks</th>
                  <th class="px-3 py-2 text-right font-medium">Conversions</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-border">
                <tr v-for="post in conversion.posts.slice(0, 10)" :key="post.postId">
                  <td
                    class="max-w-[20rem] truncate px-3 py-3 text-text-primary"
                    :title="post.topic ?? post.postId"
                  >
                    {{ post.topic || post.postId.slice(0, 12) }}
                  </td>
                  <td class="px-3 py-3 text-text-secondary">{{ post.network }}</td>
                  <td class="px-3 py-3">
                    <Badge :variant="post.source === 'provider' ? 'primary' : 'neutral'">
                      {{ post.source === "provider" ? "Trackable" : "UTM fallback" }}
                    </Badge>
                  </td>
                  <td class="px-3 py-3 text-right text-text-secondary">{{ post.clicks }}</td>
                  <td class="px-3 py-3 text-right font-medium text-success">
                    {{ post.conversions }}
                  </td>
                </tr>
              </tbody>
            </table>
          </Table>
        </div>
      </Card>

      <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <!-- Weekly activity chart -->
        <Card>
          <template #header>
            <div class="flex items-center gap-2">
              <BarChart3 class="h-5 w-5 text-primary" />
              <h2 class="text-lg font-semibold text-text-primary">Last 7 Days</h2>
            </div>
          </template>
          <div style="height: 200px">
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
          <div style="height: 200px">
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
              <span
                >{{ stats.total > 0 ? Math.round((stats.posted / stats.total) * 100) : 0 }}%
                success</span
              >
            </div>
          </div>
        </div>
      </Card>

      <!-- Autonomous Pipeline -->
      <Card>
        <template #header>
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <Bot class="h-5 w-5 text-primary" />
              <div>
                <h2 class="text-lg font-semibold text-text-primary">Autonomous Pipeline</h2>
                <p class="text-sm text-text-secondary">
                  Auto-approve decisions and quality distribution
                </p>
              </div>
            </div>
            <Button size="sm" variant="outline" :loading="scraping" @click="scrapeMetrics">
              <RefreshCw class="mr-1 h-3.5 w-3.5" />
              Scrape Metrics
            </Button>
          </div>
        </template>

        <div v-if="!analyticsStore.autonomousStats" class="py-12 text-center text-text-muted">
          <Bot class="mx-auto mb-3 h-10 w-10 opacity-40" />
          <p>No autonomous stats available.</p>
        </div>
        <div v-else class="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div class="grid grid-cols-2 gap-4">
            <StatCard
              label="Total Generated"
              :value="analyticsStore.autonomousStats.totalGenerated"
              :icon="BarChart3"
            />
            <StatCard
              label="Auto-Approved"
              :value="analyticsStore.autonomousStats.autoApproved"
              :icon="CheckCircle2"
              color="text-status-approved"
            />
            <StatCard
              label="Human Review"
              :value="analyticsStore.autonomousStats.humanReview"
              :icon="Activity"
              color="text-status-pending"
            />
            <StatCard
              label="Rejected"
              :value="analyticsStore.autonomousStats.rejected"
              :icon="XCircle"
              color="text-status-failed"
            />
            <StatCard
              class="col-span-2"
              label="Avg Quality Score"
              :value="analyticsStore.autonomousStats.avgQualityScore.toFixed(1)"
              :icon="TrendingUp"
              color="text-primary"
            />
          </div>
          <div style="height: 200px">
            <BarChart :data="qualityDistributionData" />
          </div>
        </div>
      </Card>

      <!-- EVAL-701: durable review evidence and preliminary calibration. -->
      <Card>
        <template #header>
          <div class="flex items-center justify-between gap-3">
            <div>
              <h2 class="text-lg font-semibold text-text-primary">Review Evidence</h2>
              <p class="text-sm text-text-secondary">
                Durable human decisions, sync health, and diagnostic judge agreement.
              </p>
            </div>
            <Badge
              v-if="reviewCalibration"
              :variant="
                reviewCalibration.calibration.status === 'READY_FOR_REVIEW' ? 'success' : 'warning'
              "
            >
              {{
                reviewCalibration.calibration.status === "READY_FOR_REVIEW"
                  ? "Ready"
                  : "Insufficient sample"
              }}
            </Badge>
          </div>
        </template>

        <div v-if="!reviewCalibration" class="py-8 text-center text-sm text-text-muted">
          No durable review evidence available yet.
        </div>
        <div v-else class="space-y-5">
          <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div class="rounded-lg bg-surface-elevated p-3">
              <div class="text-xs text-text-muted">Decisions</div>
              <div class="mt-1 text-xl font-semibold text-text-primary">
                {{ reviewCalibration.totalDecisions }}
              </div>
            </div>
            <div class="rounded-lg bg-surface-elevated p-3">
              <div class="text-xs text-text-muted">Avg edit distance</div>
              <div class="mt-1 text-xl font-semibold text-text-primary">
                {{
                  reviewCalibration.averageEditDistance === null
                    ? "—"
                    : `${Math.round(reviewCalibration.averageEditDistance * 100)}%`
                }}
              </div>
            </div>
            <div class="rounded-lg bg-surface-elevated p-3">
              <div class="text-xs text-text-muted">Paired samples</div>
              <div class="mt-1 text-xl font-semibold text-text-primary">
                {{ reviewCalibration.calibration.pairedSamples }}
              </div>
            </div>
            <div class="rounded-lg bg-surface-elevated p-3">
              <div class="text-xs text-text-muted">Agreement</div>
              <div class="mt-1 text-xl font-semibold text-text-primary">
                {{
                  reviewCalibration.calibration.agreementRate === null
                    ? "—"
                    : `${Math.round(reviewCalibration.calibration.agreementRate * 100)}%`
                }}
              </div>
            </div>
            <div class="rounded-lg bg-surface-elevated p-3">
              <div class="text-xs text-text-muted">Cohen's kappa</div>
              <div class="mt-1 text-xl font-semibold text-text-primary">
                {{
                  reviewCalibration.calibration.kappa === null
                    ? "—"
                    : reviewCalibration.calibration.kappa.toFixed(2)
                }}
              </div>
            </div>
          </div>

          <div class="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <div>
              <h3 class="text-sm font-semibold text-text-primary">Evidence coverage</h3>
              <ul class="mt-3 space-y-2 text-sm">
                <li
                  v-for="entry in [
                    ['Reason codes', reviewCalibration.evidenceCoverage.reasonCodes],
                    ['Rubric', reviewCalibration.evidenceCoverage.rubric],
                    ['Trace linkage', reviewCalibration.evidenceCoverage.trace],
                    ['Content hashes', reviewCalibration.evidenceCoverage.contentHashes],
                  ]"
                  :key="entry[0]"
                >
                  <div class="mb-1 flex justify-between text-text-secondary">
                    <span>{{ entry[0] }}</span>
                    <span>{{ Math.round(Number(entry[1]) * 100) }}%</span>
                  </div>
                  <ProgressBar :value="Number(entry[1]) * 100" :show-label="false" />
                </li>
              </ul>
            </div>
            <div>
              <h3 class="text-sm font-semibold text-text-primary">Sync status</h3>
              <ul class="mt-3 space-y-2 text-sm">
                <li
                  v-for="(count, status) in reviewCalibration.syncStatus"
                  :key="status"
                  class="flex items-center justify-between rounded-md bg-surface-elevated px-3 py-2"
                >
                  <span class="text-text-secondary">{{ status }}</span>
                  <span class="font-semibold text-text-primary">{{ count }}</span>
                </li>
              </ul>
            </div>
          </div>
          <p class="text-xs text-text-muted">
            Diagnostic only: promotion still requires the documented held-out calibration gate.
          </p>
        </div>
      </Card>

      <!-- EVAL-702: online evaluator SLO snapshot and dashboard-only alerts. -->
      <Card>
        <template #header>
          <div class="flex items-center justify-between gap-3">
            <div>
              <h2 class="text-lg font-semibold text-text-primary">Online Evaluation</h2>
              <p class="text-sm text-text-secondary">
                Deterministic coverage, semantic sampling, and monitoring signals.
              </p>
            </div>
            <Badge v-if="onlineEvaluation?.alerts.length" variant="warning">
              {{ onlineEvaluation.alerts.length }} dashboard alert{{
                onlineEvaluation.alerts.length === 1 ? "" : "s"
              }}
            </Badge>
          </div>
        </template>

        <div v-if="!onlineEvaluation?.slo" class="py-8 text-center text-sm text-text-muted">
          No online evaluation observations yet.
        </div>
        <div v-else class="space-y-4">
          <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div class="rounded-lg bg-surface-elevated p-3">
              <div class="text-xs text-text-muted">Samples</div>
              <div class="mt-1 text-xl font-semibold">{{ onlineEvaluation.slo.sampleCount }}</div>
            </div>
            <div class="rounded-lg bg-surface-elevated p-3">
              <div class="text-xs text-text-muted">Deterministic pass</div>
              <div class="mt-1 text-xl font-semibold">
                {{
                  onlineEvaluation.slo.deterministicPassRate === null
                    ? "—"
                    : `${Math.round(onlineEvaluation.slo.deterministicPassRate * 100)}%`
                }}
              </div>
            </div>
            <div class="rounded-lg bg-surface-elevated p-3">
              <div class="text-xs text-text-muted">Task completion</div>
              <div class="mt-1 text-xl font-semibold">
                {{
                  onlineEvaluation.slo.taskCompletionRate === null
                    ? "—"
                    : `${Math.round(onlineEvaluation.slo.taskCompletionRate * 100)}%`
                }}
              </div>
            </div>
            <div class="rounded-lg bg-surface-elevated p-3">
              <div class="text-xs text-text-muted">Semantic sample</div>
              <div class="mt-1 text-xl font-semibold">
                {{
                  onlineEvaluation.slo.semanticSampleCoverage === null
                    ? "—"
                    : `${Math.round(onlineEvaluation.slo.semanticSampleCoverage * 100)}%`
                }}
              </div>
            </div>
          </div>
          <ul v-if="onlineEvaluation.alerts.length" class="space-y-2 text-sm">
            <li
              v-for="alert in onlineEvaluation.alerts"
              :key="`${alert.id}-${alert.at}`"
              class="rounded-md border border-warning/30 bg-warning-subtle px-3 py-2 text-warning"
            >
              <span class="font-semibold">{{ alert.id }}</span> — {{ alert.message }}
            </li>
          </ul>
          <p v-else class="text-sm text-text-muted">No dashboard-only calibration alerts.</p>
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
                <p class="text-sm text-text-secondary">
                  Quality feedback loop — which hook techniques produce highest quality content
                </p>
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

        <div v-if="hookPerformance && hookPerformance.lastUpdated" style="height: 250px">
          <BarChart :data="hookQualityChartData" />
        </div>
        <div v-else class="py-12 text-center text-text-muted">
          <Zap class="mx-auto mb-3 h-10 w-10 opacity-40" />
          <p>No hook performance data yet.</p>
          <p class="text-sm mt-1">Click "Aggregate" to compute stats from posted content.</p>
        </div>

        <div
          v-if="hookPerformance && hookPerformance.lastUpdated"
          class="mt-3 text-xs text-text-muted"
        >
          Last updated: {{ new Date(hookPerformance.lastUpdated).toLocaleString() }}
        </div>
      </Card>

      <!-- A/B Tests -->
      <Card>
        <template #header>
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <BarChart3 class="h-5 w-5 text-primary" />
              <div>
                <h2 class="text-lg font-semibold text-text-primary">A/B Tests</h2>
                <p class="text-sm text-text-secondary">Variant performance by topic and network</p>
              </div>
            </div>
            <div class="flex items-center gap-3">
              <select
                v-model="abDays"
                class="h-9 rounded-md border border-border bg-surface-elevated px-3 text-sm text-text-primary"
                @change="loadAbTests"
              >
                <option :value="7">7 days</option>
                <option :value="30">30 days</option>
                <option :value="90">90 days</option>
              </select>
              <select
                v-model="abNetwork"
                class="h-9 rounded-md border border-border bg-surface-elevated px-3 text-sm text-text-primary"
                @change="loadAbTests"
              >
                <option value="ALL">All networks</option>
                <option value="X">X</option>
                <option value="THREADS">Threads</option>
                <option value="FACEBOOK">Facebook</option>
              </select>
              <Button size="sm" variant="outline" @click="loadAbTests">
                <RefreshCw class="mr-1 h-3.5 w-3.5" />
                Refresh
              </Button>
            </div>
          </div>
        </template>

        <LoadingSpinner v-if="abTestsLoading" />
        <ErrorState v-else-if="abTestsError" :message="abTestsError" />
        <div v-else-if="abTests.length === 0" class="py-12 text-center text-text-muted">
          <Activity class="mx-auto mb-3 h-10 w-10 opacity-40" />
          <p>No A/B tests found for this period.</p>
        </div>
        <div v-else class="space-y-4">
          <div
            v-for="test in abTests"
            :key="test.testId"
            class="rounded-lg border border-border p-4"
          >
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <NetworkIcon :network="test.network" />
                <h3 class="font-medium text-text-primary">{{ test.topic }}</h3>
              </div>
              <Badge v-if="test.winner" variant="success">{{ test.winner }} winning</Badge>
              <Badge v-else variant="neutral">No winner</Badge>
            </div>
            <div class="mt-2 text-sm text-text-secondary">
              {{ test.totalPosts }} posts
              <span v-if="test.firstPostedAt && test.lastPostedAt">
                · {{ formatDate(test.firstPostedAt) }} – {{ formatDate(test.lastPostedAt) }}
              </span>
            </div>
            <div class="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div
                v-for="variant in test.variants"
                :key="variant.label"
                class="rounded bg-surface-elevated p-3"
              >
                <div class="flex items-center justify-between">
                  <span class="font-semibold text-text-primary"
                    >Variant {{ variant.label.toUpperCase() }}</span
                  >
                  <span class="text-xs text-text-muted">n={{ variant.sampleSize }}</span>
                </div>
                <div class="mt-2 grid grid-cols-3 gap-2 text-xs text-text-muted">
                  <div>
                    <span class="block font-medium text-text-primary">{{
                      variant.avgEngagement.toFixed(1)
                    }}</span>
                    engagement
                  </div>
                  <div>
                    <span class="block font-medium text-text-primary">{{
                      variant.avgLikes.toFixed(1)
                    }}</span>
                    likes
                  </div>
                  <div v-if="variant.avgImpressions !== null">
                    <span class="block font-medium text-text-primary">{{
                      variant.avgImpressions.toFixed(0)
                    }}</span>
                    impressions
                  </div>
                </div>
              </div>
            </div>
          </div>
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
