<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Archive, CheckCircle2, Lightbulb, RefreshCw, ShieldCheck } from "@lucide/vue";
import { Badge, Button, Card, SectionHeader } from "../components/ui";
import ErrorState from "../components/ErrorState.vue";
import LoadingSpinner from "../components/LoadingSpinner.vue";
import { useApi } from "../composables/useApi";
import { useToast } from "../composables/useToast";

interface DemandCluster {
  id: string;
  label: string;
  canonicalQuestion: string;
  domain: string;
  riskTier: string;
  status: string;
  demandScore: number;
  sourceCount: number;
  distinctAuthorCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

const api = useApi();
const toast = useToast();
const clusters = ref<DemandCluster[]>([]);
const selectedId = ref<string | null>(null);
const loading = ref(true);
const actionLoading = ref(false);
const error = ref<string | null>(null);

const selected = computed(
  () => clusters.value.find((cluster) => cluster.id === selectedId.value) ?? null,
);

function selectCluster(cluster: DemandCluster): void {
  selectedId.value = cluster.id;
}

function riskVariant(risk: string): "success" | "warning" | "error" {
  if (risk === "HIGH") return "error";
  if (risk === "MEDIUM") return "warning";
  return "success";
}

function statusVariant(status: string): "success" | "warning" | "neutral" {
  if (status === "VALIDATED") return "success";
  if (status === "REVIEWED") return "warning";
  return "neutral";
}

async function loadClusters(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const response = await api.get<DemandCluster[]>("/demand/clusters");
    clusters.value = response.data;
    const next = selected.value ?? clusters.value[0];
    if (next) selectedId.value = next.id;
  } catch (err) {
    error.value = (err as Error).message || "Failed to load demand clusters";
  } finally {
    loading.value = false;
  }
}

async function review(status: "REVIEWED" | "VALIDATED" | "ARCHIVED"): Promise<void> {
  if (!selected.value) return;
  actionLoading.value = true;
  try {
    await api.post(`/demand/clusters/${selected.value.id}/review`, {
      status,
      reviewer: "operator",
    });
    toast.success(`Cluster marked ${status}`);
    await loadClusters();
  } catch (err) {
    toast.error((err as Error).message || "Cluster review failed");
  } finally {
    actionLoading.value = false;
  }
}

async function proposeInsight(): Promise<void> {
  if (!selected.value) return;
  actionLoading.value = true;
  try {
    await api.post(`/demand/clusters/${selected.value.id}/propose-product-insight`, {
      insightType: "FAQ_CANDIDATE",
      summary: selected.value.canonicalQuestion,
      reviewer: "operator",
    });
    toast.success("Aggregate insight proposed");
  } catch (err) {
    toast.error((err as Error).message || "Insight proposal failed");
  } finally {
    actionLoading.value = false;
  }
}

onMounted(loadClusters);
</script>

