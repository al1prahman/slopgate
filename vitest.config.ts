import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'test/e2e/**/*.test.ts'],
    // The perf gate has its own isolated config (vitest.perf.config.ts) —
    // under the full parallel suite its budget measures scheduler noise.
    exclude: ['**/node_modules/**', '**/dist/**', 'test/e2e/perf.e2e.test.ts'],
    environment: 'node',
    // Several suites spawn real git/node processes; the 5s default is too
    // tight once the machine is loaded (or under coverage instrumentation).
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text'],
      // Acceptance bar: >= 80% on core/. Enforced via `npm run test:coverage`
      // (CI), not the default `npm test`, to keep local runs fast.
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
