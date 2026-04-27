import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    clearMocks: true,
    coverage: {
      thresholds: {
        statements: 85,
        lines: 85,
        functions: 85,
      },
    },
  },
});
