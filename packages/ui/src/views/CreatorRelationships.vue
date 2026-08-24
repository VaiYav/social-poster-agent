<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Ban, Clock3, RefreshCw, ShieldCheck, Users } from "@lucide/vue";
import { Badge, Button, Card, SectionHeader } from "../components/ui";
import ErrorState from "../components/ErrorState.vue";
import LoadingSpinner from "../components/LoadingSpinner.vue";
import { useApi } from "../composables/useApi";
import { useToast } from "../composables/useToast";

interface CreatorProfile {
  id: string;
  network: string;
  handleCanonical: string;
  displayName: string | null;
  profileUrl: string;
  status: string;
  publicTopics: unknown;
}

interface CreatorEvidence {
  id: string;
  evidenceType: string;
  occurredAt: string;
  weight: number | null;
}

interface CreatorRelationship {
  id: string;
  stage: string;
  status: string;
  interactionCount: number;
  substantiveReplyCount: number;
  reciprocalCount: number;
  cooldownUntil: string | null;
  ownerNote: string | null;
  version: number;
  creator: CreatorProfile;
  evidence: CreatorEvidence[];
}

interface CreatorIdentityLink {
  id: string;
  sourceCreatorId: string;
  targetCreatorId: string;
  reviewReason: string;
  reviewedAt: string;
  source: CreatorProfile;
  target: CreatorProfile;
}

const api = useApi();
const toast = useToast();
const relationships = ref<CreatorRelationship[]>([]);
const selectedId = ref<string | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const actionLoading = ref(false);
const identityLinks = ref<CreatorIdentityLink[]>([]);
const identityTargetId = ref("");
const identityEvidence = ref("");
const identityReason = ref("");

const selected = computed(
  () => relationships.value.find((relationship) => relationship.id === selectedId.value) ?? null,
);

const cooldownCount = computed(
  () => relationships.value.filter((relationship) => isCoolingDown(relationship)).length,
);

const reciprocalCount = computed(
  () =>
    relationships.value.filter(
      (relationship) =>
        relationship.stage === "RECIPROCAL" || relationship.stage === "COLLABORATION_CANDIDATE",
    ).length,
);

function isCoolingDown(relationship: CreatorRelationship): boolean {
  return Boolean(relationship.cooldownUntil && new Date(relationship.cooldownUntil) > new Date());
}

function stageVariant(stage: string): "success" | "warning" | "info" | "secondary" | "neutral" {
  if (stage === "RECIPROCAL" || stage === "COLLABORATION_CANDIDATE") return "success";
  if (stage === "ENGAGED" || stage === "OBSERVED") return "info";
  if (stage === "DO_NOT_ENGAGE") return "warning";
  if (stage === "DORMANT") return "secondary";
  return "neutral";
}

function formatDate(value: string | null): string {
  if (!value) return "Not set";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

function selectRelationship(relationship: CreatorRelationship): void {
  selectedId.value = relationship.id;
  void loadIdentityLinks(relationship.creator.id);
}

async function loadIdentityLinks(creatorId: string): Promise<void> {
  try {
    const response = await api.get<CreatorIdentityLink[]>(`/creators/${creatorId}/identity-links`);
    identityLinks.value = response.data;
  } catch {
    identityLinks.value = [];
  }
}

async function loadRelationships(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const response = await api.get<CreatorRelationship[]>("/creators/relationships");
    relationships.value = response.data;
    if (!selectedId.value && relationships.value[0]) selectedId.value = relationships.value[0].id;
    if (selectedId.value && !relationships.value.some((item) => item.id === selectedId.value)) {
      selectedId.value = relationships.value[0]?.id ?? null;
    }
    if (relationships.value[0]) {
      const current = selected.value ?? relationships.value[0];
      await loadIdentityLinks(current.creator.id);
    }
  } catch (err) {
    error.value = (err as Error).message || "Failed to load creator relationships";
  } finally {
    loading.value = false;
  }
}

