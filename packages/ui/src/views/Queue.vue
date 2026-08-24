<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import type { Post, PostReviewFeedback } from "@spa/shared";
import { Play, Pause, Clock, Activity, Timer, CheckSquare, XSquare, Check } from "@lucide/vue";
import { usePostsStore } from "../stores/posts";
import { useQueueStore } from "../stores/queue";
import { useToast } from "../composables/useToast";
import { Card, Button, SectionHeader, Checkbox } from "../components/ui";
import PostCard from "../components/PostCard.vue";
import PostEditor from "../components/PostEditor.vue";
import ReviewFeedbackDialog from "../components/ReviewFeedbackDialog.vue";
import LoadingSpinner from "../components/LoadingSpinner.vue";
import ErrorState from "../components/ErrorState.vue";
import EmptyState from "../components/EmptyState.vue";

const postsStore = usePostsStore();
const queueStore = useQueueStore();
const toast = useToast();
const editingPost = ref<Post | null>(null);
const rejectingPost = ref<Post | null>(null);
const selectedIds = ref<Set<string>>(new Set());

const NETWORKS = ["X", "THREADS", "FACEBOOK"] as const;

const networkIcons: Record<string, string> = {
  X: "𝕏",
  THREADS: "🧵",
  FACEBOOK: "📘",
};

const selectedCount = computed(() => selectedIds.value.size);
const allSelected = computed(
  () => postsStore.drafts.length > 0 && selectedIds.value.size === postsStore.drafts.length,
);

onMounted(() => {
  postsStore.fetchDrafts();
  queueStore.fetchAll();
});

