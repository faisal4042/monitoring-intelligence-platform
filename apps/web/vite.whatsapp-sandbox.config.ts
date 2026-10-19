import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/** Local WhatsApp sandbox UI (apps/api/src/test/whatsapp-sandbox.ts on 3499). Never used for builds or deploys. */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1', port: 5497, strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:3499', changeOrigin: true } },
  },
});
