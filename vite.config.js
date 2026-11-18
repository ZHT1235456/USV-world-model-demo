import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  optimizeDeps: { include: ['three', 'onnxruntime-web/wasm', '@tauri-apps/api/core', '@tauri-apps/api/window'] },
  server: { host: '127.0.0.1', port: 1420, strictPort: true },
});