<template>
  <div class="space-y-6">
    <SectionHeader
      title="Demand radar"
      description="Review bounded public questions before proposing aggregate product insights. Private and sensitive content is excluded upstream."
    />

    <LoadingSpinner v-if="loading" message="Loading demand clusters…" />
    <ErrorState v-else-if="error" :message="error" />
    <template v-else>
      <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <Card class="!p-0" aria-label="Demand cluster list">
          <div class="flex items-center justify-between border-b border-border px-5 py-4">
            <div class="flex items-center gap-2">
              <Lightbulb class="h-4 w-4 text-primary" aria-hidden="true" />
              <h2 class="text-sm font-semibold text-text-primary">Question clusters</h2>
              <Badge variant="neutral">{{ clusters.length }}</Badge>
            </div>
            <Button
              variant="ghost"
              size="sm"
              class="!p-2"
              aria-label="Refresh demand clusters"
              @click="loadClusters"
            >
              <RefreshCw class="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
          <div v-if="clusters.length === 0" class="px-5 py-12 text-center text-sm text-text-muted">
            No eligible public demand signals yet.
          </div>
          <div v-else class="divide-y divide-border">
            <button
              v-for="cluster in clusters"
              :key="cluster.id"
              type="button"
              class="flex w-full items-start gap-4 px-5 py-4 text-left transition-colors hover:bg-surface-highlight focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
              :class="selectedId === cluster.id ? 'bg-primary-subtle/60' : ''"
              @click="selectCluster(cluster)"
            >
              <span
                class="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-primary ring-4 ring-primary/10"
                aria-hidden="true"
              />
              <span class="min-w-0 flex-1">
                <span class="block text-sm font-semibold text-text-primary">{{
                  cluster.label
                }}</span>
                <span class="mt-1 block text-xs text-text-secondary"
                  >{{ cluster.domain }} · {{ cluster.sourceCount }} sources</span
                >
              </span>
              <span class="flex shrink-0 flex-col items-end gap-1">
                <Badge :variant="statusVariant(cluster.status)">{{ cluster.status }}</Badge>
                <span class="text-xs font-semibold text-primary"
                  >{{ Math.round(cluster.demandScore * 100) }}%</span
                >
              </span>
            </button>
          </div>
        </Card>

        <Card v-if="selected" class="h-fit !p-5" aria-label="Selected demand cluster">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-xs font-medium uppercase tracking-[0.16em] text-text-muted">
                Selected cluster
              </p>
              <h2 class="mt-2 text-lg font-semibold text-text-primary">
                {{ selected.canonicalQuestion }}
              </h2>
            </div>
            <ShieldCheck class="h-5 w-5 text-primary" aria-hidden="true" />
          </div>

          <div class="mt-5 grid grid-cols-3 gap-2 border-y border-border py-4 text-center">
            <div>
              <p class="text-lg font-semibold text-text-primary">{{ selected.sourceCount }}</p>
              <p class="text-[11px] text-text-muted">sources</p>
            </div>
            <div>
              <p class="text-lg font-semibold text-text-primary">
                {{ selected.distinctAuthorCount }}
              </p>
              <p class="text-[11px] text-text-muted">authors</p>
            </div>
            <div>
              <p class="text-lg font-semibold text-text-primary">
                {{ Math.round(selected.demandScore * 100) }}%
              </p>
              <p class="text-[11px] text-text-muted">demand</p>
            </div>
          </div>

          <div class="mt-4 flex items-center justify-between gap-3 text-sm">
            <span class="text-text-muted">Risk tier</span>
            <Badge :variant="riskVariant(selected.riskTier)">{{ selected.riskTier }}</Badge>
          </div>
          <div class="mt-4 space-y-2">
            <Button
              v-if="selected.status === 'DRAFT'"
              :loading="actionLoading"
              class="w-full"
              @click="review('REVIEWED')"
            >
              <template #icon><CheckCircle2 class="h-4 w-4" aria-hidden="true" /></template>
              Mark reviewed
            </Button>
            <Button
              v-if="selected.status === 'REVIEWED'"
              :loading="actionLoading"
              class="w-full"
              @click="review('VALIDATED')"
            >
              <template #icon><CheckCircle2 class="h-4 w-4" aria-hidden="true" /></template>
              Validate cluster
            </Button>
            <Button
              v-if="selected.status === 'VALIDATED'"
              :loading="actionLoading"
              variant="secondary"
              class="w-full"
              @click="proposeInsight"
            >
              <template #icon><Lightbulb class="h-4 w-4" aria-hidden="true" /></template>
              Propose aggregate insight
            </Button>
            <Button
              v-if="selected.status !== 'ARCHIVED'"
              :loading="actionLoading"
              variant="ghost"
              class="w-full"
              @click="review('ARCHIVED')"
            >
              <template #icon><Archive class="h-4 w-4" aria-hidden="true" /></template>
              Archive cluster
            </Button>
          </div>
          <p class="mt-4 text-xs leading-relaxed text-text-muted">
            Validation is human-controlled and aggregate-only. It does not mutate Soulwise product
            data or expose private source content.
          </p>
        </Card>
      </div>
    </template>
  </div>
</template>
