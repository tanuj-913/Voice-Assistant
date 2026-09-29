import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    // Bind IPv4 explicitly. Vite's default resolves to [::1] only, so
    // http://127.0.0.1:5273 is refused — which is exactly the address the
    // Tauri shell points `devUrl` at, so `tauri dev` would load nothing.
    host: '127.0.0.1',
    port: 5273,
    strictPort: true,
  },
  build: {
    // Tauri targets a modern WebKit; no legacy transpilation needed.
    target: 'safari18',
    sourcemap: true,
  },
});
