import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: [
      'src/**/*.test.ts', 'src/**/*.test.tsx',
      'scripts/**/*.test.ts', 'scripts/**/*.test.tsx',
      'tests/**/*.test.ts', 'tests/**/*.test.tsx',
    ],
  },
  // No PostCSS: Tailwind runs as a Vite plugin (vite.config.mts) and tests
  // never need it. An inline config stops vitest searching for a
  // postcss.config.* file, including one in a parent directory.
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
