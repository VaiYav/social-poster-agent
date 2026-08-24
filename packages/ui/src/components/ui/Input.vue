<script setup lang="ts">
import { cn } from "../../lib/utils";

const props = defineProps<{
  modelValue?: string | number;
  type?: string;
  placeholder?: string;
  disabled?: boolean;
  error?: string;
  class?: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

function onInput(event: Event) {
  emit("update:modelValue", (event.target as HTMLInputElement).value);
}
</script>

<template>
  <div class="w-full">
    <input
      :type="type ?? 'text'"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      :class="
        cn(
          'h-10 w-full rounded-md border bg-surface-elevated px-3 text-sm text-text-primary placeholder:text-text-muted',
          'border-border focus:border-primary focus:ring-1 focus:ring-primary/50',
          'transition-colors duration-200',
          error && 'border-error focus:border-error focus:ring-error/50',
          props.class,
        )
      "
      @input="onInput"
    />
    <p v-if="error" class="mt-1 text-xs text-error">{{ error }}</p>
  </div>
</template>
