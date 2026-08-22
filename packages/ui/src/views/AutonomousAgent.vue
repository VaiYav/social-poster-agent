<script setup lang="ts">
/**
 * F1 UI Control Panel — Autonomous Agent view.
 *
 * Operator control surface for the engagement autopilot:
 * - Pause/resume the engagement flow (via FlowControl).
 * - Start a manual browsing session on a selected network.
 * - View scheduler config, real-time interaction stats, and recent browsing sessions.
 * - Live updates via SSE (handled in App.vue → engagement store).
 */
import { onMounted, ref, computed } from "vue";
import { Play, Pause, Bot, Activity, Globe, Gauge, List, Timer } from "@lucide/vue";
import { useEngagementStore } from "../stores/engagement";
import { useFlowControlStore } from "../stores/flowControl";
import { useToast } from "../composables/useToast";
import { Card, Button, Badge, SectionHeader, Select } from "../components/ui";
import LoadingSpinner from "../components/LoadingSpinner.vue";
import ErrorState from "../components/ErrorState.vue";
import EmptyState from "../components/EmptyState.vue";

const engagement = useEngagementStore();
const flowControl = useFlowControlStore();
const toast = useToast();

const selectedNetwork = ref<string>("X");
const isStarting = ref(false);

const networkOptions = [
  { value: "X", label: "𝕏  X" },
  { value: "THREADS", label: "🧵  Threads" },
  { value: "FACEBOOK", label: "📘  Facebook" },
];

const isPaused = computed(() => flowControl.pauseAll || flowControl.flows.engagement);

const engagementActive = computed(() => engagement.scheduler?.enabled && !isPaused.value);

const sessionStatusVariant: Record<string, "success" | "warning" | "info" | "error" | "neutral"> = {
  ACTIVE: "info",
  COMPLETED: "success",
  FAILED: "error",
};

const interactionTotal = computed(() => engagement.stats?.total ?? 0);
const interactionCompleted = computed(() => engagement.stats?.completed ?? 0);
const interactionFailed = computed(() => engagement.stats?.failed ?? 0);

onMounted(() => {
  engagement.fetchAll();
  flowControl.fetchStatus();
});

async function toggleEngagement() {
  if (isPaused.value) {
    await flowControl.resumeFlow("engagement");
    toast.success("Engagement autopilot resumed");
  } else {
    await flowControl.pauseFlow("engagement", "Manual pause from Autonomous Agent panel");
    toast.warning("Engagement autopilot paused");
  }
}

async function startBrowsingSession() {
  if (!selectedNetwork.value) return;
  isStarting.value = true;
  try {
    await engagement.startBrowsingSession(selectedNetwork.value);
    toast.success(`Browsing session started on ${selectedNetwork.value}`);
    await engagement.fetchAll();
  } catch (err) {
    toast.error(`Failed to start session: ${(err as Error).message}`);
  } finally {
    isStarting.value = false;
  }
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}
</script>

