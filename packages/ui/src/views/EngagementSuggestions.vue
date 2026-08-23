<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Check, Clock3, Edit3, MessageSquare, RefreshCw, X } from "@lucide/vue";
import { Badge, Button, Card, SectionHeader } from "../components/ui";
import ErrorState from "../components/ErrorState.vue";
import LoadingSpinner from "../components/LoadingSpinner.vue";
import { useApi } from "../composables/useApi";
import { useToast } from "../composables/useToast";

interface Suggestion {
  id: string;
  accountId: string;
  network: string;
  targetUrl: string;
  sourceSnapshotHash: string;
  voiceMode: string;
  intent: string;
  content: string;
  policyMode: string;
  status: string;
  version: number;
  expiresAt: string;
  createdAt: string;
  claimTrace?: Record<string, unknown> | null;
  judgeScores?: Record<string, number> | null;
}

const api = useApi();
const toast = useToast();
const suggestions = ref<Suggestion[]>([]);
const selectedId = ref<string | null>(null);
const editedContent = ref("");
const loading = ref(true);
const actionLoading = ref(false);
const error = ref<string | null>(null);

const selected = computed(
  () => suggestions.value.find((suggestion) => suggestion.id === selectedId.value) ?? null,
);

function selectSuggestion(suggestion: Suggestion): void {
  selectedId.value = suggestion.id;
  editedContent.value = suggestion.content;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

function policyVariant(mode: string): "info" | "warning" | "success" {
  if (mode === "HUMAN_APPROVAL_REQUIRED") return "warning";
  if (mode === "APPROVED_AUTOMATION") return "success";
  return "info";
}

async function loadSuggestions(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const response = await api.get<Suggestion[]>("/engagement/suggestions?status=PROPOSED");
    suggestions.value = response.data;
    const next = selected.value ?? suggestions.value[0];
    if (next) selectSuggestion(next);
    else selectedId.value = null;
  } catch (err) {
    error.value = (err as Error).message || "Failed to load suggestions";
  } finally {
    loading.value = false;
  }
}

async function review(decision: "approve" | "reject" | "edit-and-approve"): Promise<void> {
  if (!selected.value) return;
  actionLoading.value = true;
  try {
    const path =
      decision === "approve" ? "approve" : decision === "reject" ? "reject" : "edit-and-approve";
    const payload = {
      reviewerId: "operator",
      expectedVersion: selected.value.version,
      ...(decision === "edit-and-approve" ? { content: editedContent.value.trim() } : {}),
    };
    await api.post(`/engagement/suggestions/${selected.value.id}/${path}`, payload);
    toast.success(
      decision === "reject"
        ? "Suggestion rejected"
        : decision === "edit-and-approve"
          ? "Edited suggestion approved"
          : "Suggestion approved",
    );
    await loadSuggestions();
  } catch (err) {
    toast.error((err as Error).message || "Suggestion review failed");
  } finally {
    actionLoading.value = false;
  }
}

async function expire(): Promise<void> {
  if (!selected.value) return;
  actionLoading.value = true;
  try {
    await api.post(`/engagement/suggestions/${selected.value.id}/expire`);
    toast.success("Suggestion expired");
    await loadSuggestions();
  } catch (err) {
    toast.error((err as Error).message || "Suggestion expiry failed");
  } finally {
    actionLoading.value = false;
  }
}

onMounted(loadSuggestions);
</script>

