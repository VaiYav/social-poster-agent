<script setup lang="ts">
import { cn } from "../../lib/utils";

type CardGlow = "none" | "primary" | "success" | "error";

const props = withDefaults(
  defineProps<{
    hoverable?: boolean;
    elevated?: boolean;
    glow?: CardGlow;
    class?: string;
  }>(),
  {
    hoverable: false,
    elevated: false,
    glow: "none",
  },
);

const glowStyles: Record<CardGlow, string> = {
  none: "",
  primary: "shadow-glow-primary",
  success: "shadow-glow-success",
  error: "shadow-glow-error",
};
</script>

<template>
  <div
    :class="
      cn(
        'rounded-lg border border-border bg-surface p-5',
        elevated && 'bg-surface-elevated shadow-cosmic',
        hoverable && 'card-hover cursor-pointer',
        glowStyles[glow],
        props.class,
      )
    "
  >
    <div v-if="$slots.header" class="mb-4">
      <slot name="header" />
    </div>
    <slot />
    <div v-if="$slots.footer" class="mt-4">
      <slot name="footer" />
    </div>
  </div>
</template>
