<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Check, FileCheck2, RefreshCw, Shield, X } from "@lucide/vue";
import { Badge, Button, Card, SectionHeader } from "../components/ui";
import ErrorState from "../components/ErrorState.vue";
import LoadingSpinner from "../components/LoadingSpinner.vue";
import { useApi } from "../composables/useApi";
import { useToast } from "../composables/useToast";

interface PolicyEvidence {
  id: string;
  network: string;
  sourceUrl: string;
  sourceType: string;
  status: string;
  expiresAt: string | null;
  versions: PolicyVersion[];
}

interface PolicyVersion {
  id: string;
  policyKey: string;
  version: number;
  network: string;
  action: string;
  transport: string;
  executionMode: string;
  status: string;
  evidenceId: string;
  expiresAt: string | null;
}

const api = useApi();
const toast = useToast();
const evidence = ref<PolicyEvidence[]>([]);
const policies = ref<PolicyVersion[]>([]);
const selectedEvidenceId = ref<string | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const actionId = ref<string | null>(null);

const selectedEvidence = computed(
  () => evidence.value.find((item) => item.id === selectedEvidenceId.value) ?? null,
);

function policyVariant(status: string): "success" | "warning" | "error" | "neutral" {
  if (status === "ACTIVE" || status === "VERIFIED") return "success";
  if (status === "DRAFT") return "warning";
  if (status === "REVOKED") return "error";
  return "neutral";
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const [evidenceResponse, policyResponse] = await Promise.all([
      api.get<PolicyEvidence[]>("/platform-policy/evidence"),
      api.get<PolicyVersion[]>("/platform-policy/versions"),
    ]);
    evidence.value = evidenceResponse.data;
    policies.value = policyResponse.data;
    if (!selectedEvidenceId.value && evidence.value[0])
      selectedEvidenceId.value = evidence.value[0].id;
  } catch (err) {
    error.value = (err as Error).message || "Failed to load policy registry";
  } finally {
    loading.value = false;
  }
}

async function verifyEvidence(item: PolicyEvidence): Promise<void> {
  actionId.value = item.id;
  try {
    await api.post(`/platform-policy/evidence/${item.id}/verify`, { reviewer: "operator" });
    toast.success("Policy evidence verified");
    await load();
  } catch (err) {
    toast.error((err as Error).message || "Evidence verification failed");
  } finally {
    actionId.value = null;
  }
}

async function approvePolicy(policy: PolicyVersion): Promise<void> {
  actionId.value = policy.id;
  try {
    await api.post(`/platform-policy/versions/${policy.id}/approve`, { reviewer: "operator" });
    toast.success("Policy version approved");
    await load();
  } catch (err) {
    toast.error((err as Error).message || "Policy approval failed");
  } finally {
    actionId.value = null;
  }
}

async function revokePolicy(policy: PolicyVersion): Promise<void> {
  actionId.value = policy.id;
  try {
    await api.post(`/platform-policy/versions/${policy.id}/revoke`, {
      reviewer: "operator",
      reason: "Revoked from policy registry",
    });
    toast.success("Policy version revoked");
    await load();
  } catch (err) {
    toast.error((err as Error).message || "Policy revoke failed");
  } finally {
    actionId.value = null;
  }
}

onMounted(load);
</script>

