<script setup lang="ts">
import { cn } from "../lib/utils";

const props = defineProps<{
  network: string;
  class?: string;
}>();

const networkConfig: Record<string, { icon: string; label: string; color: string }> = {
  X: { icon: "𝕏", label: "X.com", color: "text-text-primary" },
  THREADS: { icon: "🧵", label: "Threads", color: "text-secondary" },
  FACEBOOK: { icon: "📘", label: "Facebook", color: "text-info" },
};

const config = networkConfig[props.network] ?? {
  icon: "?",
  label: props.network,
  color: "text-text-muted",
};
</script>

<template>
  <span :class="cn('flex items-center gap-1.5 text-xs font-medium', config.color, props.class)">
    <span class="flex h-5 w-5 items-center justify-center rounded bg-surface-highlight text-xs">
      {{ config.icon }}
    </span>
    <span>{{ config.label }}</span>
  </span>
</template>
