import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
      // Production serves /health through nginx; the dashboard's pipeline panel reads it.
      '/health': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
});
