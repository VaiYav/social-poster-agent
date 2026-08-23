<script setup lang="ts">
/**
 * Sprint Q: Monitor View — real-time agent monitoring dashboard.
 *
 * Shows:
 * - Queue health (waiting/active/failed per network) with pause/resume controls
 * - Health alerts (critical/warning) with timestamps
 * - Real-time event feed (SSE events as they happen)
 * - Pending human-review comments (from replies monitor)
 * - Agent controls (trigger generation, retry failed jobs)
 */
import { onMounted, onUnmounted, ref, computed } from "vue";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Pause,
  Play,
  RefreshCw,
  Zap,
  Clock,
  MessageSquare,
  Send,
  X,
  Bot,
  ShieldAlert,
  ShieldCheck,
} from "@lucide/vue";
import { useMonitoringStore } from "../stores/monitoring";
import { useAgentsStore } from "../stores/agents";
import { usePostsStore } from "../stores/posts";
import { useApi } from "../composables/useApi";
import { useRouter } from "vue-router";
import { Card, Button, SectionHeader, Badge } from "../components/ui";
import StatCard from "../components/StatCard.vue";
import LoadingSpinner from "../components/LoadingSpinner.vue";
import ErrorState from "../components/ErrorState.vue";
import NetworkIcon from "../components/NetworkIcon.vue";
import AgentGrid from "../components/agents/AgentGrid.vue";
import LiveEventFeed from "../components/agents/LiveEventFeed.vue";

const monitor = useMonitoringStore();
const agentsStore = useAgentsStore();
const postsStore = usePostsStore();
const api = useApi();
const router = useRouter();
const refreshInterval = ref<ReturnType<typeof setInterval> | null>(null);
const replyText = ref<Record<string, string>>({});

// Flow control state
interface FlowControlState {
  generationPaused: boolean;
  postingPaused: boolean;
  engagementPaused: boolean;
  repliesPaused: boolean;
  crisisMode: boolean;
}
const flowState = ref<FlowControlState | null>(null);

type DegradationLevel = "HEALTHY" | "DEGRADED" | "RECOVERING" | "CRITICAL" | "DOWN";
interface DegradationSnapshot {
  subsystem: string;
  level: DegradationLevel;
  since: number;
  reason?: string;
  lastProbeMs?: number;
  consecutiveProbePasses: number;
  nextProbeAt?: number;
}
const degradation = ref<DegradationSnapshot[]>([]);
const degradationLoading = ref(false);
const degradationError = ref<string | null>(null);

onMounted(async () => {
  await Promise.all([
    monitor.fetchAll(),
    agentsStore.fetchSnapshot(),
    fetchFlowControl(),
    fetchDegradation(),
  ]);
  // Auto-refresh every 30 seconds
  refreshInterval.value = setInterval(() => {
    monitor.fetchAll();
    agentsStore.fetchSnapshot();
    fetchFlowControl();
    fetchDegradation();
  }, 30_000);
});

async function fetchFlowControl() {
  try {
    const res = await api.get<FlowControlState>("/flow-control/state");
    flowState.value = res.data;
  } catch {
    // Graceful
  }
}

async function fetchDegradation() {
  degradationLoading.value = true;
  degradationError.value = null;
  try {
    const res = await api.get<{ subsystems: DegradationSnapshot[] }>("/health/degradation");
    degradation.value = res.data.subsystems;
  } catch (err) {
    degradationError.value = (err as Error).message ?? "System health unavailable";
  } finally {
    degradationLoading.value = false;
  }
}

onUnmounted(() => {
  if (refreshInterval.value) clearInterval(refreshInterval.value);
});

