<script setup lang="ts">
import { ref, watch, computed } from "vue";
import type { Post } from "@spa/shared";
import { Button, Modal, Textarea } from "./ui";

/**
 * PostEditor — modal for editing draft post content before approve.
 * Backend D2: approve() accepts optional editedContent.
 * DESIGN-102: uses the shared Modal primitive (Esc/backdrop handled there).
 */
const props = defineProps<{
  post: Post | null;
}>();

const emit = defineEmits<{
  close: [];
  save: [id: string, editedContent: string];
}>();

const editedContent = ref("");
const charLimit = ref(5000);
const charCount = computed(() => editedContent.value.length);

const NETWORK_LIMITS: Record<string, number> = {
  X: 280,
  THREADS: 500,
  FACEBOOK: 500,
};

const isOverLimit = computed(() => {
  const limit = props.post ? (NETWORK_LIMITS[props.post.network] ?? 5000) : 5000;
  return editedContent.value.length > limit;
});

const networkLimit = computed(() => {
  return props.post ? (NETWORK_LIMITS[props.post.network] ?? 5000) : 5000;
});

watch(
  () => props.post,
  (newPost) => {
    if (newPost) {
      editedContent.value = newPost.content;
      charLimit.value = NETWORK_LIMITS[newPost.network] ?? 5000;
    }
  },
  { immediate: true },
);

function close() {
  emit("close");
}

function save() {
  if (props.post && editedContent.value.trim().length > 0) {
    emit("save", props.post.id, editedContent.value);
  }
}
</script>

<template>
  <Modal :open="post !== null" title="Edit Draft" size="lg" @close="close">
    <p class="-mt-1 text-sm text-text-secondary">
      Review and approve before posting to {{ post?.network }}
    </p>

    <div class="mt-4">
      <Textarea
        v-model="editedContent"
        :rows="8"
        :maxlength="charLimit"
        :error="isOverLimit ? `Over ${post?.network} limit` : undefined"
        placeholder="Edit post content..."
      />
      <div class="mt-2 flex items-center justify-between text-xs">
        <p :class="isOverLimit ? 'text-error' : 'text-text-muted'">
          {{ charCount }} / {{ networkLimit }} characters
        </p>
        <p v-if="isOverLimit" class="text-error">
          Over {{ post?.network }} limit by {{ charCount - networkLimit }} chars
        </p>
      </div>
    </div>

    <template #footer>
      <Button variant="outline" @click="close"> Cancel </Button>
      <Button :disabled="editedContent.trim().length === 0 || isOverLimit" @click="save">
        Save & Approve
      </Button>
    </template>
  </Modal>
</template>
