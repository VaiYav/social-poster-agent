<script setup lang="ts">
import { cn } from "../../lib/utils";

export interface TabItem {
  value: string;
  label: string;
  count?: number;
}

const props = withDefaults(
  defineProps<{
    tabs: TabItem[];
    modelValue: string;
    size?: "sm" | "md";
    class?: string;
  }>(),
  { size: "md" },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

function select(value: string) {
  if (value !== props.modelValue) emit("update:modelValue", value);
}
</script>

<template>
  <div role="tablist" :class="cn('flex items-center gap-1 border-b border-border', props.class)">
    <button
      v-for="tab in tabs"
      :key="tab.value"
      type="button"
      role="tab"
      :aria-selected="tab.value === modelValue"
      :data-testid="`tab-${tab.value}`"
      :class="
        cn(
          'relative px-3 transition-colors border-b-2 -mb-px font-medium',
          size === 'sm' ? 'py-1.5 text-xs' : 'py-2.5 text-sm',
          tab.value === modelValue
            ? 'border-primary text-text-primary'
            : 'border-transparent text-text-secondary hover:text-text-primary hover:border-border',
        )
      "
      @click="select(tab.value)"
    >
      {{ tab.label }}
      <span
        v-if="tab.count !== undefined"
        class="ml-1.5 inline-flex items-center justify-center rounded-full bg-surface-highlight text-text-secondary text-[0.625rem] px-1.5 py-0.5 align-middle"
      >
        {{ tab.count }}
      </span>
    </button>
  </div>
</template>