const statItems = computed(() => [
  {
    label: "Waiting Jobs",
    value: monitor.totalWaitingJobs,
    icon: Clock,
    color: "text-status-approved",
  },
  {
    label: "Failed Jobs",
    value: monitor.totalFailedJobs,
    icon: XCircle,
    color: "text-status-failed",
  },
  {
    label: "Critical Alerts",
    value: monitor.criticalAlerts.length,
    icon: AlertTriangle,
    color: "text-status-failed",
  },
  {
    label: "Pending Replies",
    value: monitor.pendingReplies.length,
    icon: MessageSquare,
    color: "text-status-draft",
  },
]);

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function formatRelative(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

async function handlePause(network: string) {
  await monitor.pauseQueue(network);
}

async function handleResume(network: string) {
  await monitor.resumeQueue(network);
}

async function handleRetryFailed(network: string) {
  await monitor.retryFailedJobs(network);
}

async function handleManualReply(commentId: string) {
  const text = replyText.value[commentId];
  if (!text?.trim()) return;
  await monitor.manualReply(commentId, text.trim());
  replyText.value[commentId] = "";
}

async function handleDismiss(commentId: string) {
  await monitor.dismissReply(commentId);
}
</script>

<template>
  <div>
    <SectionHeader
      title="Monitor"
      description="Real-time agent status, queue health, and alerts."
    />

    <div class="mb-4 flex items-center gap-2">
      <Button variant="outline" size="sm" @click="monitor.fetchAll()">
        <RefreshCw class="h-4 w-4" />
        Refresh
      </Button>
      <div class="flex items-center gap-2 text-xs text-text-muted">
        <Activity
          class="h-3 w-3"
          :class="postsStore.sseConnected ? 'text-status-posted' : 'text-status-failed'"
        />
        <span>{{ postsStore.sseConnected ? "SSE connected" : "SSE disconnected" }}</span>
        <span class="text-text-muted">· auto-refresh 30s</span>
      </div>
    </div>

    <LoadingSpinner v-if="monitor.loading" />
    <ErrorState v-else-if="monitor.error" :message="monitor.error" />
    <template v-else>
      <!-- Stats Row -->
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          v-for="item in statItems"
          :key="item.label"
          :label="item.label"
          :value="item.value"
          :icon="item.icon"
          :color="item.color"
        />
      </div>

      <!-- REL-102: unified subsystem degradation state -->
      <Card class="mt-6">
        <template #header>
          <div class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-2">
              <ShieldCheck class="h-5 w-5 text-primary" aria-hidden="true" />
              <div>
                <h2 class="text-lg font-semibold text-text-primary">System Resilience</h2>
                <p class="text-sm text-text-secondary">Subsystem health and recovery probes.</p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              :loading="degradationLoading"
              @click="fetchDegradation"
            >
              <RefreshCw class="h-3.5 w-3.5" aria-hidden="true" />
              Refresh
            </Button>
          </div>
        </template>

        <div
          v-if="degradationError"
          role="alert"
          class="rounded-md border border-warning/30 bg-warning-subtle p-3 text-sm text-warning"
        >
          {{ degradationError }}
        </div>
        <LoadingSpinner
          v-else-if="degradationLoading && degradation.length === 0"
          message="Loading subsystem health…"
        />
        <div v-else-if="degradation.length === 0" class="py-6 text-center text-sm text-text-muted">
          No subsystem incidents recorded.
        </div>
        <ul v-else class="grid gap-3 md:grid-cols-2 xl:grid-cols-3" aria-label="Subsystem health">
          <li
            v-for="snapshot in degradation"
            :key="snapshot.subsystem"
            class="rounded-lg border border-border bg-surface-elevated p-4"
          >
            <div class="flex items-center justify-between gap-2">
              <span class="truncate text-sm font-medium text-text-primary">{{
                snapshot.subsystem
              }}</span>
              <Badge
                :variant="
                  snapshot.level === 'HEALTHY'
                    ? 'success'
                    : snapshot.level === 'RECOVERING'
                      ? 'info'
                      : snapshot.level === 'DEGRADED'
                        ? 'warning'
                        : 'error'
                "
              >
                {{ snapshot.level }}
              </Badge>
            </div>
            <p v-if="snapshot.reason" class="mt-2 line-clamp-2 text-xs text-text-secondary">
              {{ snapshot.reason }}
            </p>
            <p class="mt-2 text-xs text-text-muted">
              Probe passes: {{ snapshot.consecutiveProbePasses }}
              <span v-if="snapshot.lastProbeMs">
                · last {{ formatTime(snapshot.lastProbeMs) }}</span
              >
            </p>
          </li>
        </ul>
      </Card>

      <div class="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <!-- Flow Control Panel -->
        <Card>
          <template #header>
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <ShieldAlert class="h-5 w-5 text-primary" />
                <div>
                  <h2 class="text-lg font-semibold text-text-primary">Flow Control</h2>
                  <p class="text-sm text-text-secondary">Pause/resume individual pipelines</p>
                </div>
              </div>
              <Button size="sm" variant="outline" @click="router.push('/flow-control')">
                Full view
              </Button>
            </div>
          </template>

          <div v-if="flowState" class="space-y-3">
            <div
              v-for="flow in [
                { key: 'generationPaused', label: 'Generation', icon: Zap },
                { key: 'postingPaused', label: 'Posting', icon: Send },
                { key: 'engagementPaused', label: 'Engagement', icon: Activity },
                { key: 'repliesPaused', label: 'Replies', icon: MessageSquare },
              ]"
              :key="flow.key"
              class="flex items-center justify-between rounded-lg bg-surface-elevated p-3"
            >
              <div class="flex items-center gap-2">
                <component :is="flow.icon" class="h-4 w-4 text-text-muted" />
                <span class="text-sm font-medium text-text-primary">{{ flow.label }}</span>
              </div>
              <Badge :variant="(flowState as any)[flow.key] ? 'warning' : 'success'">
                {{ (flowState as any)[flow.key] ? "PAUSED" : "RUNNING" }}
              </Badge>
            </div>
            <div
              v-if="flowState.crisisMode"
              class="rounded-lg border border-error/30 bg-error/10 p-3"
            >
              <div class="flex items-center gap-2">
                <AlertTriangle class="h-4 w-4 text-error" />
                <span class="text-sm font-medium text-error"
                  >Crisis mode active — all flows paused</span
                >
              </div>
            </div>
          </div>
          <div v-else class="py-6 text-center text-sm text-text-muted">
            Flow control state unavailable
          </div>
        </Card>

        <!-- Autonomous Cycle Status -->
        <Card>
          <template #header>
            <div class="flex items-center gap-2">
              <Bot class="h-5 w-5 text-primary" />
              <div>
                <h2 class="text-lg font-semibold text-text-primary">Autonomous Cycle</h2>
                <p class="text-sm text-text-secondary">Last autonomous run status</p>
              </div>
            </div>
          </template>
          <div class="space-y-3">
            <div class="rounded-lg bg-surface-elevated p-3">
              <div class="flex items-center justify-between">
                <span class="text-sm text-text-secondary">Pipeline</span>
                <span class="text-sm font-medium text-text-primary"
                  >Generate → Check → Approve → Post</span
                >
              </div>
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div class="rounded-lg bg-surface-elevated p-3 text-center">
                <p class="text-xs text-text-muted">Auto-Approve</p>
                <Badge variant="success" class="mt-1">Enabled</Badge>
              </div>
              <div class="rounded-lg bg-surface-elevated p-3 text-center">
                <p class="text-xs text-text-muted">Auto-Check</p>
                <Badge variant="success" class="mt-1">Enabled</Badge>
              </div>
            </div>
            <div class="rounded-lg border border-border p-3">
              <p class="text-xs text-text-muted mb-2">Next scheduled run</p>
              <p class="text-sm font-medium text-text-primary">Every 4 hours (cron)</p>
              <p class="text-xs text-text-secondary mt-1">
                Gated by flow control — will skip if generation or posting is paused.
              </p>
            </div>
          </div>
        </Card>
      </div>

      <div class="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <!-- Queue Health -->
        <Card>
          <template #header>
            <h2 class="text-lg font-semibold text-text-primary">Queue Health</h2>
            <p class="text-sm text-text-secondary">BullMQ job stats per network</p>
          </template>

          <div class="space-y-4">
            <div
              v-for="q in monitor.queueStats"
              :key="q.network"
              class="rounded-lg border border-border p-4"
            >
              <div class="flex items-center justify-between mb-3">
                <div class="flex items-center gap-2">
                  <NetworkIcon :network="q.network" />
                  <Badge v-if="q.paused" variant="warning">PAUSED</Badge>
                </div>
                <div class="flex items-center gap-1">
                  <Button
                    v-if="!q.paused"
                    variant="outline"
                    size="sm"
                    @click="handlePause(q.network)"
                  >
                    <Pause class="h-3 w-3" />
                    Pause
                  </Button>
                  <Button v-else variant="outline" size="sm" @click="handleResume(q.network)">
                    <Play class="h-3 w-3" />
                    Resume
                  </Button>
                  <Button
                    v-if="q.failed > 0"
                    variant="outline"
                    size="sm"
                    @click="handleRetryFailed(q.network)"
                  >
                    <RefreshCw class="h-3 w-3" />
                    Retry ({{ q.failed }})
                  </Button>
                </div>
              </div>

              <div class="grid grid-cols-5 gap-2 text-center">
                <div>
                  <div class="text-lg font-semibold text-status-approved">{{ q.waiting }}</div>
                  <div class="text-xs text-text-muted">Waiting</div>
                </div>
                <div>
                  <div class="text-lg font-semibold text-status-posting">{{ q.active }}</div>
                  <div class="text-xs text-text-muted">Active</div>
                </div>
                <div>
                  <div class="text-lg font-semibold text-status-posted">{{ q.completed }}</div>
                  <div class="text-xs text-text-muted">Done</div>
                </div>
                <div>
                  <div class="text-lg font-semibold text-status-failed">{{ q.failed }}</div>
                  <div class="text-xs text-text-muted">Failed</div>
                </div>
                <div>
                  <div class="text-lg font-semibold text-text-secondary">{{ q.delayed }}</div>
                  <div class="text-xs text-text-muted">Delayed</div>
                </div>
              </div>
            </div>
          </div>
        </Card>

        <!-- Health Alerts -->
        <Card>
          <template #header>
            <h2 class="text-lg font-semibold text-text-primary">Health Alerts</h2>
            <p class="text-sm text-text-secondary">Latest issues detected by health monitor</p>
          </template>

          <div v-if="monitor.healthAlerts.length === 0" class="py-8 text-center">
            <CheckCircle2 class="mx-auto h-8 w-8 text-status-posted" />
            <p class="mt-2 text-sm text-text-muted">No alerts — all systems healthy</p>
          </div>
          <div v-else class="space-y-3">
            <div
              v-for="(alert, i) in monitor.healthAlerts.slice(0, 10)"
              :key="i"
              class="flex items-start gap-3 rounded-lg border border-border p-3"
            >
              <AlertTriangle
                class="h-4 w-4 mt-0.5 flex-shrink-0"
                :class="alert.severity === 'critical' ? 'text-status-failed' : 'text-status-draft'"
              />
              <div class="flex-1 min-w-0">
                <p class="text-sm text-text-primary">{{ alert.message }}</p>
                <p class="text-xs text-text-muted mt-1">{{ formatTime(alert.timestamp) }}</p>
              </div>
            </div>
          </div>
        </Card>
      </div>

      <!-- Pending Human-Review Replies -->
      <Card class="mt-6" v-if="monitor.pendingReplies.length > 0">
        <template #header>
          <h2 class="text-lg font-semibold text-text-primary">Comments Needing Review</h2>
          <p class="text-sm text-text-secondary">
            Comments flagged for human review by the replies monitor
          </p>
        </template>

        <div class="space-y-4">
          <div
            v-for="item in monitor.pendingReplies"
            :key="item.id"
            class="rounded-lg border border-border p-4"
          >
            <div class="flex items-start justify-between mb-2">
              <div class="flex items-center gap-2">
                <NetworkIcon :network="item.network" />
                <span class="text-sm font-medium text-text-primary">@{{ item.author }}</span>
                <span class="text-xs text-text-muted">{{ formatRelative(item.scrapedAt) }}</span>
              </div>
              <Badge variant="warning">{{ item.humanReviewReason ?? "Review needed" }}</Badge>
            </div>
            <p class="text-sm text-text-secondary mb-3">{{ item.text }}</p>

            <div class="flex items-end gap-2">
              <textarea
                v-model="replyText[item.id]"
                placeholder="Type a reply..."
                class="flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary"
                rows="2"
              />
              <Button
                size="sm"
                @click="handleManualReply(item.id)"
                :disabled="!replyText[item.id]?.trim()"
              >
                <Send class="h-3 w-3" />
                Reply
              </Button>
              <Button size="sm" variant="outline" @click="handleDismiss(item.id)">
                <X class="h-3 w-3" />
                Dismiss
              </Button>
            </div>
            <p v-if="item.replyText" class="mt-2 text-xs text-text-muted">
              Suggested: {{ item.replyText }}
            </p>
          </div>
        </div>
      </Card>

      <!-- Agent Grid -->
      <div class="mt-6">
        <div class="mb-4 flex items-center justify-between">
          <div>
            <h2 class="text-lg font-semibold text-text-primary">Agent Subsystems</h2>
            <p class="text-sm text-text-secondary">Live status and control for all agents</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            :loading="agentsStore.loading"
            @click="agentsStore.fetchSnapshot"
          >
            <RefreshCw class="mr-1 h-3.5 w-3.5" />
            Refresh
          </Button>
        </div>
        <AgentGrid />
      </div>

      <!-- Real-time Event Feed -->
      <div class="mt-6">
        <LiveEventFeed :events="monitor.eventFeed" />
      </div>
    </template>
  </div>
</template>
