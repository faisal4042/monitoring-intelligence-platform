import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Browser review of Tickets + Reporting Center against the synthetic fixture API (apps/api/src/test/reports-fixture-server.ts).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1', port: 5181, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:3011', changeOrigin: true } } },
});
