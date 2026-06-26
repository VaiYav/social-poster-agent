<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import type { Post } from '@spa/shared';

/**
 * PostEditor — modal for editing draft post content before approve.
 * Backend D2: approve() accepts optional editedContent.
 * The editor pre-fills with current content, allows editing,
 * then emits 'save' with editedContent or 'approve' directly.
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

// Network-specific character limits
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
  <div v-if="post" class="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50" @click.self="close">
    <div class="w-full max-w-2xl rounded-lg bg-white p-6 shadow-xl">
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-bold text-gray-900">Edit Draft Before Approve</h2>
        <button @click="close" class="text-gray-400 hover:text-gray-600">
          <svg class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div class="mt-4">
        <label class="block text-sm font-medium text-gray-700">
          Post content ({{ post.network }})
        </label>
        <textarea
          v-model="editedContent"
          rows="8"
          class="mt-1 block w-full rounded-md border border-gray-300 p-3 text-sm text-gray-900 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          :maxlength="charLimit"
          placeholder="Edit post content..."
        />
        <div class="mt-1 flex items-center justify-between">
          <p class="text-xs" :class="isOverLimit ? 'text-red-600' : 'text-gray-500'">
            {{ charCount }} / {{ networkLimit }} characters
          </p>
          <p v-if="isOverLimit" class="text-xs text-red-600">
            Over {{ post.network }} limit by {{ charCount - networkLimit }} chars
          </p>
        </div>
      </div>

      <div class="mt-6 flex justify-end gap-3">
        <button
          @click="close"
          class="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          @click="save"
          :disabled="editedContent.trim().length === 0 || isOverLimit"
          class="rounded-md bg-green-600 px-4 py-2 text-sm text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Save & Approve
        </button>
      </div>
    </div>
  </div>
</template>
