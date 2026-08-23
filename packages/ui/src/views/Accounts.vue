<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { CircleOff, RefreshCw, RotateCcw, Save, Settings2 } from "@lucide/vue";
import type { AccountSettings, AccountSettingsSource, ResolvedAccountSettings } from "@spa/shared";
import { useApi } from "../composables/useApi";
import { useToast } from "../composables/useToast";
import { Badge, Button, Card, SectionHeader, Select } from "../components/ui";
import ErrorState from "../components/ErrorState.vue";
import LoadingSpinner from "../components/LoadingSpinner.vue";

interface SocialAccount {
  id: string;
  network: string;
  handle: string;
  displayName: string | null;
  priority: number;
  active: boolean;
  warmupEnabled: boolean;
}

const api = useApi();
const toast = useToast();

const accounts = ref<SocialAccount[]>([]);
const selectedAccountId = ref<string | null>(null);
const resolved = ref<ResolvedAccountSettings | null>(null);
const overrides = ref<AccountSettings>({});
const loading = ref(true);
const settingsLoading = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);

const selectedAccount = computed(
  () => accounts.value.find((account) => account.id === selectedAccountId.value) ?? null,
);

const sourceLabels: Record<AccountSettingsSource, string> = {
  default: "Default",
  env: "Global env",
  account: "Account override",
};

const resolutionOptions = [
  { value: "0.5K", label: "0.5K" },
  { value: "1K", label: "1K" },
  { value: "2K", label: "2K" },
  { value: "4K", label: "4K" },
];

const imageStyleOptions = [
  { value: "quote_card", label: "Quote card" },
  { value: "aesthetic_photo", label: "Aesthetic photo" },
  { value: "chart_visualization", label: "Chart visualization" },
];

function hasOverride(key: keyof AccountSettings): boolean {
  return Object.prototype.hasOwnProperty.call(overrides.value, key);
}

function sourceFor(key: keyof AccountSettings): AccountSettingsSource {
  if (hasOverride(key)) return "account";
  return resolved.value?.sources[key] ?? "default";
}

function sourceLabel(key: keyof AccountSettings): string {
  return sourceLabels[sourceFor(key)];
}

function valueFor<K extends keyof AccountSettings>(key: K): Required<AccountSettings>[K] {
  if (hasOverride(key)) return overrides.value[key] as Required<AccountSettings>[K];
  return resolved.value?.values[key] as Required<AccountSettings>[K];
}

function setValue<K extends keyof AccountSettings>(key: K, value: AccountSettings[K]): void {
  overrides.value = { ...overrides.value, [key]: value };
}

function updateText<K extends keyof AccountSettings>(key: K, event: Event): void {
  setValue(key, (event.target as HTMLInputElement).value as AccountSettings[K]);
}

function updateNumber<K extends keyof AccountSettings>(key: K, event: Event): void {
  const raw = (event.target as HTMLInputElement).value;
  const value = Number(raw);
  if (Number.isFinite(value)) setValue(key, value as AccountSettings[K]);
}

function updateBoolean<K extends keyof AccountSettings>(key: K, event: Event): void {
  setValue(key, (event.target as HTMLInputElement).checked as AccountSettings[K]);
}

function updateArray<K extends keyof AccountSettings>(key: K, event: Event): void {
  const values = (event.target as HTMLTextAreaElement).value
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  setValue(key, values as AccountSettings[K]);
}

function arrayValue(key: "bannedPhrases" | "exampleSwipes"): string {
  return (valueFor(key) as string[]).join("\n");
}

function resetOverride(key: keyof AccountSettings): void {
  const next = { ...overrides.value };
  delete next[key];
  overrides.value = next;
}

