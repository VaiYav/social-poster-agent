<script setup lang="ts">
import type { Post } from '@spa/shared';
import { Check, X, Pencil, ExternalLink, Layers } from '@lucide/vue';
import { Card, Button } from './ui';
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
    ? props.post.content.slice(0, props.truncate) + '…'
    : props.post.content
  : props.post.content;

const isMultiStage = props.post.llmMetadata?.multiStage === true;
const threadLabel = isMultiStage
  ? `Multi-stage · ${(props.post.threadPosition ?? 0) + 1}/${props.post.llmMetadata?.threadDepth ?? '?'}`
  : props.post.threadId
    ? 'Thread'
    : null;
</script>

<template>
  <Card hoverable class="p-5">
    <div class="flex items-start justify-between gap-4">
      <div class="flex items-center gap-3">
        <NetworkIcon :network="post.network" />
        <span class="text-xs text-text-muted">
          {{ post.id.slice(0, 8) }}…
        </span>
      </div>
      <div class="flex items-center gap-2">
        <span
          v-if="threadLabel"
          class="inline-flex items-center gap-1 rounded-full bg-surface-highlight px-2 py-0.5 text-xs text-text-secondary"
          :class="isMultiStage ? 'text-primary' : ''"
        >
          <Layers class="h-3 w-3" />
          {{ threadLabel }}
        </span>
        <StatusBadge :status="post.status" />
      </div>
    </div>

    <p class="mt-4 text-sm leading-relaxed text-text-primary">
      {{ displayContent }}
    </p>

    <div v-if="post.postUrl" class="mt-3">
      <a
        :href="post.postUrl"
        target="_blank"
        class="inline-flex items-center gap-1 text-xs text-primary hover:text-primary-hover hover:underline"
      >
        <ExternalLink class="h-3 w-3" />
        View post
      </a>
    </div>

    <p v-if="post.errorMessage" class="mt-3 text-xs text-error">
      {{ post.errorMessage }}
    </p>

    <div v-if="showActions && post.status === 'DRAFT'" class="mt-4 flex flex-wrap gap-2">
      <Button size="sm" @click="emit('approve', post.id)">
        <Check class="h-3.5 w-3.5" />
        Approve
      </Button>
      <Button variant="secondary" size="sm" @click="emit('edit', post)">
        <Pencil class="h-3.5 w-3.5" />
        Edit
      </Button>
      <Button variant="outline" size="sm" @click="emit('reject', post.id)">
        <X class="h-3.5 w-3.5" />
        Reject
      </Button>
    </div>
  </Card>
</template>
