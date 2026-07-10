<script setup lang="ts">
import { computed } from 'vue';
import { Radio } from '@lucide/vue';
import { Card, Badge } from '../ui';

interface FeedEvent {
  type: string;
  timestamp?: number;
  data?: Record<string, unknown>;
}

const props = defineProps<{
  events: FeedEvent[];
  maxEvents?: number;
}>();

const displayed = computed(() => props.events.slice(0, props.maxEvents ?? 20));

function formatEvent(event: FeedEvent): string {
  if (!event.data || typeof event.data !== 'object') return event.type;
  const data = event.data;
  if (data.postId) return `${event.type}: ${data.postId}`;
  if (data.network) return `${event.type}: ${data.network}`;
  if (data.runId) return `${event.type}: ${String(data.runId).slice(0, 8)}`;
  if (data.error) return `${event.type}: ${data.error}`;
  if (data.message) return `${event.type}: ${data.message}`;
  return event.type;
}

function formatTime(ts?: number): string {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString();
}

function eventKey(event: FeedEvent, index: number): string | number {
  // Prefer a content-based key; fall back to index only when no timestamp is present.
  if (event.timestamp) {
    return `${event.type}-${event.timestamp}-${index}`;
  }
  return index;
}

function statusVariant(event: FeedEvent): 'success' | 'warning' | 'error' | 'info' | 'neutral' {
  const data = event.data ?? {};
  const status =
    (typeof data.status === 'string' && data.status) ||
    (typeof data.severity === 'string' && data.severity) ||
    event.type;
  const text = status.toLowerCase();
  if (text.includes('error') || text.includes('failed') || text.includes('alert') || text.includes('critical')) return 'error';
  if (text.includes('completed') || text.includes('posted') || text.includes('success') || text.includes('replied')) return 'success';
  if (text.includes('paused') || text.includes('warning') || text.includes('review')) return 'warning';
  if (text.includes('progress') || text.includes('snapshot') || text.includes('started') || text.includes('info')) return 'info';
  return 'neutral';
}
</script>

<template>
  <Card>
    <template #header>
      <div class="flex items-center gap-2">
        <Radio class="h-5 w-5 text-primary" />
        <div>
          <h2 class="text-lg font-semibold text-text-primary">Live Event Feed</h2>
          <p class="text-sm text-text-secondary">Real-time SSE stream from all agents</p>
        </div>
      </div>
    </template>

    <div class="max-h-80 overflow-y-auto">
      <div v-if="events.length === 0" class="py-6 text-center text-sm text-text-muted">
        No events yet. Waiting for SSE stream...
      </div>
      <div v-else class="space-y-2">
        <div
          v-for="(event, i) in displayed"
          :key="eventKey(event, i)"
          class="flex items-start gap-3 rounded-md p-2 text-sm"
          :class="i % 2 === 0 ? 'bg-surface-elevated' : 'bg-surface'"
        >
          <Badge :variant="statusVariant(event)">
            <template #dot><span /></template>
            {{ event.type }}
          </Badge>
          <div class="flex-1">
            <span class="text-text-primary">{{ formatEvent(event) }}</span>
          </div>
          <span class="text-xs text-text-muted whitespace-nowrap">{{ formatTime(event.timestamp) }}</span>
        </div>
      </div>
    </div>
  </Card>
</template>
