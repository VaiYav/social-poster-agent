<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { AlertOctagon, CheckCircle2, RefreshCw, ShieldAlert } from "@lucide/vue";
import { Badge, Button, Card, SectionHeader } from "../components/ui";
import ErrorState from "../components/ErrorState.vue";
import LoadingSpinner from "../components/LoadingSpinner.vue";
import { useApi } from "../composables/useApi";
import { useToast } from "../composables/useToast";

interface Account {
  id: string;
  network: string;
  handle: string;
  displayName: string | null;
}
interface StateResponse {
  state: string;
  record: { version: number; reason: string | null } | null;
}
interface Incident {
  id: string;
  severity: string;
  stateBefore: string;
  stateAfter: string;
  status: string;
  createdAt: string;
  owner: string | null;
}

const api = useApi();
const toast = useToast();
const accounts = ref<Account[]>([]);
const selectedAccountId = ref("");
const state = ref<StateResponse | null>(null);
const incidents = ref<Incident[]>([]);
const targetState = ref("WATCH");
const recoveryReason = ref("");
const loading = ref(true);
const actionLoading = ref(false);
const error = ref<string | null>(null);

const selectedAccount = computed(
  () => accounts.value.find((account) => account.id === selectedAccountId.value) ?? null,
);
const network = computed(() => selectedAccount.value?.network ?? "X");
const stateVariant = computed(() =>
  state.value?.state === "HEALTHY"
    ? "success"
    : state.value?.state === "WATCH"
      ? "warning"
      : "error",
);

async function loadAccounts(): Promise<void> {
  const response = await api.get<Account[]>("/accounts");
  accounts.value = response.data;
  if (!selectedAccountId.value && accounts.value[0]) selectedAccountId.value = accounts.value[0].id;
}

async function loadState(): Promise<void> {
  if (!selectedAccountId.value) return;
  loading.value = true;
  error.value = null;
  try {
    const [stateResponse, incidentResponse] = await Promise.all([
      api.get<StateResponse>(
        `/reputation/accounts/${selectedAccountId.value}?network=${network.value}`,
      ),
      api.get<Incident[]>(
        `/reputation/incidents?accountId=${selectedAccountId.value}&network=${network.value}&status=OPEN`,
      ),
    ]);
    state.value = stateResponse.data;
    incidents.value = incidentResponse.data;
  } catch (err) {
    error.value = (err as Error).message || "Failed to load reputation safety state";
  } finally {
    loading.value = false;
  }
}

async function acknowledge(id: string): Promise<void> {
  actionLoading.value = true;
  try {
    await api.post(`/reputation/incidents/${id}/acknowledge`, { owner: "operator" });
    toast.success("Incident acknowledged");
    await loadState();
  } catch (err) {
    toast.error((err as Error).message || "Incident acknowledgement failed");
  } finally {
    actionLoading.value = false;
  }
}

async function recover(): Promise<void> {
  if (!selectedAccountId.value || !state.value?.record || !recoveryReason.value.trim()) {
    toast.error("A recovery reason is required");
    return;
  }
  actionLoading.value = true;
  try {
    await api.post(`/reputation/accounts/${selectedAccountId.value}/recover`, {
      network: network.value,
      expectedVersion: state.value.record.version,
      targetState: targetState.value,
      reviewer: "operator",
      reason: recoveryReason.value.trim(),
    });
    recoveryReason.value = "";
    toast.success("Recovery stage applied");
    await loadState();
  } catch (err) {
    toast.error((err as Error).message || "Recovery failed");
  } finally {
    actionLoading.value = false;
  }
}

onMounted(async () => {
  try {
    await loadAccounts();
    await loadState();
  } catch (err) {
    error.value = (err as Error).message || "Failed to load accounts";
    loading.value = false;
  }
});
watch(selectedAccountId, () => {
  void loadState();
});
</script>

