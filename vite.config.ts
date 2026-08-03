import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// Tauri dev convention: fixed port 1420 so the Rust shell knows where the
// vite dev server is. Don't clobber Tauri's terminal output.
export default defineConfig({
  clearScreen: false,
  resolve: {
    alias: {
      // scan-engine@0.1.3 (published) doesn't export ./scheduler. Shim it
      // locally until scan-engine re-publishes with the multi-entry build.
      'scan-engine/scheduler': fileURLToPath(new URL('./src/scheduler-shim.ts', import.meta.url)),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
  },
});
