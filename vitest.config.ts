import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    clearMocks: true,
    fileParallelism: false,
    coverage: {
      reporter: ['text', 'json-summary'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/coverage/**',
        '**/tests/**',
        '**/*.d.ts',
        'vitest.config.ts',
        'scripts/seed-mock-*.mjs',
        'scripts/seed-e2e.cjs',
      ],
      thresholds: { statements: 85, lines: 85, functions: 85 },
    },
  },
});
