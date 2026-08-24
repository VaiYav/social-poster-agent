<script setup lang="ts">
import { ref, onMounted, watch, computed } from "vue";
import {
  Sparkles,
  Recycle,
  BookOpen,
  TrendingUp,
  Calendar,
  Play,
  Pause,
  RefreshCw,
} from "@lucide/vue";
import { useStatsStore } from "../stores/stats";
import { useToast } from "../composables/useToast";
import { useSSE } from "../composables/useSSE";
import { useApi } from "../composables/useApi";
import type { SSEvent } from "@spa/shared";
import {
  Card,
  Button,
  Input,
  Select,
  Checkbox,
  ProgressBar,
  Badge,
  SectionHeader,
} from "../components/ui";
import LoadingSpinner from "../components/LoadingSpinner.vue";
import ErrorState from "../components/ErrorState.vue";
import EmptyState from "../components/EmptyState.vue";

const statsStore = useStatsStore();
const toast = useToast();
// REFACTOR-100: all requests go through the shared axios instance (auth cookie,
// correlation ID, normalized errors) — no raw fetch() bypassing interceptors.
const api = useApi();

const count = ref(3);
const networks = ref<string[]>(["X", "THREADS", "FACEBOOK"]);
const sourceType = ref<"brief" | "article" | "topic" | "create_run">("brief");
const selectedModel = ref<string>("");
const multiStage = ref(false);
const repurposing = ref(false);
const recycling = ref(false);
const generating = ref(false);
const result = ref<string | null>(null);
const resultError = ref<string | null>(null);

interface ProgressEvent {
  node: string;
  topic: string;
  postsCount: number;
  error: string | null;
}
const progressEvents = ref<ProgressEvent[]>([]);
const activeRunId = ref<string | null>(null);
const progressPct = computed(() => {
  if (progressEvents.value.length === 0) return 0;
  const NODE_COUNT = 13;
  return Math.min(100, Math.round((progressEvents.value.length / NODE_COUNT) * 100));
});

// Use shared SSE composable (exponential backoff, jitter, cleanup on unmount)
const apiBase = import.meta.env.VITE_API_URL ?? "/api/v1";
const { data: sseData } = useSSE(`${apiBase}/events/sse`, { maxRetries: 50 });

watch(sseData, (data: SSEvent | null) => {
  if (!data) return;
  if (data.type === "generation_started") {
    activeRunId.value = data.runId ?? null;
    progressEvents.value = [];
  } else if (data.type === "generation_progress") {
    progressEvents.value.push({
      node: data.node ?? "",
      topic: data.topic ?? "",
      postsCount: data.postsCount ?? 0,
      error: data.error ?? null,
    });
  } else if (data.type === "generation_completed") {
    activeRunId.value = null;
    generating.value = false;
    toast.success(`Generation completed: ${data.postCount} posts created`);
    statsStore.fetchRuns();
  } else if (data.type === "generation_failed") {
    activeRunId.value = null;
    generating.value = false;
    toast.error(`Generation failed: ${data.error}`);
  } else if (data.type === "generation_paused") {
    activeRunId.value = null;
    generating.value = false;
    toast.warning("Generation paused");
  } else if (data.type === "generation_resumed") {
    activeRunId.value = data.runId ?? null;
    generating.value = true;
    toast.success("Generation resumed");
  }
});

onMounted(() => {
  statsStore.fetchRuns();
  statsStore.fetchModels();
  statsStore.fetchTrending();
});

async function generate() {
  generating.value = true;
  result.value = null;
  resultError.value = null;
  progressEvents.value = [];
  try {
    const data = await statsStore.triggerGeneration(
      count.value,
      networks.value,
      sourceType.value,
      multiStage.value,
      selectedModel.value || undefined,
    );
    result.value = `Generation started: ${data.runId ?? "ok"}`;
    activeRunId.value = data.runId ?? null;
    toast.success(`Generation started (run ${data.runId?.slice(0, 8) ?? "ok"})`);
  } catch (e: unknown) {
    resultError.value = (e as Error).message;
    toast.error(`Generation failed: ${(e as Error).message}`);
    generating.value = false;
  }
}

async function repurpose() {
  repurposing.value = true;
  result.value = null;
  resultError.value = null;
  try {
    const data = await statsStore.repurposeArticles(2, networks.value);
    result.value = `Repurposing started: ${data.runId ?? "ok"}`;
    toast.success(`Repurposing started (run ${data.runId?.slice(0, 8) ?? "ok"})`);
  } catch (e: unknown) {
    resultError.value = (e as Error).message;
    toast.error(`Repurposing failed: ${(e as Error).message}`);
  } finally {
    repurposing.value = false;
  }
}

