import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    globalSetup: ['./src/test-global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
