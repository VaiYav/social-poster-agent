<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { Send, X, RefreshCw, MessageSquare, Activity } from "@lucide/vue";
import { useRepliesStore } from "../stores/replies";
import { useToast } from "../composables/useToast";
import { Card, Button, SectionHeader, Badge, Textarea } from "../components/ui";
import NetworkIcon from "../components/NetworkIcon.vue";
import LoadingSpinner from "../components/LoadingSpinner.vue";
import ErrorState from "../components/ErrorState.vue";
import EmptyState from "../components/EmptyState.vue";

const repliesStore = useRepliesStore();
const toast = useToast();
const replyText = ref<Record<string, string>>({});
const running = ref(false);

onMounted(() => {
  repliesStore.fetchAll();
});

const hasPending = computed(() => repliesStore.pendingCount > 0);

function formatTime(iso: string) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

async function handleRefresh() {
  await repliesStore.fetchAll();
}

async function handleRunCycle() {
  if (running.value) return;
  running.value = true;
  try {
    await repliesStore.runCycle();
    toast.success("Replies monitoring cycle triggered");
  } catch (err) {
    toast.error((err as Error).message);
  } finally {
    running.value = false;
  }
}

async function handleManualReply(id: string) {
  const text = replyText.value[id]?.trim();
  if (!text) return;
  await repliesStore.manualReply(id, text);
  replyText.value[id] = "";
  toast.success("Reply posted");
}

async function handleDismiss(id: string) {
  await repliesStore.dismiss(id);
  toast.info("Comment dismissed");
}
</script>

<template>
  <div class="p-6">
    <SectionHeader
      title="Replies"
      description="Monitor and manage replies to your posts. Auto-replies run on a schedule; flagged comments appear here for human review."
    />

    <!-- Stats -->
    <div
      v-if="repliesStore.stats"
      class="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6"
    >
      <Card class="p-4">
        <p class="text-xs text-text-secondary">Enabled</p>
        <Badge :variant="repliesStore.isEnabled ? 'success' : 'neutral'" class="mt-1">
          {{ repliesStore.isEnabled ? "Yes" : "No" }}
        </Badge>
      </Card>
      <Card class="p-4">
        <p class="text-xs text-text-secondary">Pending Review</p>
        <p class="mt-1 text-2xl font-semibold text-text-primary">
          {{ repliesStore.stats.pendingReview }}
        </p>
      </Card>
      <Card class="p-4">
        <p class="text-xs text-text-secondary">New</p>
        <p class="mt-1 text-2xl font-semibold text-text-primary">
          {{ repliesStore.stats.counts.new }}
        </p>
      </Card>
      <Card class="p-4">
        <p class="text-xs text-text-secondary">Replied</p>
        <p class="mt-1 text-2xl font-semibold text-text-primary">
          {{ repliesStore.stats.counts.replied }}
        </p>
      </Card>
      <Card class="p-4">
        <p class="text-xs text-text-secondary">Replied Manual</p>
        <p class="mt-1 text-2xl font-semibold text-text-primary">
          {{ repliesStore.stats.counts.repliedManual }}
        </p>
      </Card>
      <Card class="p-4">
        <p class="text-xs text-text-secondary">Skipped</p>
        <p class="mt-1 text-2xl font-semibold text-text-primary">
          {{ repliesStore.stats.counts.skipped }}
        </p>
      </Card>
    </div>

    <!-- Controls -->
    <div class="mb-6 flex items-center gap-3">
      <Button variant="outline" size="sm" :loading="repliesStore.loading" @click="handleRefresh">
        <RefreshCw class="mr-1 h-3.5 w-3.5" />
        Refresh
      </Button>
      <Button size="sm" :loading="running" @click="handleRunCycle">
        <Activity class="mr-1 h-3.5 w-3.5" />
        Run Cycle
      </Button>
      <div v-if="repliesStore.lastCycle" class="ml-auto text-xs text-text-muted">
        Last cycle: {{ repliesStore.lastCycle.repliesPosted }} posted,
        {{ repliesStore.lastCycle.humanReview }} need review
      </div>
    </div>

    <!-- Loading / Error -->
    <LoadingSpinner v-if="repliesStore.loading && !repliesStore.pending.length" />
    <ErrorState v-else-if="repliesStore.error" :message="repliesStore.error" />

    <!-- Pending Human-Review Comments -->
    <Card v-else>
      <template #header>
        <div class="flex items-center justify-between">
          <div>
            <h2 class="text-lg font-semibold text-text-primary">Comments Needing Review</h2>
            <p class="text-sm text-text-secondary">Review, reply, or dismiss flagged comments</p>
          </div>
          <Badge variant="warning" class="gap-1">
            <MessageSquare class="h-3 w-3" />
            {{ repliesStore.pendingCount }}
          </Badge>
        </div>
      </template>

      <div v-if="!hasPending" class="py-8">
        <EmptyState message="No comments need human review right now." />
      </div>

      <div v-else class="space-y-4">
        <div
          v-for="item in repliesStore.pending"
          :key="item.id"
          class="rounded-lg border border-border p-4"
        >
          <div class="mb-3 flex items-start justify-between">
            <div class="flex flex-wrap items-center gap-2">
              <NetworkIcon :network="item.network" />
              <span class="text-sm font-medium text-text-primary">@{{ item.author }}</span>
              <span class="text-xs text-text-muted">{{ formatTime(item.scrapedAt) }}</span>
            </div>
            <Badge variant="warning">{{ item.humanReviewReason ?? "Review needed" }}</Badge>
          </div>

          <p class="mb-4 text-sm text-text-secondary">{{ item.text }}</p>

          <div class="flex flex-col gap-3 sm:flex-row sm:items-end">
            <Textarea
              v-model="replyText[item.id]"
              placeholder="Type a reply..."
              :rows="2"
              class="flex-1"
            />
            <div class="flex gap-2">
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
          </div>

          <p v-if="item.replyText" class="mt-2 text-xs text-text-muted">
            Suggested: {{ item.replyText }}
          </p>
        </div>
      </div>
    </Card>
  </div>
</template>
