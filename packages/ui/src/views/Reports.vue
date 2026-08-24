<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import {
  FileBarChart,
  Download,
  Calendar,
  TrendingUp,
  CheckCircle2,
  XCircle,
  Bot,
  RefreshCw,
} from "@lucide/vue";
import { useApi } from "../composables/useApi";
import { useToast } from "../composables/useToast";
import { Card, Button, SectionHeader, Badge, Select } from "../components/ui";
import StatCard from "../components/StatCard.vue";
import LoadingSpinner from "../components/LoadingSpinner.vue";
import ErrorState from "../components/ErrorState.vue";
import NetworkIcon from "../components/NetworkIcon.vue";

const api = useApi();
const toast = useToast();
const loading = ref(true);
const error = ref<string | null>(null);
const dateRange = ref<"7d" | "30d" | "90d">("30d");

interface ReportData {
  summary: {
    totalPosts: number;
    posted: number;
    failed: number;
    rejected: number;
    successRate: number;
    avgQualityScore: number | null;
  };
  byNetwork: Record<string, { total: number; posted: number; failed: number; successRate: number }>;
  byTrigger: Record<string, number>;
  dailyStats: { date: string; posted: number; failed: number }[];
  topPosts: {
    id: string;
    network: string;
    content: string;
    postedAt: string | null;
    qualityScore?: number;
  }[];
  autoApproveStats: {
    autoApproved: number;
    humanReview: number;
    rejected: number;
    avgScore: number;
  };
}

const report = ref<ReportData | null>(null);

async function loadReport() {
  loading.value = true;
  error.value = null;
  try {
    const res = await api.get<ReportData>(`/analytics/report?range=${dateRange.value}`);
    report.value = res.data;
  } catch (err) {
    error.value = (err as Error).message ?? "Failed to load report";
    // Try to build from summary endpoint as fallback
    try {
      const summaryRes = await api.get<{
        totalPosts: number;
        posted: number;
        failed: number;
        pending?: number;
        successRate: number;
        byNetwork: Record<
          string,
          { total: number; posted: number; failed: number; successRate: number }
        >;
        last7Days: { date: string; posted: number; failed: number }[];
      }>("/analytics/summary");
      report.value = {
        summary: {
          totalPosts: summaryRes.data.totalPosts,
          posted: summaryRes.data.posted,
          failed: summaryRes.data.failed,
          rejected: 0,
          successRate: summaryRes.data.successRate,
          avgQualityScore: null,
        },
        byNetwork: summaryRes.data.byNetwork,
        byTrigger: {},
        dailyStats: summaryRes.data.last7Days,
        topPosts: [],
        autoApproveStats: { autoApproved: 0, humanReview: 0, rejected: 0, avgScore: 0 },
      };
    } catch {
      // Full failure
    }
  } finally {
    loading.value = false;
  }
}

onMounted(loadReport);