<template>
  <div class="space-y-6">
    <SectionHeader
      title="Reputation safety"
      description="Inspect account-scoped reputation states, incidents and staged recovery. A recovery can only become less restrictive one step at a time."
    />
    <LoadingSpinner v-if="loading && !state" message="Loading safety state…" />
    <ErrorState v-else-if="error" :message="error" />
    <template v-else>
      <Card class="flex flex-wrap items-end gap-4">
        <label class="min-w-56 space-y-1.5"
          ><span class="field-label">Account</span
          ><select v-model="selectedAccountId" class="field-input w-full">
            <option v-for="account in accounts" :key="account.id" :value="account.id">
              {{ account.displayName || `@${account.handle}` }} · {{ account.network }}
            </option>
          </select></label
        >
        <Button variant="ghost" @click="loadState"
          ><template #icon><RefreshCw class="h-4 w-4" aria-hidden="true" /></template
          >Refresh</Button
        >
      </Card>
      <div v-if="state" class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Card :class="state.state === 'HEALTHY' ? 'border-success/40' : 'border-warning/50'">
          <div class="flex items-start justify-between gap-4">
            <div class="flex items-start gap-3">
              <div class="rounded-lg bg-surface-highlight p-3">
                <ShieldAlert
                  class="h-6 w-6"
                  :class="state.state === 'HEALTHY' ? 'text-success' : 'text-warning'"
                  aria-hidden="true"
                />
              </div>
              <div>
                <p class="text-xs uppercase tracking-[0.16em] text-text-muted">
                  {{ network }} reputation
                </p>
                <h2 class="mt-2 text-2xl font-semibold text-text-primary">{{ state.state }}</h2>
                <p class="mt-1 text-sm text-text-secondary">
                  {{ state.record?.reason || "No active restriction reason" }}
                </p>
              </div>
            </div>
            <Badge :variant="stateVariant">{{ state.state }}</Badge>
          </div>
          <div
            class="mt-6 rounded-md border border-border bg-surface-highlight p-4 text-sm text-text-secondary"
          >
            <p class="font-medium text-text-primary">Scoped effect</p>
            <p class="mt-1">
              {{
                ["PAUSED", "INCIDENT"].includes(state.state)
                  ? "Posting and engagement are paused for this account."
                  : state.state === "LIMITED"
                    ? "Engagement is paused for this account."
                    : "No scoped flow pause is currently required."
              }}
            </p>
          </div>
          <form
            v-if="state.record && state.state !== 'HEALTHY'"
            class="mt-6 space-y-3 border-t border-border pt-5"
            @submit.prevent="recover"
          >
            <h3 class="text-sm font-semibold text-text-primary">Staged recovery</h3>
            <div class="grid gap-3 sm:grid-cols-2">
              <label class="space-y-1.5"
                ><span class="field-label">Next state</span
                ><select v-model="targetState" class="field-input w-full">
                  <option value="WATCH">WATCH</option>
                  <option value="LIMITED">LIMITED</option>
                  <option value="PAUSED">PAUSED</option>
                </select></label
              ><label class="space-y-1.5"
                ><span class="field-label">Reason</span
                ><input
                  v-model="recoveryReason"
                  class="field-input w-full"
                  placeholder="What was reviewed?"
              /></label>
            </div>
            <Button type="submit" :loading="actionLoading"
              ><template #icon><CheckCircle2 class="h-4 w-4" aria-hidden="true" /></template>Apply
              recovery stage</Button
            >
          </form>
        </Card>
        <Card
          ><div class="flex items-center gap-2">
            <AlertOctagon class="h-4 w-4 text-warning" aria-hidden="true" />
            <h2 class="text-sm font-semibold text-text-primary">Open incidents</h2>
            <Badge variant="neutral">{{ incidents.length }}</Badge>
          </div>
          <p v-if="incidents.length === 0" class="py-8 text-center text-sm text-text-muted">
            No open incidents.
          </p>
          <div v-else class="mt-4 space-y-3">
            <article
              v-for="incident in incidents"
              :key="incident.id"
              class="rounded-md border border-border bg-surface-highlight p-3"
            >
              <div class="flex justify-between gap-2">
                <Badge variant="error">{{ incident.severity }}</Badge
                ><span class="text-xs text-text-muted"
                  >{{ incident.stateBefore }} → {{ incident.stateAfter }}</span
                >
              </div>
              <p class="mt-2 text-xs text-text-secondary">
                {{ new Date(incident.createdAt).toLocaleString() }}
              </p>
              <Button
                size="sm"
                variant="outline"
                class="mt-3 w-full"
                :loading="actionLoading"
                @click="acknowledge(incident.id)"
                >Acknowledge</Button
              >
            </article>
          </div></Card
        >
      </div>
    </template>
  </div>
</template>
