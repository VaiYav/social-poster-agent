<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import type { Post, PostReviewFeedback, ReviewReasonCode } from "@spa/shared";
import { Button, Textarea } from "./ui";

const props = defineProps<{
  post: Post | null;
}>();

const emit = defineEmits<{
  cancel: [];
  submit: [feedback: PostReviewFeedback];
}>();

const dialog = ref<HTMLDialogElement | null>(null);
const reasonCodes = ref<ReviewReasonCode[]>([]);
const comment = ref("");
const submitted = ref(false);

const REASONS: Array<{ value: ReviewReasonCode; label: string }> = [
  { value: "FACT_UNSUPPORTED", label: "Fact is unsupported" },
  { value: "FACT_INCORRECT", label: "Fact is incorrect" },
  { value: "VOICE_AI_GENERIC", label: "Voice sounds generic or AI-written" },
  { value: "HOOK_WEAK", label: "Hook is weak" },
  { value: "PLATFORM_MISMATCH", label: "Platform mismatch" },
  { value: "LANGUAGE_QUALITY", label: "Language quality" },
  { value: "POLICY_RISK", label: "Policy or reputation risk" },
  { value: "CTA_INVALID", label: "CTA or link is invalid" },
  { value: "TOO_LONG", label: "Too long" },
  { value: "DUPLICATE", label: "Duplicate" },
  { value: "OTHER_REVIEWED", label: "Other reviewed reason" },
];

watch(
  () => props.post,
  async (post) => {
    if (!post) {
      if (dialog.value?.open) dialog.value.close();
      return;
    }
    reasonCodes.value = [];
    comment.value = "";
    submitted.value = false;
    await nextTick();
    if (dialog.value && !dialog.value.open) dialog.value.showModal();
  },
  { immediate: true },
);

function toggleReason(reason: ReviewReasonCode) {
  reasonCodes.value = reasonCodes.value.includes(reason)
    ? reasonCodes.value.filter((value) => value !== reason)
    : [...reasonCodes.value, reason];
  submitted.value = false;
}

function close() {
  dialog.value?.close();
  emit("cancel");
}

function submit() {
  submitted.value = true;
  if (reasonCodes.value.length === 0) return;
  emit("submit", {
    reasonCodes: reasonCodes.value,
    ...(comment.value.trim() ? { comment: comment.value.trim() } : {}),
  });
  dialog.value?.close();
}
</script>

<template>
  <dialog
    ref="dialog"
    closedby="any"
    aria-labelledby="review-feedback-title"
    class="review-dialog rounded-xl border border-border bg-surface-elevated p-0 text-text-primary shadow-elevated backdrop:bg-background/80"
    @cancel.prevent="close"
  >
    <form class="w-[min(92vw,42rem)] p-6" @submit.prevent="submit">
      <h2 id="review-feedback-title" class="text-lg font-bold">Why reject this draft?</h2>
      <p class="mt-1 text-sm text-text-secondary">
        Select at least one reason. This feedback improves future content review.
      </p>

      <fieldset class="mt-5">
        <legend class="text-sm font-semibold text-text-primary">Review reasons</legend>
        <div class="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label
            v-for="reason in REASONS"
            :key="reason.value"
            class="flex min-h-12 items-center gap-3 rounded-lg border border-border px-3 py-2 text-sm hover:bg-surface-highlight"
          >
            <input
              type="checkbox"
              :name="`review-reason-${reason.value}`"
              :checked="reasonCodes.includes(reason.value)"
              class="h-4 w-4 accent-primary"
              @change="toggleReason(reason.value)"
            />
            <span>{{ reason.label }}</span>
          </label>
        </div>
      </fieldset>

      <p v-if="submitted && reasonCodes.length === 0" class="mt-2 text-sm text-error" role="alert">
        Choose at least one review reason.
      </p>

      <div class="mt-5">
        <label for="review-feedback-comment" class="text-sm font-semibold">Note (optional)</label>
        <Textarea
          id="review-feedback-comment"
          v-model="comment"
          name="comment"
          class="mt-2"
          :rows="4"
          :maxlength="500"
          aria-describedby="review-feedback-comment-help"
          placeholder="Add a short note for future review..."
        />
        <p id="review-feedback-comment-help" class="mt-1 text-xs text-text-muted">
          {{ comment.length }}/500 characters
        </p>
      </div>

      <div class="mt-6 flex justify-end gap-3">
        <Button type="button" variant="outline" @click="close">Cancel</Button>
        <Button type="submit" variant="destructive">Reject with feedback</Button>
      </div>
    </form>
  </dialog>
</template>

<style scoped>
.review-dialog::backdrop {
  backdrop-filter: blur(3px);
}

.review-dialog:not([open]) {
  display: none;
}
</style>