async function linkIdentity(): Promise<void> {
  if (
    !selected.value ||
    !identityTargetId.value.trim() ||
    !identityEvidence.value.trim() ||
    !identityReason.value.trim()
  ) {
    toast.error("Target profile, public refs and review reason are required");
    return;
  }
  actionLoading.value = true;
  try {
    await api.post(`/creators/${selected.value.creator.id}/link-identity`, {
      targetCreatorId: identityTargetId.value.trim(),
      evidence: {
        publicProfileRefs: identityEvidence.value
          .split("\n")
          .map((value) => value.trim())
          .filter(Boolean),
      },
      reason: identityReason.value.trim(),
    });
    toast.success("Identity link saved");
    identityTargetId.value = "";
    identityEvidence.value = "";
    identityReason.value = "";
    await loadIdentityLinks(selected.value.creator.id);
  } catch (err) {
    toast.error((err as Error).message || "Failed to save identity link");
  } finally {
    actionLoading.value = false;
  }
}

async function unlinkIdentity(linkId: string): Promise<void> {
  if (!window.confirm("Unlink these public identities?")) return;
  actionLoading.value = true;
  try {
    await api.post(`/creators/identity-links/${linkId}/unlink`, { reason: "Unlinked by operator" });
    toast.success("Identity link removed");
    if (selected.value) await loadIdentityLinks(selected.value.creator.id);
  } catch (err) {
    toast.error((err as Error).message || "Failed to unlink identity");
  } finally {
    actionLoading.value = false;
  }
}

async function setCooldown(): Promise<void> {
  if (!selected.value) return;
  actionLoading.value = true;
  try {
    const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await api.post(`/creators/relationships/${selected.value.id}/cooldown`, {
      until,
      reason: "Operator review: prevent repetitive targeting for the next 24 hours",
    });
    toast.success("24-hour cooldown set");
    await loadRelationships();
  } catch (err) {
    toast.error((err as Error).message || "Failed to set cooldown");
  } finally {
    actionLoading.value = false;
  }
}

async function blockCreator(): Promise<void> {
  if (!selected.value || !window.confirm("Stop all future recommendations for this creator?"))
    return;
  actionLoading.value = true;
  try {
    await api.post(`/creators/${selected.value.creator.id}/do-not-engage`, {
      reason: "Blocked by operator from Creator Relationships",
    });
    toast.success("Creator marked Do not engage");
    await loadRelationships();
  } catch (err) {
    toast.error((err as Error).message || "Failed to block creator");
  } finally {
    actionLoading.value = false;
  }
}

onMounted(loadRelationships);
</script>