async function loadSettings(accountId: string): Promise<void> {
  settingsLoading.value = true;
  error.value = null;
  try {
    const [resolvedResponse, overridesResponse] = await Promise.all([
      api.get<ResolvedAccountSettings>(`/accounts/${accountId}/settings`),
      api.get<AccountSettings>(`/accounts/${accountId}/settings/overrides`),
    ]);
    resolved.value = resolvedResponse.data;
    overrides.value = { ...overridesResponse.data };
  } catch (err) {
    error.value = (err as Error).message ?? "Failed to load account settings";
  } finally {
    settingsLoading.value = false;
  }
}

async function selectAccount(accountId: string): Promise<void> {
  selectedAccountId.value = accountId;
  await loadSettings(accountId);
}

async function loadAccounts(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const response = await api.get<SocialAccount[]>("/accounts");
    accounts.value = response.data;
    const firstAccount = accounts.value[0];
    if (firstAccount) await selectAccount(firstAccount.id);
  } catch (err) {
    error.value = (err as Error).message ?? "Failed to load accounts";
  } finally {
    loading.value = false;
  }
}

async function saveSettings(): Promise<void> {
  if (!selectedAccountId.value) return;
  saving.value = true;
  try {
    await api.put(`/accounts/${selectedAccountId.value}/settings`, overrides.value);
    await loadSettings(selectedAccountId.value);
    const account = selectedAccount.value;
    if (account && hasOverride("active")) account.active = Boolean(valueFor("active"));
    toast.success("Account settings saved");
  } catch (err) {
    toast.error((err as Error).message ?? "Failed to save account settings");
  } finally {
    saving.value = false;
  }
}

onMounted(loadAccounts);
</script>