async function recycle() {
  recycling.value = true;
  result.value = null;
  resultError.value = null;
  try {
    const res = await api.post<{ runId: string }>("/generation/recycle", {
      minAgeDays: 30,
      postCount: 3,
      networks: networks.value,
    });
    const data = res.data;
    result.value = `Recycling started: ${data.runId ?? "ok"}`;
    toast.success(`Recycling started (run ${data.runId?.slice(0, 8) ?? "ok"})`);
  } catch (e: unknown) {
    resultError.value = (e as Error).message;
    toast.error(`Recycling failed: ${(e as Error).message}`);
  } finally {
    recycling.value = false;
  }
}

async function pauseRun() {
  if (!activeRunId.value) return;
  try {
    await api.post(`/generation/runs/${activeRunId.value}/pause`);
  } catch (e) {
    toast.error(`Pause failed: ${(e as Error).message}`);
  }
}

async function resumeRun(runId: string) {
  try {
    await api.post(`/generation/runs/${runId}/resume`);
    generating.value = true;
    activeRunId.value = runId;
  } catch (e) {
    toast.error(`Resume failed: ${(e as Error).message}`);
  }
}

const sourceTypeOptions = [
  { value: "brief", label: "Brief" },
  { value: "article", label: "Article" },
  { value: "topic", label: "Topic" },
  { value: "create_run", label: "Create Run" },
];

const networkConfig: Record<string, { icon: string; color: string }> = {
  X: { icon: "𝕏", color: "text-text-primary" },
  THREADS: { icon: "🧵", color: "text-secondary" },
  FACEBOOK: { icon: "📘", color: "text-info" },
};

const statusBadge: Record<string, "success" | "warning" | "error" | "info" | "neutral"> = {
  COMPLETED: "success",
  RUNNING: "info",
  FAILED: "error",
};
</script>

