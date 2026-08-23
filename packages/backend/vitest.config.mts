import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  // Vite 8 / Vitest 4 use the oxc transformer. Test files are excluded from
  // tsconfig.json, so oxc does not pick up experimentalDecorators for them.
  // Enable legacy decorators explicitly so test fixtures like @Public() work.
  oxc: {
    decorator: {
      legacy: true,
      emitDecoratorMetadata: true,
    },
  },
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "src"),
      "@domain": resolve(import.meta.dirname, "src/domain"),
      "@modules": resolve(import.meta.dirname, "src/modules"),
      "@infra": resolve(import.meta.dirname, "src/infrastructure"),
      "@config": resolve(import.meta.dirname, "src/config"),
      "@shared": resolve(import.meta.dirname, "../shared/src"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.spec.ts", "tests/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/main.ts",
        "src/**/*.module.ts",
        "src/**/*.dto.ts",
        "src/domain/ports/**",
        // Generated Prisma client (prisma-client generator output): build
        // artifact, not hand-written code — counting it poisons the denominator.
        "src/generated/**",
        // CLI entrypoints are exercised via scripts/dry-runs, not unit suites.
        "src/cli.ts",
        "src/dry-run/**",
      ],
      thresholds: {
        // Ratchet policy (CI-001): these are ENFORCED floors set just under the
        // measured baseline (2026-08-23, generated client excluded):
        //   statements 74.43 · branches 65.54 · functions 71.87 · lines 75.91
        // Any regression fails CI immediately. Raise the floors as suites grow;
        // target is the original 80/75/80/80 — do NOT lower them to make a
        // change pass.
        statements: 73,
        branches: 64,
        functions: 70,
        lines: 74,
      },
    },
    setupFiles: ["tests/setup.ts"],
    pool: "threads",
    singleThread: true,
    // Full layered coverage instruments every source file and also boots the
    // Nest app/browser fixtures. Keep the timeout above ordinary test budgets
    // so coverage pressure is reported as a real assertion failure instead of
    // aborting later SSE/E2E hooks and contaminating unrelated suites.
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
