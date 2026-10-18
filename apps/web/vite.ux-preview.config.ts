import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** Interaction fixtures only: no API proxy, credentials, database, workers or collection. */
export default defineConfig({
  cacheDir: 'node_modules/.vite-ux-fixtures',
  plugins: [react(), {
    name: 'ux-fixture-no-api',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.startsWith('/api/') || request.url?.startsWith('/health')) {
          response.statusCode = 403; response.end('API requests are forbidden in UX fixtures'); return;
        }
        next();
      });
    },
  }],
  server: { host: '127.0.0.1', port: 5177, strictPort: true },
});
