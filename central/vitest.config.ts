import { defineConfig } from 'vitest/config';

// Central has its own config so it doesn't inherit the app's globs (which point
// at src/ and tests/). Contract tests live in test/ and skip without a DB.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
});
