import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
// Frontend-only harness; deliberately no API proxy.
export default defineConfig({plugins:[react(),tailwindcss()],server:{host:'127.0.0.1',port:5186,strictPort:true}});
