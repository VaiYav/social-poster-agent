<script setup lang="ts">
import { cn } from "../../lib/utils";

type TooltipPosition = "top" | "bottom" | "left" | "right";

const props = withDefaults(
  defineProps<{
    text: string;
    position?: TooltipPosition;
    class?: string;
  }>(),
  { position: "top" },
);

/* CSS-only: bubble follows the trigger's hover/focus state via group classes. */
const positionStyles: Record<TooltipPosition, string> = {
  top: "bottom-full left-1/2 -translate-x-1/2 mb-2",
  bottom: "top-full left-1/2 -translate-x-1/2 mt-2",
  left: "right-full top-1/2 -translate-y-1/2 mr-2",
  right: "left-full top-1/2 -translate-y-1/2 ml-2",
};
</script>

<template>
  <span :class="cn('relative inline-flex group/tooltip', props.class)">
    <slot />
    <span
      role="tooltip"
      :class="
        cn(
          'pointer-events-none absolute z-40 whitespace-nowrap rounded-lg border border-border bg-surface-elevated px-2.5 py-1.5 text-xs text-text-primary shadow-cosmic',
          'opacity-0 translate-y-0.5 transition-all duration-150',
          'group-hover/tooltip:opacity-100 group-hover/tooltip:translate-y-0',
          'group-focus-within/tooltip:opacity-100',
          positionStyles[position],
        )
      "
    >
      {{ text }}
    </span>
  </span>
</template>