<template>
  <div class="space-y-6">
    <SectionHeader
      title="Autonomous Agent"
      description="Engagement autopilot — browse feeds, like, comment, repost and quote like a human."
    />

    <LoadingSpinner v-if="engagement.loading" />
    <ErrorState v-else-if="engagement.error" :message="engagement.error" />

    <div v-else class="space-y-6">
      <!-- Master controls -->
      <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <!-- Agent status -->
        <Card class="p-5" :class="engagementActive ? 'border-success/50' : 'border-warning/50'">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-4">
              <div
                class="rounded-lg p-3"
                :class="engagementActive ? 'bg-success/10' : 'bg-warning/10'"
              >
                <Bot class="h-8 w-8" :class="engagementActive ? 'text-success' : 'text-warning'" />
              </div>
              <div>
                <h3
                  class="text-lg font-semibold"
                  :class="engagementActive ? 'text-success' : 'text-warning'"
                >
                  {{ engagementActive ? "AUTOPILOT ACTIVE" : "AUTOPILOT PAUSED" }}
                </h3>
                <p class="text-sm text-text-secondary">
                  {{
                    engagementActive
                      ? "Engagement browsing sessions can run."
                      : "All new engagement sessions are blocked until resumed."
                  }}
                </p>
              </div>
            </div>
            <Button
              :variant="isPaused ? 'primary' : 'secondary'"
              size="lg"
              :loading="flowControl.loading"
              @click="toggleEngagement"
            >
              <Play v-if="isPaused" class="mr-2 h-4 w-4" />
              <Pause v-else class="mr-2 h-4 w-4" />
              {{ isPaused ? "Resume" : "Pause" }}
            </Button>
          </div>
        </Card>

        <!-- Scheduler card -->
        <Card class="p-5">
          <div class="flex items-center gap-3">
            <div class="rounded-lg bg-surface-elevated p-3">
              <Timer class="h-6 w-6 text-text-secondary" />
            </div>
            <div>
              <h4 class="font-semibold">Scheduler</h4>
              <p class="text-sm text-text-secondary">
                {{ engagement.scheduler?.enabled ? "Enabled" : "Disabled" }}
                · {{ engagement.scheduler?.sessionsPerDay ?? 0 }} sessions/day ·
                {{ engagement.scheduler?.pendingSessions ?? 0 }} pending
              </p>
              <p class="text-xs text-text-muted">
                Windows: {{ engagement.scheduler?.windows?.join(", ") ?? "—" }} · Jitter: ±{{
                  engagement.scheduler?.jitterMinutes ?? 0
                }}
                min
              </p>
            </div>
          </div>
        </Card>
      </div>

      <!-- Manual start control -->
      <Card class="p-5">
        <div class="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div class="flex-1">
            <label class="mb-1.5 block text-sm font-medium text-text-secondary">Network</label>
            <Select v-model="selectedNetwork" :options="networkOptions" />
          </div>
          <Button
            :disabled="!selectedNetwork || isStarting"
            :loading="isStarting"
            @click="startBrowsingSession"
          >
            <Play class="mr-2 h-4 w-4" />
            Start Browsing Session
          </Button>
        </div>
      </Card>

      <!-- Stats -->
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card class="p-4">
          <div class="flex items-center gap-3">
            <Activity class="h-5 w-5 text-primary" />
            <div>
              <p class="text-xs text-text-muted">Total Interactions</p>
              <p class="text-2xl font-semibold">{{ interactionTotal }}</p>
            </div>
          </div>
        </Card>
        <Card class="p-4">
          <div class="flex items-center gap-3">
            <Gauge class="h-5 w-5 text-success" />
            <div>
              <p class="text-xs text-text-muted">Completed</p>
              <p class="text-2xl font-semibold">{{ interactionCompleted }}</p>
            </div>
          </div>
        </Card>
        <Card class="p-4">
          <div class="flex items-center gap-3">
            <Activity class="h-5 w-5 text-error" />
            <div>
              <p class="text-xs text-text-muted">Failed</p>
              <p class="text-2xl font-semibold">{{ interactionFailed }}</p>
            </div>
          </div>
        </Card>
      </div>

      <!-- By type -->
      <Card
        v-if="engagement.stats?.byType && Object.keys(engagement.stats.byType).length > 0"
        class="p-5"
      >
        <h4 class="mb-4 text-sm font-semibold text-text-secondary">Interactions by type</h4>
        <div class="flex flex-wrap gap-2">
          <Badge v-for="(count, type) in engagement.stats.byType" :key="type" variant="neutral">
            {{ type }}: {{ count }}
          </Badge>
        </div>
      </Card>

      <!-- Recent browsing sessions -->
      <Card class="p-0">
        <template #header>
          <div class="flex items-center gap-3 p-5">
            <List class="h-5 w-5 text-text-secondary" />
            <h4 class="font-semibold">Recent Browsing Sessions</h4>
          </div>
        </template>

        <div class="border-t border-border">
          <EmptyState
            v-if="engagement.browsingSessions.length === 0"
            message="No browsing sessions yet."
          />
          <div
            v-for="session in engagement.browsingSessions"
            :key="session.id"
            class="flex flex-col gap-2 border-b border-border p-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
          >
            <div class="flex items-center gap-3">
              <Badge :variant="sessionStatusVariant[session.status] ?? 'neutral'">
                {{ session.status }}
              </Badge>
              <div>
                <p class="text-sm font-medium text-text-primary">
                  {{ session.network }} · {{ session.postsViewed }} posts viewed,
                  {{ session.interactionsCount }} interactions
                </p>
                <p class="text-xs text-text-muted">Started {{ formatTime(session.startedAt) }}</p>
              </div>
            </div>
            <p v-if="session.errorMessage" class="text-xs text-error sm:text-right">
              {{ session.errorMessage }}
            </p>
          </div>
        </div>
      </Card>
    </div>
  </div>
</template>