function toggleSelect(id: string) {
  const next = new Set(selectedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds.value = next;
}

function toggleSelectAll() {
  if (allSelected.value) {
    selectedIds.value = new Set();
  } else {
    selectedIds.value = new Set(postsStore.drafts.map((p) => p.id));
  }
}

async function batchApprove() {
  const ids = [...selectedIds.value];
  let ok = 0;
  let fail = 0;
  for (const id of ids) {
    try {
      await postsStore.approve(id);
      ok++;
    } catch {
      fail++;
    }
  }
  toast.success(`Batch approve: ${ok} approved${fail > 0 ? `, ${fail} failed` : ""}`);
  selectedIds.value = new Set();
}

async function batchReject() {
  const ids = [...selectedIds.value];
  let ok = 0;
  let fail = 0;
  for (const id of ids) {
    try {
      await postsStore.reject(id);
      ok++;
    } catch {
      fail++;
    }
  }
  toast.info(`Batch reject: ${ok} rejected${fail > 0 ? `, ${fail} failed` : ""}`);
  selectedIds.value = new Set();
}

async function approve(id: string) {
  try {
    await postsStore.approve(id);
    toast.success("Post approved — added to posting queue");
  } catch (e: unknown) {
    toast.error(`Approve failed: ${(e as Error).message}`);
  }
}

async function reject(id: string) {
  rejectingPost.value = postsStore.drafts.find((post) => post.id === id) ?? null;
}

async function submitRejection(feedback: PostReviewFeedback) {
  const id = rejectingPost.value?.id;
  if (!id) return;
  try {
    await postsStore.reject(id, feedback);
    rejectingPost.value = null;
    toast.info("Post rejected");
  } catch (e: unknown) {
    toast.error(`Reject failed: ${(e as Error).message}`);
  }
}

function edit(post: Post) {
  editingPost.value = post;
}

async function saveEdit(id: string, editedContent: string) {
  try {
    await postsStore.approve(id, editedContent);
    editingPost.value = null;
    toast.success("Post edited and approved");
  } catch (e: unknown) {
    toast.error(`Edit & approve failed: ${(e as Error).message}`);
  }
}

function closeEditor() {
  editingPost.value = null;
}

async function togglePause(network: string) {
  try {
    if (queueStore.paused[network]) {
      await queueStore.resumeQueue(network);
      toast.success(`${network} queue resumed`);
    } else {
      await queueStore.pauseQueue(network);
      toast.info(`${network} queue paused — running jobs will complete`);
    }
  } catch (e: unknown) {
    toast.error(`Queue control failed: ${(e as Error).message}`);
  }
}

async function retryFailed(network: string) {
  try {
    await queueStore.retryFailed(network);
    toast.success(`${network} failed jobs queued for retry`);
  } catch (e: unknown) {
    toast.error(`Retry failed: ${(e as Error).message}`);
  }
}

async function clearCompleted(network: string) {
  try {
    await queueStore.clearCompleted(network);
    toast.info(`${network} completed jobs cleared`);
  } catch (e: unknown) {
    toast.error(`Clear failed: ${(e as Error).message}`);
  }
}
</script>

<template>
  <div>
    <SectionHeader title="Queue" description="Manage posting queues and approve draft posts." />

    <!-- F5: BullMQ Queue Stats + Pause/Resume Controls -->
    <Card class="mb-8">
      <template #header>
        <div class="flex items-center gap-2">
          <Activity class="h-5 w-5 text-primary" />
          <h2 class="text-lg font-semibold text-text-primary">Posting Queue Status</h2>
        </div>
      </template>

      <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div
          v-for="net in NETWORKS"
          :key="net"
          class="rounded-lg border border-border bg-surface-elevated p-4"
          :class="queueStore.paused[net] && 'opacity-70'"
        >
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span class="text-lg">{{ networkIcons[net] }}</span>
              <span class="font-semibold text-text-primary">{{ net }}</span>
            </div>
            <Button
              :variant="queueStore.paused[net] ? 'secondary' : 'outline'"
              size="sm"
              @click="togglePause(net)"
            >
              <Play v-if="queueStore.paused[net]" class="h-3.5 w-3.5" />
              <Pause v-else class="h-3.5 w-3.5" />
              {{ queueStore.paused[net] ? "Resume" : "Pause" }}
            </Button>
          </div>

          <div v-if="queueStore.stats[net]" class="mt-4 grid grid-cols-2 gap-2 text-sm">
            <div class="rounded-md bg-surface p-2">
              <div class="text-xs text-text-muted">Waiting</div>
              <div class="font-semibold text-text-primary">{{ queueStore.stats[net].waiting }}</div>
            </div>
            <div class="rounded-md bg-surface p-2">
              <div class="text-xs text-text-muted">Active</div>
              <div class="font-semibold text-status-running">
                {{ queueStore.stats[net].active }}
              </div>
            </div>
            <div class="rounded-md bg-surface p-2">
              <div class="text-xs text-text-muted">Completed</div>
              <div class="font-semibold text-status-posted">
                {{ queueStore.stats[net].completed }}
              </div>
            </div>
            <div class="rounded-md bg-surface p-2">
              <div class="text-xs text-text-muted">Failed</div>
              <div class="font-semibold text-status-failed">{{ queueStore.stats[net].failed }}</div>
            </div>
          </div>
          <div v-else class="mt-4 text-sm text-text-muted">Loading queue stats...</div>

          <div
            v-if="queueStore.paused[net]"
            class="mt-3 flex items-center gap-1.5 rounded-md bg-warning-subtle p-2 text-xs text-warning"
          >
            <Timer class="h-3.5 w-3.5" />
            Paused — new jobs are held
          </div>
        </div>
      </div>
    </Card>

    <!-- Failed Jobs -->
    <Card class="mb-8">
      <template #header>
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <XSquare class="h-5 w-5 text-status-failed" />
            <div>
              <h2 class="text-lg font-semibold text-text-primary">Failed Queue Jobs</h2>
              <p class="text-sm text-text-secondary">BullMQ dead letters per network</p>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <Button size="sm" variant="outline" @click="queueStore.fetchAll()">
              <RefreshCw class="mr-1 h-3.5 w-3.5" />
              Refresh
            </Button>
          </div>
        </div>
      </template>

      <div class="space-y-4">
        <div v-for="net in NETWORKS" :key="net" class="rounded-lg border border-border p-4">
          <div class="mb-3 flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span class="text-lg">{{ networkIcons[net] }}</span>
              <span class="font-semibold text-text-primary">{{ net }}</span>
              <Badge v-if="queueStore.stats[net]?.failed" variant="error">
                {{ queueStore.stats[net].failed }} failed
              </Badge>
            </div>
            <div class="flex items-center gap-2">
              <Button
                v-if="queueStore.stats[net]?.failed"
                size="sm"
                variant="secondary"
                @click="retryFailed(net)"
              >
                <RefreshCw class="mr-1 h-3.5 w-3.5" />
                Retry all
              </Button>
              <Button size="sm" variant="outline" @click="clearCompleted(net)">
                <XSquare class="mr-1 h-3.5 w-3.5" />
                Clear completed
              </Button>
            </div>
          </div>

          <div
            v-if="!queueStore.failedJobs[net] || queueStore.failedJobs[net].length === 0"
            class="text-sm text-text-muted"
          >
            No failed jobs for {{ net }}.
          </div>
          <div v-else class="space-y-2">
            <div
              v-for="job in queueStore.failedJobs[net]"
              :key="job.id"
              class="rounded-md bg-surface-elevated p-3 text-sm"
            >
              <div class="flex items-center justify-between">
                <span class="font-mono text-xs text-text-muted">{{ job.id }}</span>
                <span class="text-xs text-text-muted">{{
                  new Date(job.timestamp).toLocaleString()
                }}</span>
              </div>
              <p v-if="job.failedReason" class="mt-1 text-xs text-error">
                {{ job.failedReason }}
              </p>
            </div>
          </div>
        </div>
      </div>
    </Card>

    <!-- Draft Posts -->
    <Card>
      <template #header>
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <Clock class="h-5 w-5 text-primary" />
            <div>
              <h2 class="text-lg font-semibold text-text-primary">Draft Posts</h2>
              <p class="text-sm text-text-secondary">Awaiting approval before posting</p>
            </div>
          </div>
          <!-- Batch operations toolbar -->
          <div v-if="postsStore.drafts.length > 0" class="flex items-center gap-3">
            <label class="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
              <Checkbox :model-value="allSelected" @update:model-value="toggleSelectAll" />
              Select all
            </label>
            <div v-if="selectedCount > 0" class="flex items-center gap-2">
              <span class="text-sm text-text-muted">{{ selectedCount }} selected</span>
              <Button size="sm" variant="primary" @click="batchApprove">
                <CheckSquare class="mr-1 h-3.5 w-3.5" />
                Approve all
              </Button>
              <Button size="sm" variant="destructive" @click="batchReject">
                <XSquare class="mr-1 h-3.5 w-3.5" />
                Reject all
              </Button>
            </div>
          </div>
        </div>
      </template>

      <LoadingSpinner v-if="postsStore.loading" />
      <ErrorState v-else-if="postsStore.error" :message="postsStore.error" />
      <EmptyState
        v-else-if="postsStore.drafts.length === 0"
        message="No drafts pending. Generate posts from the Generate page."
      />
      <div v-else class="space-y-4">
        <div v-for="post in postsStore.drafts" :key="post.id" class="flex gap-3">
          <Checkbox
            :model-value="selectedIds.has(post.id)"
            class="mt-4"
            @update:model-value="toggleSelect(post.id)"
          />
          <div class="flex-1">
            <PostCard :post="post" show-actions @approve="approve" @edit="edit" @reject="reject" />
          </div>
        </div>
      </div>
    </Card>

    <PostEditor :post="editingPost" @close="closeEditor" @save="saveEdit" />
    <ReviewFeedbackDialog
      :post="rejectingPost"
      @cancel="rejectingPost = null"
      @submit="submitRejection"
    />
  </div>
</template>