<template>
  <div class="space-y-6">
    <SectionHeader
      title="Policy registry"
      description="Review source evidence and policy versions. Runtime authorization remains fail-closed when evidence is stale, missing or revoked."
    />
    <LoadingSpinner v-if="loading" message="Loading policy registry…" />
    <ErrorState v-else-if="error" :message="error" />
    <template v-else>
      <div class="flex justify-end">
        <Button variant="ghost" size="sm" @click="load"
          ><template #icon><RefreshCw class="h-4 w-4" aria-hidden="true" /></template>Refresh
          registry</Button
        >
      </div>
      <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card aria-label="Policy evidence list">
          <div class="flex items-center gap-2 border-b border-border pb-4">
            <FileCheck2 class="h-4 w-4 text-primary" aria-hidden="true" />
            <h2 class="text-sm font-semibold text-text-primary">Source evidence</h2>
            <Badge variant="neutral">{{ evidence.length }}</Badge>
          </div>
          <p v-if="evidence.length === 0" class="py-8 text-center text-sm text-text-muted">
            No policy evidence records.
          </p>
          <div v-else class="mt-4 space-y-3">
            <button
              v-for="item in evidence"
              :key="item.id"
              type="button"
              class="flex w-full items-start justify-between gap-3 rounded-md border border-border bg-surface-highlight p-3 text-left hover:border-primary/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
              :class="selectedEvidenceId === item.id ? 'border-primary bg-primary-subtle/40' : ''"
              @click="selectedEvidenceId = item.id"
            >
              <span class="min-w-0"
                ><span class="block text-sm font-medium text-text-primary"
                  >{{ item.network }} · {{ item.sourceType }}</span
                ><span class="mt-1 block truncate text-xs text-primary">{{
                  item.sourceUrl
                }}</span></span
              ><Badge :variant="policyVariant(item.status)">{{ item.status }}</Badge>
            </button>
          </div>
          <div v-if="selectedEvidence" class="mt-5 border-t border-border pt-4">
            <p class="text-xs text-text-muted">
              {{
                selectedEvidence.expiresAt
                  ? `Expires ${new Date(selectedEvidence.expiresAt).toLocaleDateString()}`
                  : "No expiry recorded"
              }}
            </p>
            <Button
              v-if="selectedEvidence.status !== 'VERIFIED'"
              size="sm"
              class="mt-3"
              :loading="actionId === selectedEvidence.id"
              @click="verifyEvidence(selectedEvidence)"
              ><template #icon><Check class="h-4 w-4" aria-hidden="true" /></template>Verify
              evidence</Button
            >
          </div>
        </Card>
        <Card aria-label="Policy version list">
          <div class="flex items-center gap-2 border-b border-border pb-4">
            <Shield class="h-4 w-4 text-secondary" aria-hidden="true" />
            <h2 class="text-sm font-semibold text-text-primary">Policy versions</h2>
            <Badge variant="neutral">{{ policies.length }}</Badge>
          </div>
          <p v-if="policies.length === 0" class="py-8 text-center text-sm text-text-muted">
            No policy versions.
          </p>
          <div v-else class="mt-4 space-y-3">
            <article
              v-for="policy in policies"
              :key="policy.id"
              class="rounded-md border border-border bg-surface-highlight p-4"
            >
              <div class="flex items-start justify-between gap-3">
                <div>
                  <h3 class="text-sm font-semibold text-text-primary">
                    {{ policy.policyKey }} · v{{ policy.version }}
                  </h3>
                  <p class="mt-1 text-xs text-text-secondary">
                    {{ policy.network }} · {{ policy.action }} · {{ policy.transport }}
                  </p>
                </div>
                <Badge :variant="policyVariant(policy.status)">{{ policy.status }}</Badge>
              </div>
              <div class="mt-3 flex items-center justify-between gap-3 text-xs">
                <span class="text-text-muted">Execution mode</span
                ><span class="font-medium text-text-secondary">{{ policy.executionMode }}</span>
              </div>
              <div class="mt-4 flex gap-2">
                <Button
                  v-if="policy.status === 'DRAFT'"
                  size="sm"
                  :loading="actionId === policy.id"
                  @click="approvePolicy(policy)"
                  ><template #icon><Check class="h-4 w-4" aria-hidden="true" /></template
                  >Approve</Button
                ><Button
                  v-if="policy.status === 'ACTIVE'"
                  size="sm"
                  variant="outline"
                  :loading="actionId === policy.id"
                  @click="revokePolicy(policy)"
                  ><template #icon><X class="h-4 w-4" aria-hidden="true" /></template>Revoke</Button
                >
              </div>
            </article>
          </div>
        </Card>
      </div>
    </template>
  </div>
</template>