function exportCSV() {
  if (!report.value) return;
  const rows: string[] = [];
  // Header
  rows.push("Metric,Value");
  rows.push(`Total Posts,${report.value.summary.totalPosts}`);
  rows.push(`Posted,${report.value.summary.posted}`);
  rows.push(`Failed,${report.value.summary.failed}`);
  rows.push(`Success Rate,${report.value.summary.successRate}%`);
  rows.push(`Avg Quality Score,${report.value.summary.avgQualityScore ?? "N/A"}`);
  rows.push("");
  rows.push("Network,Total,Posted,Failed,Success Rate");
  for (const [network, stats] of Object.entries(report.value.byNetwork)) {
    rows.push(`${network},${stats.total},${stats.posted},${stats.failed},${stats.successRate}%`);
  }
  rows.push("");
  rows.push("Auto-Approve Stats");
  rows.push(`Auto Approved,${report.value.autoApproveStats.autoApproved}`);
  rows.push(`Human Review,${report.value.autoApproveStats.humanReview}`);
  rows.push(`Rejected,${report.value.autoApproveStats.rejected}`);
  rows.push(`Avg Score,${report.value.autoApproveStats.avgScore}`);
  rows.push("");
  rows.push("Date,Posted,Failed");
  for (const day of report.value.dailyStats) {
    rows.push(`${day.date},${day.posted},${day.failed}`);
  }

  const csv = rows.join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `spa-report-${dateRange.value}-${new Date().toISOString().split("T")[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast.success("Report exported as CSV");
}

function exportJSON() {
  if (!report.value) return;
  const blob = new Blob([JSON.stringify(report.value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `spa-report-${dateRange.value}-${new Date().toISOString().split("T")[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast.success("Report exported as JSON");
}

const rangeOptions = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
];
</script>

<template>
  <div>
    <SectionHeader
      title="Reports"
      description="Export performance summaries, autonomous audit trail, and quality metrics."
    />

    <div class="mb-6 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <Calendar class="h-5 w-5 text-text-muted" />
        <Select
          :model-value="dateRange"
          :options="rangeOptions"
          class="w-48"
          @update:model-value="
            dateRange = $event as typeof dateRange;
            loadReport();
          "
        />
      </div>
      <div class="flex gap-2">
        <Button variant="outline" size="sm" @click="loadReport">
          <RefreshCw class="mr-1.5 h-3.5 w-3.5" />
          Refresh
        </Button>
        <Button variant="outline" size="sm" @click="exportCSV" :disabled="!report">
          <Download class="mr-1.5 h-3.5 w-3.5" />
          CSV
        </Button>
        <Button variant="outline" size="sm" @click="exportJSON" :disabled="!report">
          <Download class="mr-1.5 h-3.5 w-3.5" />
          JSON
        </Button>
      </div>
    </div>

    <LoadingSpinner v-if="loading" />
    <ErrorState v-else-if="error && !report" :message="error" />
    <div v-else-if="report" class="space-y-6">
      <!-- Summary stat cards -->
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total Posts" :value="report.summary.totalPosts" :icon="FileBarChart" />
        <StatCard
          label="Success Rate"
          :value="`${report.summary.successRate}%`"
          :icon="TrendingUp"
          color="text-status-approved"
        />
        <StatCard
          label="Avg Quality"
          :value="
            report.summary.avgQualityScore !== null
              ? report.summary.avgQualityScore.toFixed(1)
              : '—'
          "
          :icon="CheckCircle2"
          color="text-primary"
        />
        <StatCard
          label="Failed"
          :value="report.summary.failed"
          :icon="XCircle"
          color="text-status-failed"
        />
      </div>

      <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <!-- Per-network breakdown -->
        <Card>
          <template #header>
            <h2 class="text-lg font-semibold text-text-primary">Network Performance</h2>
          </template>
          <div class="space-y-3">
            <div
              v-for="(stats, network) in report.byNetwork"
              :key="network"
              class="flex items-center justify-between rounded-lg bg-surface-elevated p-3"
            >
              <div class="flex items-center gap-3">
                <NetworkIcon :network="network" />
                <div>
                  <p class="text-sm font-medium text-text-primary">{{ network }}</p>
                  <p class="text-xs text-text-muted">{{ stats.total }} total posts</p>
                </div>
              </div>
              <div class="flex items-center gap-3">
                <Badge variant="success">{{ stats.posted }} posted</Badge>
                <Badge v-if="stats.failed > 0" variant="error">{{ stats.failed }} failed</Badge>
                <span class="text-sm font-medium text-text-primary">{{ stats.successRate }}%</span>
              </div>
            </div>
          </div>
        </Card>

        <!-- Auto-Approve Audit Trail -->
        <Card>
          <template #header>
            <div class="flex items-center gap-2">
              <Bot class="h-5 w-5 text-primary" />
              <div>
                <h2 class="text-lg font-semibold text-text-primary">Auto-Approve Audit</h2>
                <p class="text-sm text-text-secondary">Autonomous decision breakdown</p>
              </div>
            </div>
          </template>
          <div class="space-y-4">
            <div class="grid grid-cols-3 gap-3">
              <div class="rounded-lg bg-success/10 p-3 text-center">
                <p class="text-2xl font-bold text-success">
                  {{ report.autoApproveStats.autoApproved }}
                </p>
                <p class="text-xs text-text-secondary">Auto-Approved</p>
              </div>
              <div class="rounded-lg bg-warning/10 p-3 text-center">
                <p class="text-2xl font-bold text-warning">
                  {{ report.autoApproveStats.humanReview }}
                </p>
                <p class="text-xs text-text-secondary">Human Review</p>
              </div>
              <div class="rounded-lg bg-error/10 p-3 text-center">
                <p class="text-2xl font-bold text-error">{{ report.autoApproveStats.rejected }}</p>
                <p class="text-xs text-text-secondary">Rejected</p>
              </div>
            </div>
            <div class="rounded-lg bg-surface-elevated p-3">
              <div class="flex justify-between text-sm">
                <span class="text-text-secondary">Avg Quality Score (auto-approved)</span>
                <span class="font-medium text-text-primary"
                  >{{ report.autoApproveStats.avgScore.toFixed(1) }} / 10</span
                >
              </div>
            </div>
            <div v-if="Object.keys(report.byTrigger).length > 0">
              <p class="mb-2 text-xs font-medium text-text-muted uppercase tracking-wide">
                By Trigger
              </p>
              <div class="flex flex-wrap gap-2">
                <Badge
                  v-for="(count, trigger) in report.byTrigger"
                  :key="trigger"
                  variant="default"
                >
                  {{ trigger }}: {{ count }}
                </Badge>
              </div>
            </div>
          </div>
        </Card>
      </div>

      <!-- Top posts with quality scores -->
      <Card v-if="report.topPosts.length > 0">
        <template #header>
          <h2 class="text-lg font-semibold text-text-primary">Top Posts (Quality Ranked)</h2>
        </template>
        <div class="space-y-3">
          <div
            v-for="post in report.topPosts"
            :key="post.id"
            class="border-b border-border pb-3 last:border-0"
          >
            <div class="flex items-center gap-3 text-xs text-text-muted">
              <NetworkIcon :network="post.network" />
              <span v-if="post.postedAt">{{ new Date(post.postedAt).toLocaleDateString() }}</span>
              <Badge v-if="post.qualityScore" variant="default"
                >Q: {{ post.qualityScore }}/10</Badge
              >
            </div>
            <p class="mt-1.5 text-sm text-text-primary line-clamp-2">{{ post.content }}</p>
          </div>
        </div>
      </Card>
    </div>
  </div>
</template>
