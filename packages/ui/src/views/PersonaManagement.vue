<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Check, Fingerprint, RefreshCw, Sparkles } from "@lucide/vue";
import { Badge, Button, Card, SectionHeader } from "../components/ui";
import ErrorState from "../components/ErrorState.vue";
import LoadingSpinner from "../components/LoadingSpinner.vue";
import { useApi } from "../composables/useApi";
import { useToast } from "../composables/useToast";

interface PersonaRevision {
  id: string;
  version: number;
  checksum: string;
  profile: {
    identity: { role: string; worldview: string[]; audienceJob: string; disclosure: string };
    modes: Array<{ id: string; purpose: string; allowedFirstPerson: boolean }>;
    contentPillars: Array<{ id: string; riskClass: string }>;
  };
}

interface Persona {
  id: string;
  key: string;
  displayName: string;
  status: string;
  revisions: PersonaRevision[];
  assignments: Array<{ accountId: string; personaRevisionId: string; defaultVoiceMode: string }>;
}

interface Account {
  id: string;
  network: string;
  handle: string;
  displayName: string | null;
}

const api = useApi();
const toast = useToast();
const personas = ref<Persona[]>([]);
const accounts = ref<Account[]>([]);
const selectedPersonaId = ref<string | null>(null);
const selectedAccountId = ref("");
const selectedRevisionId = ref("");
const selectedMode = ref("");
const loading = ref(true);
const saving = ref(false);
const error = ref<string | null>(null);

const selectedPersona = computed(
  () => personas.value.find((persona) => persona.id === selectedPersonaId.value) ?? null,
);
const selectedRevision = computed(
  () =>
    selectedPersona.value?.revisions.find((revision) => revision.id === selectedRevisionId.value) ??
    selectedPersona.value?.revisions[0] ??
    null,
);
const activeAssignment = computed(
  () =>
    selectedPersona.value?.assignments.find(
      (assignment) => assignment.accountId === selectedAccountId.value,
    ) ?? null,
);

function selectPersona(persona: Persona): void {
  selectedPersonaId.value = persona.id;
  selectedRevisionId.value = persona.revisions[0]?.id ?? "";
  selectedMode.value = persona.revisions[0]?.profile.modes[0]?.id ?? "";
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const [personasResponse, accountsResponse] = await Promise.all([
      api.get<Persona[]>("/personas"),
      api.get<Account[]>("/accounts"),
    ]);
    personas.value = personasResponse.data;
    accounts.value = accountsResponse.data;
    if (!selectedPersonaId.value && personas.value[0]) selectPersona(personas.value[0]);
    if (!selectedAccountId.value && accounts.value[0])
      selectedAccountId.value = accounts.value[0].id;
  } catch (err) {
    error.value = (err as Error).message || "Failed to load persona management";
  } finally {
    loading.value = false;
  }
}

