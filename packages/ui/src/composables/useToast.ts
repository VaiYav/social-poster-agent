import { ref, readonly } from "vue";

export type ToastType = "success" | "error" | "info" | "warning";

export interface Toast {
  id: number;
  type: ToastType;
  message: string;
  duration: number;
}

const toasts = ref<Toast[]>([]);
let nextId = 0;

/**
 * useToast — global toast notification composable.
 * Provides show(), dismiss(), and reactive toasts list.
 * Used by ToastContainer.vue and any component that needs notifications.
 */
export function useToast() {
  function show(message: string, type: ToastType = "info", duration = 4000) {
    const id = ++nextId;
    toasts.value.push({ id, type, message, duration });
    if (duration > 0) {
      setTimeout(() => dismiss(id), duration);
    }
    return id;
  }

  function success(message: string, duration?: number) {
    return show(message, "success", duration);
  }

  function error(message: string, duration?: number) {
    return show(message, "error", duration ?? 6000);
  }

  function info(message: string, duration?: number) {
    return show(message, "info", duration);
  }

  function warning(message: string, duration?: number) {
    return show(message, "warning", duration);
  }

  function dismiss(id: number) {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }

  function clear() {
    toasts.value = [];
  }

  return {
    toasts: readonly(toasts),
    show,
    success,
    error,
    info,
    warning,
    dismiss,
    clear,
  };
}
