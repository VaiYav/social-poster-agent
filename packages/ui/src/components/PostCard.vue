<script setup lang="ts">
import type { Post } from '@spa/shared';
import StatusBadge from './StatusBadge.vue';
import NetworkIcon from './NetworkIcon.vue';

const props = withDefaults(defineProps<{
  post: Post;
  showActions?: boolean;
  truncate?: number;
}>(), {
  showActions: false,
  truncate: 0,
});

const emit = defineEmits<{
  approve: [id: string];
  reject: [id: string];
  edit: [post: Post];
}>();

const displayContent = props.truncate > 0
  ? props.post.content.length > props.truncate
    ? props.post.content.slice(0, props.truncate) + '...'
    : props.post.content
  : props.post.content;
</script>

<template>
  <div class="rounded-lg border border-gray-200 bg-white p-4">
    <div class="flex items-center justify-between">
      <NetworkIcon :network="post.network" />
      <StatusBadge :status="post.status" />
    </div>
    <p class="mt-2 text-sm text-gray-700">{{ displayContent }}</p>
    <div v-if="post.postUrl" class="mt-2">
      <a :href="post.postUrl" target="_blank" class="text-xs text-blue-600 hover:underline">View post →</a>
    </div>
    <p v-if="post.errorMessage" class="mt-1 text-xs text-red-600">{{ post.errorMessage }}</p>
    <div v-if="showActions && post.status === 'DRAFT'" class="mt-3 flex gap-2">
      <button
        @click="emit('approve', post.id)"
        class="rounded bg-green-600 px-3 py-1 text-xs text-white hover:bg-green-700"
      >Approve</button>
      <button
        @click="emit('edit', post)"
        class="rounded bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-700"
      >Edit & Approve</button>
      <button
        @click="emit('reject', post.id)"
        class="rounded bg-red-600 px-3 py-1 text-xs text-white hover:bg-red-700"
      >Reject</button>
    </div>
  </div>
</template>