<template>
  <div class="space-y-6">
    <SectionHeader
      title="Engagement suggestions"
      description="Review value-adding public replies and quotes before they can be considered for execution. This queue never sends a network action itself."
    />

    <LoadingSpinner v-if="loading" message="Loading suggestions…" />
    <ErrorState v-else-if="error" :message="error" />
    <template v-else>
      <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_25rem]">
        <Card class="!p-0" aria-label="Suggestion queue">
          <div class="flex items-center justify-between border-b border-border px-5 py-4">
            <div class="flex items-center gap-2">
              <MessageSquare class="h-4 w-4 text-primary" aria-hidden="true" />
              <h2 class="text-sm font-semibold text-text-primary">Pending review</h2>
              <Badge variant="neutral">{{ suggestions.length }}</Badge>
            </div>
            <Button
              variant="ghost"
              size="sm"
              class="!p-2"
              aria-label="Refresh suggestions"
              title="Refresh suggestions"
              @click="loadSuggestions"
            >
              <RefreshCw class="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>

          <div
            v-if="suggestions.length === 0"
            class="px-5 py-12 text-center text-sm text-text-muted"
          >
            No suggestions need review.
          </div>
          <div v-else class="divide-y divide-border">
            <button
              v-for="suggestion in suggestions"
              :key="suggestion.id"
              type="button"
              class="flex w-full items-start gap-4 px-5 py-4 text-left transition-colors hover:bg-surface-highlight focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
              :class="selectedId === suggestion.id ? 'bg-primary-subtle/60' : ''"
              @click="selectSuggestion(suggestion)"
            >
              <span
                class="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-warning ring-4 ring-warning/10"
                aria-hidden="true"
              />
              <span class="min-w-0 flex-1">
                <span class="flex flex-wrap items-center gap-2">
                  <span class="text-sm font-semibold text-text-primary">{{
                    suggestion.network
                  }}</span>
                  <Badge :variant="policyVariant(suggestion.policyMode)">{{
                    suggestion.policyMode
                  }}</Badge>
                </span>
                <span class="mt-1 block truncate text-sm text-text-secondary">{{
                  suggestion.content
                }}</span>
                <span class="mt-1 block text-xs text-text-muted"
                  >Expires {{ formatDate(suggestion.expiresAt) }}</span
                >
              </span>
            </button>
          </div>
        </Card>

        <Card v-if="selected" class="h-fit !p-5" aria-label="Selected suggestion">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-xs font-medium uppercase tracking-[0.16em] text-text-muted">
                Review draft
              </p>
              <h2 class="mt-2 text-lg font-semibold text-text-primary">
                {{ selected.network }} · {{ selected.intent }}
              </h2>
            </div>
            <Clock3 class="h-5 w-5 text-warning" aria-hidden="true" />
          </div>

          <div class="mt-4 space-y-2 border-y border-border py-4 text-xs">
            <div class="flex justify-between gap-3">
              <span class="text-text-muted">Account</span
              ><span class="text-text-secondary">{{ selected.accountId }}</span>
            </div>
            <div class="flex justify-between gap-3">
              <span class="text-text-muted">Voice mode</span
              ><span class="text-text-secondary">{{ selected.voiceMode }}</span>
            </div>
            <div class="flex justify-between gap-3">
              <span class="text-text-muted">Policy</span
              ><Badge :variant="policyVariant(selected.policyMode)">{{
                selected.policyMode
              }}</Badge>
            </div>
          </div>

          <a
            class="mt-4 block truncate text-xs text-primary hover:underline"
            :href="selected.targetUrl"
            target="_blank"
            rel="noreferrer"
          >
            Open public source
          </a>

          <label class="mt-4 block text-xs font-medium text-text-secondary" for="suggestion-content"
            >Suggested text</label
          >
          <textarea
            id="suggestion-content"
            v-model="editedContent"
            class="field-input mt-2 min-h-32 w-full"
          />

          <div class="mt-4 grid grid-cols-2 gap-2">
            <Button :loading="actionLoading" @click="review('approve')">
              <template #icon><Check class="h-4 w-4" aria-hidden="true" /></template>
              Approve
            </Button>
            <Button variant="outline" :loading="actionLoading" @click="review('edit-and-approve')">
              <template #icon><Edit3 class="h-4 w-4" aria-hidden="true" /></template>
              Edit & approve
            </Button>
            <Button variant="destructive" :loading="actionLoading" @click="review('reject')">
              <template #icon><X class="h-4 w-4" aria-hidden="true" /></template>
              Reject
            </Button>
            <Button variant="ghost" :loading="actionLoading" @click="expire"> Expire </Button>
          </div>
          <p class="mt-3 text-xs leading-relaxed text-text-muted">
            Approval records the operator decision. Posting still requires the separate policy and
            transport authorization checks immediately before any network side effect.
          </p>
        </Card>
      </div>
    </template>
  </div>
</template>
