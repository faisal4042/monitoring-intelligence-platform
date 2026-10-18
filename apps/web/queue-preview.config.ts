import {defineConfig,mergeConfig} from 'vite';
import base from './vite.config';

/** Pairs with the guarded queue-preview-server; never proxies to the regular API. */
export default mergeConfig(base,defineConfig({server:{host:'127.0.0.1',port:5177,strictPort:true,
  proxy:{'/api':{target:'http://127.0.0.1:3107',changeOrigin:true}}}}));