<template>
  <div class="space-y-6">
    <SectionHeader
      title="Accounts"
      description="Tune each account independently. Unchanged fields inherit the global environment or hard defaults."
    />

    <LoadingSpinner v-if="loading" message="Loading accounts…" />
    <ErrorState v-else-if="error && accounts.length === 0" :message="error" />
    <div v-else class="grid gap-6 xl:grid-cols-[18rem_minmax(0,1fr)]">
      <Card class="h-fit p-3">
        <div class="flex items-center justify-between px-2 pb-3">
          <h2 class="text-sm font-semibold text-text-primary">Configured accounts</h2>
          <Button
            variant="ghost"
            size="sm"
            class="!p-2"
            aria-label="Refresh accounts"
            title="Refresh accounts"
            @click="loadAccounts"
          >
            <RefreshCw class="h-4 w-4" />
          </Button>
        </div>

        <div v-if="accounts.length === 0" class="px-2 py-8 text-center text-sm text-text-muted">
          No active accounts configured.
        </div>
        <div v-else class="space-y-1" role="listbox" aria-label="Social accounts">
          <button
            v-for="account in accounts"
            :key="account.id"
            type="button"
            role="option"
            :aria-selected="selectedAccountId === account.id"
            class="flex min-h-12 w-full items-center justify-between rounded-md px-3 py-2 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
            :class="
              selectedAccountId === account.id
                ? 'bg-primary-subtle text-primary'
                : 'text-text-secondary hover:bg-surface-highlight hover:text-text-primary'
            "
            @click="selectAccount(account.id)"
          >
            <span class="min-w-0">
              <span class="block truncate text-sm font-medium">
                {{ account.displayName || `@${account.handle}` }}
              </span>
              <span class="mt-0.5 block text-xs text-text-muted">
                {{ account.network }} · @{{ account.handle }}
              </span>
            </span>
            <Badge :variant="account.active ? 'success' : 'neutral'">
              {{ account.active ? "Active" : "Off" }}
            </Badge>
          </button>
        </div>
      </Card>

      <Card v-if="selectedAccount && resolved" class="p-6">
        <div class="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div class="flex items-start gap-3">
            <div class="rounded-lg bg-primary-subtle p-3 text-primary">
              <Settings2 class="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <h2 class="text-lg font-semibold text-text-primary">
                {{ selectedAccount.displayName || `@${selectedAccount.handle}` }}
              </h2>
              <p class="text-sm text-text-secondary">
                {{ selectedAccount.network }} · @{{ selectedAccount.handle }}
              </p>
            </div>
          </div>
          <Badge v-if="selectedAccount.warmupEnabled" variant="warning">Warm-up enabled</Badge>
        </div>

        <div v-if="settingsLoading" class="py-10">
          <LoadingSpinner message="Resolving inherited settings…" />
        </div>

        <form
          v-else
          method="post"
          :action="`/accounts/${selectedAccount.id}/settings`"
          class="space-y-8"
          @submit.prevent="saveSettings"
        >
          <fieldset class="space-y-4">
            <legend class="flex items-center gap-2 text-sm font-semibold text-text-primary">
              Posting
            </legend>
            <div class="grid gap-4 md:grid-cols-2">
              <label class="space-y-1.5">
                <span class="field-label"
                  >Posting timezone
                  <span class="field-source">{{ sourceLabel("postingTimezone") }}</span></span
                >
                <input
                  name="postingTimezone"
                  :value="valueFor('postingTimezone')"
                  maxlength="64"
                  class="field-input"
                  @input="updateText('postingTimezone', $event)"
                />
              </label>
              <label class="space-y-1.5">
                <span class="field-label"
                  >Daily limit
                  <span class="field-source">{{ sourceLabel("rateLimitDaily") }}</span></span
                >
                <input
                  name="rateLimitDaily"
                  type="number"
                  min="0"
                  inputmode="numeric"
                  :value="valueFor('rateLimitDaily')"
                  class="field-input"
                  @input="updateNumber('rateLimitDaily', $event)"
                />
              </label>
              <label class="space-y-1.5">
                <span class="field-label"
                  >Weekly limit
                  <span class="field-source">{{ sourceLabel("rateLimitWeekly") }}</span></span
                >
                <input
                  name="rateLimitWeekly"
                  type="number"
                  min="0"
                  inputmode="numeric"
                  :value="valueFor('rateLimitWeekly')"
                  class="field-input"
                  @input="updateNumber('rateLimitWeekly', $event)"
                />
              </label>
              <label class="space-y-1.5 md:col-span-2">
                <span class="field-label"
                  >Minimum delay (ms)
                  <span class="field-source">{{ sourceLabel("minDelayMs") }}</span></span
                >
                <input
                  name="minDelayMs"
                  type="number"
                  min="0"
                  inputmode="numeric"
                  :value="valueFor('minDelayMs')"
                  class="field-input"
                  @input="updateNumber('minDelayMs', $event)"
                />
              </label>
            </div>
          </fieldset>

          <fieldset class="space-y-4">
            <legend class="text-sm font-semibold text-text-primary">Approval and identity</legend>
            <div class="grid gap-3 md:grid-cols-2">
              <label class="check-row">
                <input
                  name="active"
                  type="checkbox"
                  :checked="valueFor('active')"
                  class="native-check"
                  @change="updateBoolean('active', $event)"
                />
                <span>
                  <span class="check-title">Account enabled</span>
                  <span class="check-help">Allow this account to be selected for new work.</span>
                </span>
                <span class="field-source">{{ sourceLabel("active") }}</span>
              </label>
              <label class="check-row">
                <input
                  name="humanReviewRequired"
                  type="checkbox"
                  :checked="valueFor('humanReviewRequired')"
                  class="native-check"
                  @change="updateBoolean('humanReviewRequired', $event)"
                />
                <span>
                  <span class="check-title">Always require review</span>
                  <span class="check-help">Keep drafts manual even when auto-approve passes.</span>
                </span>
                <span class="field-source">{{ sourceLabel("humanReviewRequired") }}</span>
              </label>
              <label class="check-row">
                <input
                  name="autoApproveEnabled"
                  type="checkbox"
                  :checked="valueFor('autoApproveEnabled')"
                  class="native-check"
                  @change="updateBoolean('autoApproveEnabled', $event)"
                />
                <span>
                  <span class="check-title">Auto-approve</span>
                  <span class="check-help">Let the quality gate approve eligible drafts.</span>
                </span>
                <span class="field-source">{{ sourceLabel("autoApproveEnabled") }}</span>
              </label>
              <label class="space-y-1.5">
                <span class="field-label"
                  >Minimum score
                  <span class="field-source">{{ sourceLabel("autoApproveMinScore") }}</span></span
                >
                <input
                  name="autoApproveMinScore"
                  type="number"
                  min="0"
                  max="10"
                  step="0.1"
                  :value="valueFor('autoApproveMinScore')"
                  class="field-input"
                  @input="updateNumber('autoApproveMinScore', $event)"
                />
              </label>
            </div>
          </fieldset>

          <fieldset class="space-y-4">
            <legend class="text-sm font-semibold text-text-primary">Editorial voice</legend>
            <div class="grid gap-4 md:grid-cols-2">
              <label class="space-y-1.5">
                <span class="field-label"
                  >Persona <span class="field-source">{{ sourceLabel("persona") }}</span></span
                >
                <input
                  name="persona"
                  :value="valueFor('persona')"
                  maxlength="5000"
                  class="field-input"
                  @input="updateText('persona', $event)"
                />
              </label>
              <label class="space-y-1.5">
                <span class="field-label"
                  >Banned phrases
                  <span class="field-source">{{ sourceLabel("bannedPhrases") }}</span></span
                >
                <textarea
                  name="bannedPhrases"
                  rows="4"
                  maxlength="20000"
                  class="field-input resize-y"
                  aria-describedby="banned-phrases-help"
                  @input="updateArray('bannedPhrases', $event)"
                  >{{ arrayValue("bannedPhrases") }}</textarea>
                <span id="banned-phrases-help" class="text-xs text-text-muted"
                  >One phrase per line.</span
                >
              </label>
              <label class="space-y-1.5 md:col-span-2">
                <span class="field-label"
                  >Brand voice
                  <span class="field-source">{{ sourceLabel("brandVoice") }}</span></span
                >
                <textarea
                  name="brandVoice"
                  rows="5"
                  maxlength="20000"
                  class="field-input resize-y"
                  @input="updateText('brandVoice', $event)"
                  >{{ valueFor("brandVoice") }}</textarea>
              </label>
              <label class="space-y-1.5 md:col-span-2">
                <span class="field-label"
                  >Example swipes
                  <span class="field-source">{{ sourceLabel("exampleSwipes") }}</span></span
                >
                <textarea
                  name="exampleSwipes"
                  rows="5"
                  maxlength="50000"
                  class="field-input resize-y"
                  aria-describedby="example-swipes-help"
                  @input="updateArray('exampleSwipes', $event)"
                  >{{ arrayValue("exampleSwipes") }}</textarea>
                <span id="example-swipes-help" class="text-xs text-text-muted"
                  >One example per line.</span
                >
              </label>
            </div>
          </fieldset>

          <fieldset class="space-y-4">
            <legend class="text-sm font-semibold text-text-primary">Visuals and browser</legend>
            <div class="grid gap-4 md:grid-cols-2">
              <label class="check-row">
                <input
                  name="imageGenerationEnabled"
                  type="checkbox"
                  :checked="valueFor('imageGenerationEnabled')"
                  class="native-check"
                  @change="updateBoolean('imageGenerationEnabled', $event)"
                />
                <span>
                  <span class="check-title">Image generation</span>
                  <span class="check-help">Allow image concepts for this account.</span>
                </span>
                <span class="field-source">{{ sourceLabel("imageGenerationEnabled") }}</span>
              </label>
              <label class="space-y-1.5">
                <span class="field-label"
                  >Image daily limit
                  <span class="field-source">{{ sourceLabel("imageDailyLimit") }}</span></span
                >
                <input
                  name="imageDailyLimit"
                  type="number"
                  min="0"
                  inputmode="numeric"
                  :value="valueFor('imageDailyLimit')"
                  class="field-input"
                  @input="updateNumber('imageDailyLimit', $event)"
                />
              </label>
              <label class="space-y-1.5">
                <span class="field-label"
                  >Image resolution
                  <span class="field-source">{{ sourceLabel("imageResolution") }}</span></span
                >
                <Select
                  :model-value="valueFor('imageResolution')"
                  :options="resolutionOptions"
                  @update:model-value="
                    setValue('imageResolution', $event as AccountSettings['imageResolution'])
                  "
                />
              </label>
              <label class="space-y-1.5">
                <span class="field-label"
                  >Image style
                  <span class="field-source">{{ sourceLabel("imageStyle") }}</span></span
                >
                <Select
                  :model-value="valueFor('imageStyle')"
                  :options="imageStyleOptions"
                  @update:model-value="
                    setValue('imageStyle', $event as AccountSettings['imageStyle'])
                  "
                />
              </label>
              <label class="space-y-1.5">
                <span class="field-label"
                  >Browser locale
                  <span class="field-source">{{ sourceLabel("browserLocale") }}</span></span
                >
                <input
                  name="browserLocale"
                  :value="valueFor('browserLocale')"
                  maxlength="35"
                  class="field-input"
                  @input="updateText('browserLocale', $event)"
                />
              </label>
              <label class="space-y-1.5">
                <span class="field-label"
                  >Browser timezone
                  <span class="field-source">{{ sourceLabel("browserTimezone") }}</span></span
                >
                <input
                  name="browserTimezone"
                  :value="valueFor('browserTimezone')"
                  maxlength="64"
                  class="field-input"
                  @input="updateText('browserTimezone', $event)"
                />
              </label>
            </div>
          </fieldset>

          <div
            class="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5"
          >
            <Button
              type="button"
              variant="ghost"
              :disabled="Object.keys(overrides).length === 0 || saving"
              @click="overrides = {}"
            >
              <RotateCcw class="h-4 w-4" aria-hidden="true" />
              Reset all overrides
            </Button>
            <Button type="submit" variant="primary" :loading="saving">
              <Save class="h-4 w-4" aria-hidden="true" />
              Save changes
            </Button>
          </div>
        </form>
      </Card>
      <Card v-else class="p-8">
        <div
          class="flex flex-col items-center justify-center gap-3 py-12 text-center text-text-muted"
        >
          <CircleOff class="h-8 w-8" aria-hidden="true" />
          <p>Select an account to edit its settings.</p>
        </div>
      </Card>
    </div>

    <p v-if="error && accounts.length > 0" class="text-sm text-error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.field-label {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--color-text-secondary);
}

.field-source {
  flex-shrink: 0;
  font-size: 0.6875rem;
  font-weight: 400;
  color: var(--color-text-muted);
}

.field-input {
  min-height: 2.75rem;
  width: 100%;
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  background: var(--color-surface-elevated);
  padding: 0.65rem 0.75rem;
  font-size: 1rem;
  color: var(--color-text-primary);
  outline: none;
  transition:
    border-color 160ms ease,
    box-shadow 160ms ease;
}

.field-input:focus-visible {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-primary) 35%, transparent);
}

.check-row {
  display: flex;
  min-height: 3rem;
  align-items: flex-start;
  gap: 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  padding: 0.75rem;
  cursor: pointer;
}

.check-row:has(input:focus-visible) {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-primary) 35%, transparent);
}

.native-check {
  width: 1.25rem;
  height: 1.25rem;
  margin-top: 0.125rem;
  flex-shrink: 0;
  accent-color: var(--color-primary);
}

.check-title {
  display: block;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--color-text-primary);
}

.check-help {
  display: block;
  margin-top: 0.25rem;
  font-size: 0.75rem;
  color: var(--color-text-muted);
}
</style>
