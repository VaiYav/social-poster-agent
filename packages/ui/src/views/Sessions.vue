<script setup lang="ts">
import { onMounted } from "vue";
import { Globe, HeartPulse, Gauge, Timer, Activity } from "@lucide/vue";
import { useSessionsStore } from "../stores/sessions";
import { Card, Button, Badge, ProgressBar, SectionHeader } from "../components/ui";
import LoadingSpinner from "../components/LoadingSpinner.vue";
import ErrorState from "../components/ErrorState.vue";
import EmptyState from "../components/EmptyState.vue";

const sessionsStore = useSessionsStore();

onMounted(() => sessionsStore.fetchAll());

async function healthCheck(network: string) {
  await sessionsStore.healthCheck(network);
}

function warmupDaysElapsed(startedAt: string | null): number {
  if (!startedAt) return 0;
  const start = new Date(startedAt).getTime();
  const now = Date.now();
  return Math.floor((now - start) / (1000 * 60 * 60 * 24));
}

function warmupPhase(days: number): string {
  if (days <= 2) return "Browse-only (days 1–2)";
  if (days <= 5) return "Light interactions (days 3–5)";
  if (days <= 7) return "Moderate (days 6–7)";
  return "Full activity (day 8+)";
}

function rateLimitFor(network: string | undefined) {
  if (!network) return null;
  return sessionsStore.rateLimits[network] ?? null;
}

const statusVariant: Record<string, "success" | "warning" | "info" | "error" | "neutral"> = {
  ACTIVE: "success",
  EXPIRED: "warning",
  WARMUP: "info",
  ERROR: "error",
  BANNED: "error",
};

const networkIcons: Record<string, string> = {
  X: "𝕏",
  THREADS: "🧵",
  FACEBOOK: "📘",
};
</script>

<template>
  <div>
    <SectionHeader
      title="Sessions"
      description="Account health, warm-up progress, and rate limits."
    />

    <LoadingSpinner v-if="sessionsStore.loading" />
    <ErrorState v-else-if="sessionsStore.error" :message="sessionsStore.error" />
    <EmptyState v-else-if="sessionsStore.sessions.length === 0" message="No sessions configured." />
    <div v-else class="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card v-for="session in sessionsStore.sessions" :key="session.id" hoverable>
        <template #header>
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <div
                class="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-highlight text-lg"
              >
                {{ networkIcons[session.account?.network ?? ""] ?? "?" }}
              </div>
              <div>
                <h2 class="font-semibold text-text-primary">
                  {{ session.account?.network ?? "Unknown" }}
                </h2>
                <p class="text-xs text-text-muted">@{{ session.account?.handle ?? "N/A" }}</p>
              </div>
            </div>
            <Badge :variant="statusVariant[session.status] ?? 'neutral'">
              <template #dot><span /></template>
              {{ session.status }}
            </Badge>
          </div>
        </template>

        <!-- Warm-up status (F20) -->
        <div v-if="session.account?.warmupEnabled" class="mb-4 rounded-lg bg-info-subtle p-3">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2 text-sm font-medium text-info">
              <Activity class="h-4 w-4" />
              Warm-up Mode
            </div>
            <span class="text-xs text-info">
              Day {{ warmupDaysElapsed(session.account?.warmupStartedAt ?? null) }} /
              {{ session.account?.warmupDaysTotal ?? 7 }}
            </span>
          </div>
          <ProgressBar
            class="mt-2"
            :value="
              Math.min(
                100,
                (warmupDaysElapsed(session.account?.warmupStartedAt ?? null) /
                  (session.account?.warmupDaysTotal ?? 7)) *
                  100,
              )
            "
            color="info"
            :show-label="false"
          />
          <p class="mt-2 text-xs text-text-secondary">
            {{ warmupPhase(warmupDaysElapsed(session.account?.warmupStartedAt ?? null)) }}
          </p>
        </div>

        <!-- Rate limit status -->
        <div
          v-if="rateLimitFor(session.account?.network)"
          class="mb-4 rounded-lg bg-surface-elevated p-3"
        >
          <div class="flex items-center justify-between text-sm">
            <span class="flex items-center gap-1.5 text-text-secondary">
              <Gauge class="h-4 w-4" />
              Rate Limits
            </span>
            <span
              :class="
                rateLimitFor(session.account?.network)!.dailyCount <
                rateLimitFor(session.account?.network)!.dailyLimit
                  ? 'text-success'
                  : 'text-error'
              "
            >
              {{ rateLimitFor(session.account?.network)!.dailyCount }} /
              {{ rateLimitFor(session.account?.network)!.dailyLimit }} daily
            </span>
          </div>
          <div class="mt-2 flex items-center justify-between text-xs text-text-muted">
            <span class="flex items-center gap-1.5">
              <Timer class="h-3.5 w-3.5" />
              Weekly: {{ rateLimitFor(session.account?.network)!.weeklyCount }} /
              {{ rateLimitFor(session.account?.network)!.weeklyLimit }}
            </span>
            <span v-if="rateLimitFor(session.account?.network)!.lastPostAt">
              Last:
              {{
                new Date(rateLimitFor(session.account?.network)!.lastPostAt!).toLocaleTimeString()
              }}
            </span>
            <span v-else>No posts today</span>
          </div>
        </div>

        <div class="flex items-center justify-between">
          <div class="flex items-center gap-1.5 text-xs text-text-muted">
            <HeartPulse class="h-3.5 w-3.5" />
            Last check: {{ session.lastHealthCheck ?? "never" }}
          </div>
          <Button variant="outline" size="sm" @click="healthCheck(session.account?.network ?? '')">
            <Globe class="h-3.5 w-3.5" />
            Health Check
          </Button>
        </div>
      </Card>
    </div>
  </div>
</template>
