<script setup lang="ts">
import { cn } from "../../lib/utils";

const props = defineProps<{
  modelValue?: string;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
  maxlength?: number;
  error?: string;
  class?: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

function onInput(event: Event) {
  emit("update:modelValue", (event.target as HTMLTextAreaElement).value);
}
</script>

<template>
  <div class="w-full">
    <textarea
      :value="modelValue"
      :rows="rows ?? 4"
      :placeholder="placeholder"
      :disabled="disabled"
      :maxlength="maxlength"
      :class="
        cn(
          'w-full rounded-md border border-border bg-surface-elevated px-3 py-2.5 text-sm text-text-primary placeholder:text-text-muted',
          'focus:border-primary focus:ring-1 focus:ring-primary/50',
          'transition-colors duration-200 resize-y',
          error && 'border-error focus:border-error focus:ring-error/50',
          props.class,
        )
      "
      @input="onInput"
    />
    <p v-if="error" class="mt-1 text-xs text-error">{{ error }}</p>
  </div>
</template>
