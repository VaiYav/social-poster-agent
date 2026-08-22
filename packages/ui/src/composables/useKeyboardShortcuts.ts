/**
 * Global keyboard shortcuts for SPA operator dashboard.
 *
 * Shortcuts:
 *   Ctrl+K → Queue (approval queue)
 *   Ctrl+G → Generate
 *   Ctrl+D → Dashboard
 *   Ctrl+M → Monitor
 *   Ctrl+F → Flow Control (emergency)
 *   Ctrl+R → Reports
 *   A      → Approve selected (in Queue view)
 *   R      → Reject selected (in Queue view)
 *   Space  → Pause/Resume auto-refresh (in Monitor view)
 *   ?      → Show shortcuts help
 */
import { onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";

export function useKeyboardShortcuts() {
  const router = useRouter();

  function handler(e: KeyboardEvent) {
    // Don't intercept when typing in inputs
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
      return;
    }

    // Ctrl/Cmd + key combos
    if (e.ctrlKey || e.metaKey) {
      switch (e.key.toLowerCase()) {
        case "k":
          e.preventDefault();
          router.push("/queue");
          break;
        case "g":
          e.preventDefault();
          router.push("/generate");
          break;
        case "d":
          e.preventDefault();
          router.push("/");
          break;
        case "m":
          e.preventDefault();
          router.push("/monitor");
          break;
        case "f":
          e.preventDefault();
          router.push("/flow-control");
          break;
        case "r":
          e.preventDefault();
          router.push("/reports");
          break;
      }
      return;
    }

    // Single-key shortcuts (only when not in input)
    switch (e.key) {
      case "?":
        // Toggle shortcuts help — emit event for App.vue to handle
        window.dispatchEvent(new CustomEvent("spa:toggle-shortcuts-help"));
        break;
    }
  }

  onMounted(() => {
    window.addEventListener("keydown", handler);
  });

  onUnmounted(() => {
    window.removeEventListener("keydown", handler);
  });
}
