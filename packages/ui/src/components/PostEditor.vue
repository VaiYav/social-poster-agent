<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import type { Post } from '@spa/shared';
import { X } from '@lucide/vue';
import { Button, Textarea } from './ui';

/**
 * PostEditor — modal for editing draft post content before approve.
 * Backend D2: approve() accepts optional editedContent.
 */
const props = defineProps<{
  post: Post | null;
}>();

const emit = defineEmits<{
  close: [];
  save: [id: string, editedContent: string];
}>();

const editedContent = ref('');
const charLimit = ref(5000);
const charCount = computed(() => editedContent.value.length);

const NETWORK_LIMITS: Record<string, number> = {
  X: 280,
  THREADS: 500,
  FACEBOOK: 500,
};

const isOverLimit = computed(() => {
  const limit = props.post ? NETWORK_LIMITS[props.post.network] ?? 5000 : 5000;
  return editedContent.value.length > limit;
});

const networkLimit = computed(() => {
  return props.post ? NETWORK_LIMITS[props.post.network] ?? 5000 : 5000;
});

watch(() => props.post, (newPost) => {
  if (newPost) {
    editedContent.value = newPost.content;
    charLimit.value = NETWORK_LIMITS[newPost.network] ?? 5000;
  }
}, { immediate: true });

function save() {
  if (props.post && editedContent.value.trim().length > 0) {
    emit('save', props.post.id, editedContent.value);
  }
}

function close() {
  emit('close');
}
</script>

<template>
  <Transition name="modal">
    <div
      v-if="post"
      class="fixed inset-0 z-50 flex items-center justify-center p-4"
      @click.self="close"
    >
      <div class="absolute inset-0 bg-background/80 backdrop-blur-sm" />
      <div class="relative w-full max-w-2xl rounded-xl border border-border bg-surface-elevated p-6 shadow-elevated">
        <div class="flex items-center justify-between">
          <div>
            <h2 class="text-lg font-bold text-text-primary">Edit Draft</h2>
            <p class="text-sm text-text-secondary">
              Review and approve before posting to {{ post.network }}
            </p>
          </div>
          <button
            @click="close"
            class="rounded-lg p-2 text-text-muted transition-colors hover:bg-surface-highlight hover:text-text-primary"
          >
            <X class="h-5 w-5" />
          </button>
        </div>

        <div class="mt-5">
          <Textarea
            v-model="editedContent"
            :rows="8"
            :maxlength="charLimit"
            :error="isOverLimit ? `Over ${post.network} limit` : undefined"
            placeholder="Edit post content..."
          />
          <div class="mt-2 flex items-center justify-between text-xs">
            <p :class="isOverLimit ? 'text-error' : 'text-text-muted'">
              {{ charCount }} / {{ networkLimit }} characters
            </p>
            <p v-if="isOverLimit" class="text-error">
              Over {{ post.network }} limit by {{ charCount - networkLimit }} chars
            </p>
          </div>
        </div>

        <div class="mt-6 flex justify-end gap-3">
          <Button variant="outline" @click="close">
            Cancel
          </Button>
          <Button
            :disabled="editedContent.trim().length === 0 || isOverLimit"
            @click="save"
          >
            Save & Approve
          </Button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.modal-enter-active,
.modal-leave-active {
  transition: all 0.2s ease;
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
.modal-enter-active .relative,
.modal-leave-active .relative {
  transition: transform 0.2s ease;
}
.modal-enter-from .relative,
.modal-leave-to .relative {
  transform: scale(0.96);
}
</style>