<template>
  <div class="space-y-6">
    <SectionHeader
      title="Creator relationships"
      description="Keep public relationships useful, paced and human-controlled. Recommendations never send outreach automatically."
    />

    <LoadingSpinner v-if="loading" message="Loading relationship signals…" />
    <ErrorState v-else-if="error" :message="error" />
    <template v-else>
      <div class="grid gap-3 sm:grid-cols-3">
        <Card class="relative overflow-hidden !p-4">
          <div class="absolute inset-y-0 left-0 w-1 bg-primary" aria-hidden="true" />
          <p class="text-xs font-medium uppercase tracking-[0.16em] text-text-muted">
            Relationships
          </p>
          <p class="mt-2 text-2xl font-semibold text-text-primary">{{ relationships.length }}</p>
          <p class="mt-1 text-xs text-text-secondary">Public, network-scoped records</p>
        </Card>
        <Card class="relative overflow-hidden !p-4">
          <div class="absolute inset-y-0 left-0 w-1 bg-success" aria-hidden="true" />
          <p class="text-xs font-medium uppercase tracking-[0.16em] text-text-muted">Reciprocal</p>
          <p class="mt-2 text-2xl font-semibold text-text-primary">{{ reciprocalCount }}</p>
          <p class="mt-1 text-xs text-text-secondary">Evidence-backed candidates</p>
        </Card>
        <Card class="relative overflow-hidden !p-4">
          <div class="absolute inset-y-0 left-0 w-1 bg-warning" aria-hidden="true" />
          <p class="text-xs font-medium uppercase tracking-[0.16em] text-text-muted">Cooldown</p>
          <p class="mt-2 text-2xl font-semibold text-text-primary">{{ cooldownCount }}</p>
          <p class="mt-1 text-xs text-text-secondary">No repetitive targeting</p>
        </Card>
      </div>

      <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Card class="!p-0" aria-label="Creator relationship list">
          <div class="flex items-center justify-between border-b border-border px-5 py-4">
            <div class="flex items-center gap-2">
              <Users class="h-4 w-4 text-primary" aria-hidden="true" />
              <h2 class="text-sm font-semibold text-text-primary">Relationship signal board</h2>
            </div>
            <Button
              variant="ghost"
              size="sm"
              class="!p-2"
              aria-label="Refresh creator relationships"
              title="Refresh creator relationships"
              @click="loadRelationships"
            >
              <RefreshCw class="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
          <div
            v-if="relationships.length === 0"
            class="px-5 py-12 text-center text-sm text-text-muted"
          >
            No public creator relationships yet.
          </div>
          <div v-else class="divide-y divide-border">
            <button
              v-for="relationship in relationships"
              :key="relationship.id"
              type="button"
              class="group relative flex w-full items-start gap-4 px-5 py-4 text-left transition-colors hover:bg-surface-highlight focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
              :class="selectedId === relationship.id ? 'bg-primary-subtle/60' : ''"
              @click="selectRelationship(relationship)"
            >
              <span
                class="mt-1 h-2.5 w-2.5 shrink-0 rounded-full ring-4 ring-primary/10"
                :class="isCoolingDown(relationship) ? 'bg-warning' : 'bg-primary'"
                aria-hidden="true"
              />
              <span class="min-w-0 flex-1">
                <span class="flex flex-wrap items-center gap-2">
                  <span class="truncate text-sm font-semibold text-text-primary">
                    {{
                      relationship.creator.displayName || `@${relationship.creator.handleCanonical}`
                    }}
                  </span>
                  <Badge :variant="stageVariant(relationship.stage)">{{
                    relationship.stage
                  }}</Badge>
                </span>
                <span class="mt-1 block text-xs text-text-secondary">
                  {{ relationship.creator.network }} · @{{ relationship.creator.handleCanonical }} ·
                  {{ relationship.interactionCount }} interactions
                </span>
              </span>
              <Clock3
                v-if="isCoolingDown(relationship)"
                class="mt-1 h-4 w-4 shrink-0 text-warning"
                aria-label="Cooldown active"
              />
            </button>
          </div>
        </Card>

        <Card v-if="selected" class="h-fit !p-5" aria-label="Selected creator relationship">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-xs font-medium uppercase tracking-[0.16em] text-text-muted">
                Selected relationship
              </p>
              <h2 class="mt-2 text-lg font-semibold text-text-primary">
                {{ selected.creator.displayName || `@${selected.creator.handleCanonical}` }}
              </h2>
              <a
                class="mt-1 block truncate text-xs text-primary hover:underline"
                :href="selected.creator.profileUrl"
                target="_blank"
                rel="noreferrer"
              >
                {{ selected.creator.network }} · public profile
              </a>
            </div>
            <ShieldCheck class="h-5 w-5 text-primary" aria-hidden="true" />
          </div>

          <div class="mt-5 grid grid-cols-3 gap-2 border-y border-border py-4 text-center">
            <div>
              <p class="text-lg font-semibold text-text-primary">{{ selected.interactionCount }}</p>
              <p class="text-[11px] text-text-muted">touches</p>
            </div>
            <div>
              <p class="text-lg font-semibold text-text-primary">
                {{ selected.substantiveReplyCount }}
              </p>
              <p class="text-[11px] text-text-muted">substantive</p>
            </div>
            <div>
              <p class="text-lg font-semibold text-text-primary">{{ selected.reciprocalCount }}</p>
              <p class="text-[11px] text-text-muted">reciprocal</p>
            </div>
          </div>

          <div class="mt-4 space-y-3 text-sm">
            <div class="flex items-start justify-between gap-3">
              <span class="text-text-muted">Cooldown</span>
              <span class="text-right text-text-secondary">{{
                formatDate(selected.cooldownUntil)
              }}</span>
            </div>
            <div class="flex items-start justify-between gap-3">
              <span class="text-text-muted">Last evidence</span>
              <span class="text-right text-text-secondary">{{
                formatDate(selected.evidence[0]?.occurredAt ?? null)
              }}</span>
            </div>
          </div>

          <div class="mt-5 border-t border-border pt-4">
            <div class="flex items-center justify-between gap-3">
              <h3 class="text-sm font-semibold text-text-primary">Evidence timeline</h3>
              <span class="text-xs text-text-muted">{{ selected.evidence.length }} records</span>
            </div>
            <ol
              v-if="selected.evidence.length"
              class="mt-3 space-y-2 border-l border-primary/30 pl-4"
            >
              <li v-for="item in selected.evidence" :key="item.id" class="relative text-xs">
                <span
                  class="absolute -left-[1.35rem] top-1 h-2 w-2 rounded-full bg-primary"
                  aria-hidden="true"
                />
                <span class="font-medium text-text-secondary">{{ item.evidenceType }}</span>
                <span class="ml-2 text-text-muted">{{ formatDate(item.occurredAt) }}</span>
              </li>
            </ol>
            <p v-else class="mt-3 text-xs text-text-muted">No public evidence recorded yet.</p>
          </div>

          <div class="mt-5 border-t border-border pt-4">
            <div class="flex items-center justify-between gap-3">
              <h3 class="text-sm font-semibold text-text-primary">Cross-network identities</h3>
              <span class="text-xs text-text-muted">Human review only</span>
            </div>
            <div v-if="identityLinks.length" class="mt-3 space-y-2">
              <div
                v-for="link in identityLinks"
                :key="link.id"
                class="flex items-center justify-between gap-3 rounded-md bg-surface-highlight px-3 py-2 text-xs"
              >
                <span class="truncate text-text-secondary"
                  >{{ link.source.network }} ↔ {{ link.target.network }}</span
                >
                <button
                  type="button"
                  class="shrink-0 text-error hover:underline"
                  @click="unlinkIdentity(link.id)"
                >
                  Unlink
                </button>
              </div>
            </div>
            <form class="mt-3 space-y-2" @submit.prevent="linkIdentity">
              <label class="block text-xs text-text-muted" for="identity-target"
                >Target creator ID</label
              >
              <input
                id="identity-target"
                v-model="identityTargetId"
                class="field-input w-full"
                placeholder="creator profile ID"
              />
              <label class="block text-xs text-text-muted" for="identity-evidence"
                >Public profile refs</label
              >
              <textarea
                id="identity-evidence"
                v-model="identityEvidence"
                class="field-input min-h-16 w-full"
                placeholder="https://x.com/...&#10;https://threads.net/..."
              />
              <label class="block text-xs text-text-muted" for="identity-reason"
                >Review reason</label
              >
              <input
                id="identity-reason"
                v-model="identityReason"
                class="field-input w-full"
                placeholder="Same public website"
              />
              <Button
                type="submit"
                variant="outline"
                size="sm"
                :loading="actionLoading"
                class="w-full"
                >Link public identities</Button
              >
            </form>
          </div>

          <div class="mt-5 space-y-2">
            <Button :loading="actionLoading" class="w-full" @click="setCooldown">
              <template #icon><Clock3 class="h-4 w-4" aria-hidden="true" /></template>
              Set 24-hour cooldown
            </Button>
            <Button
              variant="outline"
              :loading="actionLoading"
              class="w-full !border-error/40 !text-error hover:!bg-error-subtle"
              @click="blockCreator"
            >
              <template #icon><Ban class="h-4 w-4" aria-hidden="true" /></template>
              Do not engage
            </Button>
          </div>
          <p class="mt-3 text-xs leading-relaxed text-text-muted">
            All stage changes and collaboration proposals remain operator-reviewed. A cooldown only
            pauses recommendations; it never sends a message.
          </p>
        </Card>
      </div>
    </template>
  </div>
</template>
