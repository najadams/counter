import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'tests/**/*.test.ts'],
  },
  // Node-only tests never touch CSS, but vitest auto-loads postcss.config.js
  // on startup. That file is ESM (`export default {...}`); under Node 18
  // without "type":"module" in package.json the load crashes the runner.
  // Override here so the project-level postcss config stays untouched.
  css: {
    postcss: { plugins: [] },
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@main': path.resolve(__dirname, 'src/main'),
      '@renderer': path.resolve(__dirname, 'src/renderer'),
    },
  },
});
