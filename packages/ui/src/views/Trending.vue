<script setup lang="ts">
import { ref, onMounted } from "vue";
import { TrendingUp, RefreshCw, Flame, Calendar, AlertTriangle } from "@lucide/vue";
import { useStatsStore, type TrendingTopic, type MergedTrendingTopic } from "../stores/stats";
import { Card, Button, Badge, SectionHeader } from "../components/ui";
import LoadingSpinner from "../components/LoadingSpinner.vue";
import ErrorState from "../components/ErrorState.vue";
import EmptyState from "../components/EmptyState.vue";
import NetworkIcon from "../components/NetworkIcon.vue";

const statsStore = useStatsStore();
const loading = ref(true);
const error = ref<string | null>(null);
const scraping = ref(false);

const eventTopics = ref<TrendingTopic[]>([]);
const mergedTopics = ref<MergedTrendingTopic[]>([]);

async function loadEvents() {
  try {
    await statsStore.fetchTrending();
    eventTopics.value = statsStore.trending;
  } catch (err) {
    error.value = (err as Error).message ?? "Failed to load trending topics";
  }
}

async function loadMerged() {
  scraping.value = true;
  error.value = null;
  try {
    await statsStore.fetchMergedTrends();
    mergedTopics.value = statsStore.mergedTrending;
  } catch (err) {
    error.value =
      (err as Error).message ?? "Failed to load merged trends (requires localhost access)";
  } finally {
    scraping.value = false;
  }
}

onMounted(async () => {
  loading.value = true;
  await loadEvents();
  loading.value = false;
});

const sourceLabels: Record<string, string> = {
  events: "Events",
  google_trends: "Google",
  x_trends: "X",
};

function formatSources(sources: string[]) {
  return sources.map((s) => sourceLabels[s] ?? s).join(" · ");
}

function formatDays(days: number): string {
  if (days === 0) return "Today";
  if (days > 0) return `In ${days} day${days > 1 ? "s" : ""}`;
  return `${Math.abs(days)} day${Math.abs(days) > 1 ? "s" : ""} ago`;
}
</script>

<template>
  <div>
    <SectionHeader
      title="Trending Topics"
      description="Trending events and merged trends from X + Google."
    />

    <div class="mb-6 flex items-center justify-between">
      <p class="text-sm text-text-secondary">Events with 🔥 are currently trending.</p>
      <Button :loading="scraping" variant="secondary" size="sm" @click="loadMerged">
        <RefreshCw class="h-4 w-4" />
        {{ scraping ? "Scraping..." : "Refresh X + Google Trends" }}
      </Button>
    </div>

    <LoadingSpinner v-if="loading" />
    <ErrorState v-else-if="error && eventTopics.length === 0" :message="error" />
    <div v-else class="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <!-- Trending events -->
      <Card>
        <template #header>
          <div class="flex items-center gap-2">
            <Calendar class="h-5 w-5 text-info" />
            <h2 class="text-lg font-semibold text-text-primary">Trending Events Calendar</h2>
          </div>
        </template>

        <EmptyState v-if="eventTopics.length === 0" message="No upcoming events." />
        <div v-else class="space-y-3">
          <div
            v-for="topic in eventTopics"
            :key="topic.event"
            class="rounded-lg border p-4"
            :class="
              topic.trending
                ? 'border-primary/50 bg-primary-subtle'
                : 'border-border bg-surface-elevated'
            "
          >
            <div class="flex items-start justify-between gap-3">
              <div>
                <div class="flex items-center gap-2">
                  <Flame v-if="topic.trending" class="h-4 w-4 text-primary" />
                  <span class="font-medium text-text-primary">{{ topic.event }}</span>
                </div>
                <p class="mt-1 text-sm text-text-secondary">{{ topic.topic }}</p>
              </div>
              <Badge :variant="topic.trending ? 'primary' : 'neutral'">
                {{ formatDays(topic.daysUntil) }}
              </Badge>
            </div>
            <div class="mt-3 flex flex-wrap gap-2">
              <NetworkIcon v-for="net in topic.networks" :key="net" :network="net" />
            </div>
          </div>
        </div>
      </Card>

      <!-- Merged trends -->
      <div class="space-y-6">
        <Card v-if="mergedTopics.length > 0">
          <template #header>
            <div class="flex items-center gap-2">
              <TrendingUp class="h-5 w-5 text-primary" />
              <h2 class="text-lg font-semibold text-text-primary">Merged Trends</h2>
              <p class="text-sm text-text-secondary">X + Google + Events</p>
            </div>
          </template>

          <div class="space-y-3">
            <div
              v-for="(topic, i) in mergedTopics"
              :key="topic.topic + i"
              class="flex items-center justify-between border-b border-border pb-3 last:border-0"
            >
              <div>
                <span class="text-sm text-text-primary">{{ topic.topic }}</span>
                <span class="ml-2 text-xs text-text-muted"
                  >({{ formatSources(topic.sources) }})</span
                >
              </div>
              <Badge v-if="topic.priority" variant="secondary">{{ topic.priority }}</Badge>
            </div>
          </div>
        </Card>

        <!-- Scrape note / error -->
        <div
          v-if="error && eventTopics.length > 0"
          class="rounded-lg border border-warning/30 bg-warning-subtle p-4"
        >
          <div class="flex items-start gap-2">
            <AlertTriangle class="mt-0.5 h-4 w-4 text-warning" />
            <div>
              <p class="text-sm text-warning">{{ error }}</p>
              <p class="mt-1 text-xs text-text-secondary">
                X/Google trend scraping requires localhost access.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
