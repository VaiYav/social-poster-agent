<script setup lang="ts">
import { cn } from '../../lib/utils';

type StatusState = 'connected' | 'disconnected' | 'loading';

const props = withDefaults(defineProps<{
  state?: StatusState;
  pulse?: boolean;
  label?: string;
  class?: string;
}>(), {
  state: 'connected',
  pulse: true,
});

const stateStyles: Record<StatusState, string> = {
  connected: 'bg-success',
  disconnected: 'bg-error',
  loading: 'bg-warning',
};

const stateLabels: Record<StatusState, string> = {
  connected: 'Live',
  disconnected: 'Disconnected',
  loading: 'Connecting',
};
</script>

<template>
  <div :class="cn('inline-flex items-center gap-2', props.class)">
    <span
      class="h-2.5 w-2.5 rounded-full"
      :class="[
        stateStyles[state],
        pulse && state !== 'disconnected' && 'animate-pulse',
      ]"
    />
    <span v-if="label || $slots.default" class="text-sm text-text-secondary">
      <slot>{{ label ?? stateLabels[state] }}</slot>
    </span>
  </div>
</template>
