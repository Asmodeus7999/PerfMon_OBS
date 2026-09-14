import { defineConfig } from 'vite';

// https://vitejs.dev/config/
export default defineConfig({
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  // prevent vite from obscuring rust errors
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Tell Vite to ignore watching src-tauri (Rust code) — Tauri handles that separately
      ignored: ['**/src-tauri/**'],
    },
  },
  // Env prefix for Tauri: exposes TAURI_ENV_* to frontend
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    // Tauri uses Chromium on Windows (via WebView2 = Edge), so we can target modern Chrome
    target: 'chrome105',
    // Don't minify for debug builds, so Rust can report actual file paths
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
