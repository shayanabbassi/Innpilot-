import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/**/*.e2e.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
