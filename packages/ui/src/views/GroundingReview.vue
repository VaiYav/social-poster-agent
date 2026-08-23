<script setup lang="ts">
import { onMounted, ref } from "vue";
import { BookOpenCheck, Check, Database, RefreshCw, X } from "@lucide/vue";
import { Badge, Button, Card, SectionHeader } from "../components/ui";
import ErrorState from "../components/ErrorState.vue";
import LoadingSpinner from "../components/LoadingSpinner.vue";
import { useApi } from "../composables/useApi";
import { useToast } from "../composables/useToast";

interface Evidence {
  id: string;
  domain: string;
  riskClass: string;
  title: string;
  text: string;
  sourceType: string;
  reviewStatus: string;
}

interface Memory {
  id: string;
  personaId: string;
  kind: string;
  text: string;
  sourceType: string;
  status: string;
  confidence: number | null;
}

const api = useApi();
const toast = useToast();
const evidence = ref<Evidence[]>([]);
const memories = ref<Memory[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const actionId = ref<string | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const [evidenceResponse, memoryResponse] = await Promise.all([
      api.get<Evidence[]>("/grounding/evidence?reviewStatus=NEEDS_REVIEW"),
      api.get<Memory[]>("/grounding/memories?status=CANDIDATE"),
    ]);
    evidence.value = evidenceResponse.data;
    memories.value = memoryResponse.data;
  } catch (err) {
    error.value = (err as Error).message || "Failed to load grounding review queue";
  } finally {
    loading.value = false;
  }
}

async function reviewEvidence(item: Evidence, status: "VERIFIED" | "REJECTED"): Promise<void> {
  actionId.value = item.id;
  try {
    await api.post(`/grounding/evidence/${item.id}/review`, {
      reviewStatus: status,
      reviewer: "operator",
    });
    toast.success(status === "VERIFIED" ? "Evidence verified" : "Evidence rejected");
    await load();
  } catch (err) {
    toast.error((err as Error).message || "Evidence review failed");
  } finally {
    actionId.value = null;
  }
}

async function reviewMemory(item: Memory, status: "approve" | "reject"): Promise<void> {
  actionId.value = item.id;
  try {
    await api.post(
      `/grounding/memories/${item.id}/${status}`,
      status === "approve" ? { reviewer: "operator" } : {},
    );
    toast.success(status === "approve" ? "Memory candidate approved" : "Memory candidate rejected");
    await load();
  } catch (err) {
    toast.error((err as Error).message || "Memory review failed");
  } finally {
    actionId.value = null;
  }
}

onMounted(load);
</script>

<template>
  <div class="space-y-6">
    <SectionHeader
      title="Grounding review"
      description="Approve evidence and persona memory candidates before they can enter retrieval. Drafts and rejected output never become verified context."
    />

    <LoadingSpinner v-if="loading" message="Loading grounding queue…" />
    <ErrorState v-else-if="error" :message="error" />
    <template v-else>
      <div class="flex justify-end">
        <Button variant="ghost" size="sm" @click="load">
          <template #icon><RefreshCw class="h-4 w-4" aria-hidden="true" /></template>
          Refresh queue
        </Button>
      </div>
      <div class="grid gap-6 xl:grid-cols-2">
        <Card aria-label="Evidence review queue">
          <div class="flex items-center gap-2 border-b border-border pb-4">
            <Database class="h-4 w-4 text-primary" aria-hidden="true" />
            <h2 class="text-sm font-semibold text-text-primary">Knowledge evidence</h2>
            <Badge variant="neutral">{{ evidence.length }}</Badge>
          </div>
          <p v-if="evidence.length === 0" class="py-8 text-center text-sm text-text-muted">
            No evidence needs review.
          </p>
          <div v-else class="mt-4 space-y-4">
            <article
              v-for="item in evidence"
              :key="item.id"
              class="rounded-md border border-border bg-surface-highlight p-4"
            >
              <div class="flex items-start justify-between gap-3">
                <div>
                  <h3 class="text-sm font-semibold text-text-primary">{{ item.title }}</h3>
                  <p class="mt-1 text-xs text-text-muted">
                    {{ item.domain }} · {{ item.riskClass }} · {{ item.sourceType }}
                  </p>
                </div>
                <Badge variant="warning">{{ item.reviewStatus }}</Badge>
              </div>
              <p class="mt-3 line-clamp-4 text-sm leading-relaxed text-text-secondary">
                {{ item.text }}
              </p>
              <div class="mt-4 flex gap-2">
                <Button
                  size="sm"
                  :loading="actionId === item.id"
                  @click="reviewEvidence(item, 'VERIFIED')"
                  ><template #icon><Check class="h-4 w-4" aria-hidden="true" /></template
                  >Verify</Button
                >
                <Button
                  size="sm"
                  variant="outline"
                  :loading="actionId === item.id"
                  @click="reviewEvidence(item, 'REJECTED')"
                  ><template #icon><X class="h-4 w-4" aria-hidden="true" /></template>Reject</Button
                >
              </div>
            </article>
          </div>
        </Card>

        <Card aria-label="Persona memory review queue">
          <div class="flex items-center gap-2 border-b border-border pb-4">
            <BookOpenCheck class="h-4 w-4 text-secondary" aria-hidden="true" />
            <h2 class="text-sm font-semibold text-text-primary">Memory candidates</h2>
            <Badge variant="neutral">{{ memories.length }}</Badge>
          </div>
          <p v-if="memories.length === 0" class="py-8 text-center text-sm text-text-muted">
            No memory candidates need review.
          </p>
          <div v-else class="mt-4 space-y-4">
            <article
              v-for="item in memories"
              :key="item.id"
              class="rounded-md border border-border bg-surface-highlight p-4"
            >
              <div class="flex items-start justify-between gap-3">
                <div>
                  <h3 class="text-sm font-semibold text-text-primary">{{ item.kind }}</h3>
                  <p class="mt-1 text-xs text-text-muted">
                    Persona {{ item.personaId }} · {{ item.sourceType }}
                  </p>
                </div>
                <Badge variant="secondary">{{ item.status }}</Badge>
              </div>
              <p class="mt-3 text-sm leading-relaxed text-text-secondary">{{ item.text }}</p>
              <div class="mt-4 flex gap-2">
                <Button
                  size="sm"
                  :loading="actionId === item.id"
                  @click="reviewMemory(item, 'approve')"
                  ><template #icon><Check class="h-4 w-4" aria-hidden="true" /></template
                  >Approve</Button
                ><Button
                  size="sm"
                  variant="outline"
                  :loading="actionId === item.id"
                  @click="reviewMemory(item, 'reject')"
                  ><template #icon><X class="h-4 w-4" aria-hidden="true" /></template>Reject</Button
                >
              </div>
            </article>
          </div>
        </Card>
      </div>
    </template>
  </div>
</template>
