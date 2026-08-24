<script setup lang="ts">
import { watch, onBeforeUnmount } from "vue";
import { X } from "@lucide/vue";
import { cn } from "../../lib/utils";

type ModalSize = "sm" | "md" | "lg";

const props = withDefaults(
  defineProps<{
    open: boolean;
    title?: string;
    size?: ModalSize;
    closeOnBackdrop?: boolean;
    class?: string;
  }>(),
  {
    title: "",
    size: "md",
    closeOnBackdrop: true,
  },
);

const emit = defineEmits<{
  "update:open": [value: boolean];
  close: [];
}>();

const sizeStyles: Record<ModalSize, string> = {
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-2xl",
};

function close() {
  emit("update:open", false);
  emit("close");
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && props.open) close();
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      document.addEventListener("keydown", onKeydown);
      document.body.style.overflow = "hidden";
    } else {
      document.removeEventListener("keydown", onKeydown);
      document.body.style.overflow = "";
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKeydown);
  document.body.style.overflow = "";
});
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition-opacity duration-200"
      enter-from-class="opacity-0"
      leave-active-class="transition-opacity duration-150"
      leave-to-class="opacity-0"
    >
      <div
        v-if="open"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
        data-testid="modal-backdrop"
        @click.self="closeOnBackdrop && close()"
      >
        <div
          role="dialog"
          aria-modal="true"
          :aria-label="title || 'Dialog'"
          :class="
            cn(
              'glass-elevated rounded-2xl border border-border w-full shadow-cosmic',
              sizeStyles[size],
              props.class,
            )
          "
        >
          <div class="flex items-center justify-between px-5 py-4 border-b border-border">
            <slot name="header">
              <h3 class="text-base font-semibold text-text-primary">{{ title }}</h3>
            </slot>
            <button
              type="button"
              class="rounded-lg p-1.5 text-text-secondary hover:text-text-primary hover:bg-surface-highlight transition-colors"
              aria-label="Close"
              data-testid="modal-close"
              @click="close"
            >
              <X class="w-4 h-4" />
            </button>
          </div>
          <div class="px-5 py-4 max-h-[70vh] overflow-y-auto">
            <slot />
          </div>
          <div v-if="$slots.footer" class="px-5 py-4 border-t border-border flex justify-end gap-2">
            <slot name="footer" />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
