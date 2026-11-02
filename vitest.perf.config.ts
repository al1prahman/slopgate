import { defineConfig } from 'vitest/config';

// Perf gate runs in isolation: under the full parallel suite the machine is
// saturated and the 100ms budget measures scheduler noise, not the scan.
export default defineConfig({
  test: {
    include: ['test/e2e/perf.e2e.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
