import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';
import path from 'node:path';

// Build-time VAT flag. `COUNTER_VAT=1` produces the VAT binary; unset/anything
// else produces the no-VAT binary. Replaces the `__COUNTER_VAT__` token so dead
// VAT branches tree-shake out of the no-VAT build. See src/shared/lib/vat.ts.
//
// IMPORTANT: vite-plugin-electron builds main and preload as SEPARATE nested Vite
// configs that do NOT inherit the root `define`. The main process is where a sale
// is written, so the define MUST be applied to all three sub-builds explicitly —
// otherwise the packaged VAT build would leave `__COUNTER_VAT__` undefined in main
// and silently fall back to VAT-off at runtime.
const vatDefine = {
  __COUNTER_VAT__: JSON.stringify(process.env.COUNTER_VAT === '1'),
};

// Vite + Electron + React. Single config drives main, preload, and renderer.
// Renderer is the default Vite app; main and preload bundle to dist-electron/.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@main': path.resolve(__dirname, 'src/main'),
      '@renderer': path.resolve(__dirname, 'src/renderer'),
    },
  },
  plugins: [
    react(),
    electron({
      main: {
        entry: 'src/main/index.ts',
        vite: {
          define: vatDefine,
          build: {
            outDir: 'dist-electron/main',
            rollupOptions: {
              external: ['better-sqlite3', 'bcryptjs', 'node-thermal-printer', 'electron-log'],
            },
          },
        },
      },
      preload: {
        input: 'src/main/preload.ts',
        vite: {
          define: vatDefine,
          build: {
            outDir: 'dist-electron/preload',
          },
        },
      },
      renderer: {},
    }),
  ],
  server: {
    port: 5173,
    strictPort: true,
  },
  // Applies to the renderer build.
  define: vatDefine,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
