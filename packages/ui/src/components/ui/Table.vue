<script setup lang="ts">
import { cn } from "../../lib/utils";

const props = withDefaults(
  defineProps<{
    hoverable?: boolean;
    dense?: boolean;
    loading?: boolean;
    empty?: boolean;
    emptyText?: string;
    class?: string;
  }>(),
  {
    hoverable: true,
    dense: false,
    loading: false,
    empty: false,
    emptyText: "Nothing here yet",
  },
);
</script>

<template>
  <div class="w-full overflow-x-auto rounded-xl border border-border bg-surface">
    <table :class="cn('ui-table w-full text-sm', { hoverable }, props.class)">
      <slot />
    </table>

    <div
      v-if="loading"
      class="px-4 py-8 text-center text-text-secondary text-xs"
      data-testid="table-loading"
    >
      Loading…
    </div>
    <div
      v-else-if="empty"
      class="px-4 py-8 text-center text-text-secondary text-xs"
      data-testid="table-empty"
    >
      {{ emptyText }}
    </div>
  </div>
</template>

<style scoped>
.ui-table :deep(thead th) {
  text-align: left;
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-text-secondary);
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface-elevated);
  white-space: nowrap;
}

.ui-table :deep(tbody td) {
  padding: v-bind("dense ? '0.5rem 1rem' : '0.75rem 1rem'");
  border-bottom: 1px solid var(--color-border);
  color: var(--color-text-primary);
  vertical-align: middle;
}

.ui-table :deep(tbody tr:last-child td) {
  border-bottom: none;
}

.ui-table:hoverable :deep(tbody tr) {
  cursor: default;
  transition: background-color 120ms ease;
}

.ui-table.hoverable :deep(tbody tr:hover) {
  background: var(--color-surface-highlight);
}
</style>
