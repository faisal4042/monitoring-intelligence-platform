import { defineConfig, mergeConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import isolated from './vite.ux-preview.config';

/** Same API-blocked fixture server; real styles with the external font import removed. */
export default defineConfig(mergeConfig(isolated, {
  cacheDir: 'node_modules/.vite-data-fixtures',
  plugins: [{
    name: 'offline-fixture-fonts', enforce: 'pre',
    transform(source, id) {
      if(id.split('?')[0].replace(/\\/g,'/').endsWith('/src/styles.css')) return source.replace(/^@import url\('https:\/\/fonts\.googleapis\.com[^\n]+\n/m,'');
    },
  },tailwindcss()],
}));
