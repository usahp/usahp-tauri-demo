import { defineConfig } from 'vite';

// Tauri dev convention: fixed port 1420 so the Rust shell knows where the
// vite dev server is. Don't clobber Tauri's terminal output.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
  },
});
