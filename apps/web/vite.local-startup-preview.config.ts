import {defineConfig,mergeConfig} from 'vite';
import base from './vite.safe-release-preview.config';
import tailwindcss from '@tailwindcss/vite';
export default mergeConfig(base,defineConfig({plugins:[tailwindcss()],cacheDir:'.fixture-cache-local-startup',server:{host:'127.0.0.1',port:5178,strictPort:true}}));
