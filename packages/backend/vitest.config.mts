import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

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
      '@': resolve(import.meta.dirname, 'src'),
      '@domain': resolve(import.meta.dirname, 'src/domain'),
      '@modules': resolve(import.meta.dirname, 'src/modules'),
      '@infra': resolve(import.meta.dirname, 'src/infrastructure'),
      '@config': resolve(import.meta.dirname, 'src/config'),
      '@shared': resolve(import.meta.dirname, '../shared/src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.spec.ts', 'tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/main.ts',
        'src/**/*.module.ts',
        'src/**/*.dto.ts',
        'src/domain/ports/**',
      ],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
    setupFiles: ['tests/setup.ts'],
    pool: 'threads',
    singleThread: true,
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