async function assignPersona(): Promise<void> {
  if (
    !selectedPersona.value ||
    !selectedRevision.value ||
    !selectedAccountId.value ||
    !selectedMode.value
  ) {
    toast.error("Choose a persona, revision, account and voice mode");
    return;
  }
  saving.value = true;
  try {
    await api.put(`/personas/accounts/${selectedAccountId.value}/assignment`, {
      personaId: selectedPersona.value.id,
      personaRevisionId: selectedRevision.value.id,
      defaultVoiceMode: selectedMode.value,
    });
    toast.success("Persona assignment saved");
    await load();
  } catch (err) {
    toast.error((err as Error).message || "Persona assignment failed");
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="space-y-6">
    <SectionHeader
      title="Personas"
      description="Assign immutable, disclosed editorial voices to accounts. Changing a profile creates a revision; existing posts keep their provenance."
    />
    <LoadingSpinner v-if="loading" message="Loading personas…" />
    <ErrorState v-else-if="error" :message="error" />
    <template v-else>
      <div class="grid gap-6 xl:grid-cols-[18rem_minmax(0,1fr)]">
        <Card class="h-fit !p-3">
          <div class="flex items-center justify-between px-2 pb-3">
            <h2 class="text-sm font-semibold text-text-primary">Editorial voices</h2>
            <Button
              variant="ghost"
              size="sm"
              class="!p-2"
              aria-label="Refresh personas"
              @click="load"
              ><RefreshCw class="h-4 w-4"
            /></Button>
          </div>
          <p v-if="personas.length === 0" class="px-2 py-8 text-center text-sm text-text-muted">
            No personas configured.
          </p>
          <div v-else class="space-y-1">
            <button
              v-for="persona in personas"
              :key="persona.id"
              type="button"
              class="flex w-full items-center justify-between rounded-md px-3 py-3 text-left hover:bg-surface-highlight focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
              :class="
                selectedPersonaId === persona.id
                  ? 'bg-primary-subtle text-primary'
                  : 'text-text-secondary'
              "
              @click="selectPersona(persona)"
            >
              <span
                ><span class="block text-sm font-medium">{{ persona.displayName }}</span
                ><span class="mt-0.5 block text-xs opacity-75"
                  >{{ persona.key }} · v{{ persona.revisions[0]?.version ?? 0 }}</span
                ></span
              ><Badge variant="neutral">{{ persona.status }}</Badge>
            </button>
          </div>
        </Card>

        <Card v-if="selectedPersona" class="!p-6">
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div class="flex items-start gap-3">
              <div class="rounded-lg bg-primary-subtle p-3 text-primary">
                <Fingerprint class="h-5 w-5" aria-hidden="true" />
              </div>
              <div>
                <h2 class="text-xl font-semibold text-text-primary">
                  {{ selectedPersona.displayName }}
                </h2>
                <p class="mt-1 text-sm text-text-secondary">
                  {{ selectedRevision?.profile.identity.role }}
                </p>
              </div>
            </div>
            <Badge variant="info">{{ selectedPersona.status }}</Badge>
          </div>
          <div class="mt-6 grid gap-4 lg:grid-cols-2">
            <div class="rounded-md border border-border bg-surface-highlight p-4">
              <p class="text-xs font-medium uppercase tracking-[0.16em] text-text-muted">
                Audience job
              </p>
              <p class="mt-2 text-sm leading-relaxed text-text-secondary">
                {{ selectedRevision?.profile.identity.audienceJob }}
              </p>
            </div>
            <div class="rounded-md border border-border bg-surface-highlight p-4">
              <p class="text-xs font-medium uppercase tracking-[0.16em] text-text-muted">
                Disclosure
              </p>
              <p class="mt-2 text-sm leading-relaxed text-text-secondary">
                {{ selectedRevision?.profile.identity.disclosure }}
              </p>
            </div>
          </div>
          <div class="mt-6">
            <p class="text-sm font-semibold text-text-primary">Voice modes</p>
            <div class="mt-3 flex flex-wrap gap-2">
              <Badge
                v-for="mode in selectedRevision?.profile.modes ?? []"
                :key="mode.id"
                :variant="mode.id === selectedMode ? 'primary' : 'neutral'"
                >{{ mode.id
                }}<span v-if="mode.allowedFirstPerson"> · approved first-person only</span></Badge
              >
            </div>
          </div>
          <form
            class="mt-7 rounded-lg border border-primary/20 bg-primary-subtle/30 p-5"
            @submit.prevent="assignPersona"
          >
            <div class="flex items-center gap-2">
              <Sparkles class="h-4 w-4 text-primary" aria-hidden="true" />
              <h3 class="text-sm font-semibold text-text-primary">Assign to account</h3>
            </div>
            <div class="mt-4 grid gap-4 md:grid-cols-3">
              <label class="space-y-1.5"
                ><span class="field-label">Account</span
                ><select v-model="selectedAccountId" class="field-input w-full">
                  <option v-for="account in accounts" :key="account.id" :value="account.id">
                    {{ account.displayName || `@${account.handle}` }} · {{ account.network }}
                  </option>
                </select></label
              ><label class="space-y-1.5"
                ><span class="field-label">Revision</span
                ><select v-model="selectedRevisionId" class="field-input w-full">
                  <option
                    v-for="revision in selectedPersona.revisions"
                    :key="revision.id"
                    :value="revision.id"
                  >
                    v{{ revision.version }} · {{ revision.checksum.slice(0, 8) }}
                  </option>
                </select></label
              ><label class="space-y-1.5"
                ><span class="field-label">Voice mode</span
                ><select v-model="selectedMode" class="field-input w-full">
                  <option
                    v-for="mode in selectedRevision?.profile.modes ?? []"
                    :key="mode.id"
                    :value="mode.id"
                  >
                    {{ mode.id }}
                  </option>
                </select></label
              >
            </div>
            <div class="mt-4 flex flex-wrap items-center justify-between gap-3">
              <p class="text-xs text-text-muted">
                {{
                  activeAssignment
                    ? `Currently assigned: ${activeAssignment.defaultVoiceMode}`
                    : "No active assignment for this account"
                }}
              </p>
              <Button type="submit" :loading="saving"
                ><template #icon><Check class="h-4 w-4" aria-hidden="true" /></template>Save
                assignment</Button
              >
            </div>
          </form>
        </Card>
      </div>
    </template>
  </div>
</template>