<template>
  <div>
    <SectionHeader
      title="Generate Posts"
      description="Create fresh content, repurpose articles, or recycle top performers."
    />

    <!-- Trending / Upcoming -->
    <div class="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card v-if="statsStore.trending.filter((t) => t.trending).length > 0" glow="primary">
        <template #header>
          <div class="flex items-center gap-2">
            <TrendingUp class="h-4 w-4 text-primary" />
            <h2 class="font-semibold text-text-primary">Trending Now</h2>
          </div>
        </template>
        <div class="space-y-3">
          <div
            v-for="t in statsStore.trending.filter((t) => t.trending)"
            :key="t.event"
            class="rounded-lg bg-primary-subtle p-3"
          >
            <div class="font-medium text-text-primary">{{ t.event }}</div>
            <div class="text-sm text-text-secondary">{{ t.topic }}</div>
            <div class="mt-1 text-xs text-primary">
              {{
                t.daysUntil === 0
                  ? "today"
                  : t.daysUntil > 0
                    ? `in ${t.daysUntil}d`
                    : `${Math.abs(t.daysUntil)}d ago`
              }}
            </div>
          </div>
        </div>
      </Card>

      <Card
        v-if="
          statsStore.trending.filter((t) => !t.trending && t.daysUntil > 0 && t.daysUntil <= 14)
            .length > 0
        "
      >
        <template #header>
          <div class="flex items-center gap-2">
            <Calendar class="h-4 w-4 text-info" />
            <h2 class="font-semibold text-text-primary">Upcoming Calendar Events</h2>
          </div>
        </template>
        <div class="space-y-2">
          <div
            v-for="t in statsStore.trending.filter(
              (t) => !t.trending && t.daysUntil > 0 && t.daysUntil <= 14,
            )"
            :key="t.event"
            class="flex items-center justify-between text-sm"
          >
            <span class="text-text-secondary">{{ t.event }}</span>
            <Badge variant="info">in {{ t.daysUntil }} days</Badge>
          </div>
        </div>
      </Card>
    </div>

    <div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <!-- Generation Form -->
      <Card class="lg:col-span-1">
        <template #header>
          <div class="flex items-center gap-2">
            <Sparkles class="h-5 w-5 text-primary" />
            <h2 class="text-lg font-semibold text-text-primary">New Generation</h2>
          </div>
        </template>

        <div class="space-y-5">
          <div>
            <label class="mb-1.5 block text-sm font-medium text-text-secondary">Count</label>
            <Input v-model.number="count" type="number" min="1" max="10" />
          </div>

          <div>
            <label class="mb-1.5 block text-sm font-medium text-text-secondary">Source Type</label>
            <Select v-model="sourceType" :options="sourceTypeOptions" />
          </div>

          <div v-if="statsStore.models.length > 0">
            <label class="mb-1.5 block text-sm font-medium text-text-secondary">LLM Model</label>
            <Select
              v-model="selectedModel"
              :options="[
                { value: '', label: 'Auto (provider chain)' },
                ...statsStore.models.map((m) => ({
                  value: `${m.provider}/${m.model}`,
                  label: `${m.provider} / ${m.model}${m.free ? ' (FREE)' : ''}`,
                })),
              ]"
            />
            <p class="mt-1.5 text-xs text-text-muted">
              Auto uses the configured fallback chain. A selected model is tried first and falls
              back on failure.
            </p>
          </div>

          <div>
            <label class="mb-2 block text-sm font-medium text-text-secondary">Networks</label>
            <div class="flex flex-wrap gap-4">
              <label
                v-for="net in ['X', 'THREADS', 'FACEBOOK']"
                :key="net"
                class="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-surface-elevated px-3 py-2 transition-colors hover:border-border-strong"
              >
                <Checkbox
                  :model-value="networks.includes(net)"
                  @update:model-value="
                    (checked) => {
                      if (checked) networks.push(net);
                      else networks = networks.filter((n) => n !== net);
                    }
                  "
                />
                <span class="text-sm" :class="networkConfig[net]?.color"
                  >{{ networkConfig[net]?.icon }} {{ net }}</span
                >
              </label>
            </div>
          </div>

          <label
            class="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-surface-elevated p-3 transition-colors hover:border-border-strong"
          >
            <Checkbox v-model="multiStage" id="multiStage" />
            <div>
              <div class="text-sm font-medium text-text-primary">Multi-Stage Thread</div>
              <div class="text-xs text-text-muted">Hook + continuation thread</div>
            </div>
          </label>

          <Button
            :loading="generating"
            :disabled="repurposing || recycling || networks.length === 0"
            class="w-full"
            @click="generate"
          >
            <Sparkles class="h-4 w-4" />
            {{ generating ? "Generating..." : "Generate" }}
          </Button>

          <div class="grid grid-cols-2 gap-3">
            <Button
              variant="secondary"
              :loading="repurposing"
              :disabled="generating || recycling"
              class="w-full"
              @click="repurpose"
            >
              <BookOpen class="h-4 w-4" />
              Repurpose
            </Button>
            <Button
              variant="outline"
              :loading="recycling"
              :disabled="generating || repurposing"
              class="w-full"
              @click="recycle"
            >
              <Recycle class="h-4 w-4" />
              Recycle
            </Button>
          </div>

          <p v-if="result" class="text-sm text-success">{{ result }}</p>
          <p v-if="resultError" class="text-sm text-error">Error: {{ resultError }}</p>
        </div>
      </Card>

      <!-- Progress + Runs -->
      <div class="space-y-6 lg:col-span-2">
        <Card v-if="generating && progressEvents.length > 0">
          <template #header>
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <RefreshCw class="h-5 w-5 animate-spin text-primary" />
                <h2 class="text-lg font-semibold text-text-primary">Generation Progress</h2>
              </div>
              <Button v-if="activeRunId" variant="outline" size="sm" @click="pauseRun">
                <Pause class="h-4 w-4" />
                Pause
              </Button>
            </div>
          </template>

          <ProgressBar :value="progressPct" color="primary" />

          <div class="mt-4 max-h-40 space-y-2 overflow-y-auto rounded-lg bg-surface p-3">
            <div
              v-for="(ev, idx) in progressEvents.slice(-8)"
              :key="idx"
              class="text-sm"
              :class="ev.error ? 'text-error' : 'text-text-secondary'"
            >
              <span class="font-mono text-xs text-text-muted">{{ ev.node }}</span>
              <span class="mx-2 text-border-strong">·</span>
              {{ ev.topic.slice(0, 45) }}{{ ev.topic.length > 45 ? "…" : "" }}
              <span v-if="ev.error" class="ml-2 text-xs text-error"
                >⚠ {{ ev.error.slice(0, 40) }}</span
              >
            </div>
          </div>
        </Card>

        <Card>
          <template #header>
            <h2 class="text-lg font-semibold text-text-primary">Generation Runs</h2>
            <p class="text-sm text-text-secondary">History of content generation jobs</p>
          </template>

          <LoadingSpinner v-if="statsStore.loading" />
          <ErrorState v-else-if="statsStore.error" :message="statsStore.error" />
          <EmptyState v-else-if="statsStore.runs.length === 0" message="No generation runs yet." />
          <div v-else class="space-y-3">
            <div
              v-for="run in statsStore.runs"
              :key="run.id"
              class="flex items-center justify-between rounded-lg border border-border bg-surface-elevated p-4"
            >
              <div>
                <div class="flex items-center gap-2">
                  <span class="text-sm font-medium text-text-primary">{{ run.triggeredBy }}</span>
                  <Badge :variant="statusBadge[run.status] ?? 'neutral'">
                    <template #dot><span /></template>
                    {{ run.status }}
                  </Badge>
                </div>
                <div class="mt-1 text-xs text-text-muted">
                  {{ run._count.posts }} posts · {{ new Date(run.startedAt).toLocaleString() }}
                </div>
                <p v-if="run.errorMessage" class="mt-1 text-xs text-error">
                  {{ run.errorMessage }}
                </p>
              </div>
              <Button
                v-if="run.status === 'FAILED'"
                variant="secondary"
                size="sm"
                @click="resumeRun(run.id)"
              >
                <Play class="h-3.5 w-3.5" />
                Resume
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  </div>
</template>
