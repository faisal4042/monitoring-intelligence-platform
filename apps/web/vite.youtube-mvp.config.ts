import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Isolated YouTube MVP page (/youtube-mvp.html) against the separate YouTube test server
// (apps/api/src/modules/youtube/server.ts on 127.0.0.1:3013). Not MIP's app on 5173; no /api proxy to MIP's backend.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1', port: 5183, strictPort: true, open: false,
    proxy: { '/yt-api': { target: 'http://127.0.0.1:3013', changeOrigin: false } } },
});
