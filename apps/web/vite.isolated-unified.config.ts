import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({
 plugins:[react(),tailwindcss()],
 define:{'import.meta.env.VITE_ISOLATED_UNIFIED':JSON.stringify('true')},
 server:{host:'127.0.0.1',port:5292,strictPort:true,open:false,
  proxy:{'/api':{target:'http://127.0.0.1:3292',changeOrigin:true},'/health':{target:'http://127.0.0.1:3292',changeOrigin:true}}},
});
