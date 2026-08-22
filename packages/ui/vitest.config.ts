import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "src"),
      "@shared": resolve(import.meta.dirname, "../shared/src"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    include: ["tests/**/*.spec.ts", "tests/**/*.test.ts"],
    exclude: ["node_modules", "dist", "tests/e2e/**"],
    setupFiles: ["tests/setup.ts"],
  },
});
