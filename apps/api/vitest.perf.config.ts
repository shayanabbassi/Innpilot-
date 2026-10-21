import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/** Performance measurement on a seeded 100-room property (P5-16); never part of the normal suites. */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['perf/**/*.perf.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 900_000,
    hookTimeout: 900_000,
  },
});
