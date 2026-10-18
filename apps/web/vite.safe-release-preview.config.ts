import {defineConfig,mergeConfig} from 'vite';
import base from './vite.ux-preview.config';
/** Isolated fixtures render local fonts only; no external stylesheet request is made. No production styles change. */
export default mergeConfig(base,defineConfig({plugins:[{
  name:'safe-release-local-css',enforce:'pre',
  transform(code,id){if(id.split('?')[0].endsWith('/styles.css'))return code.replace(/^@import[^\r\n]*fonts\.googleapis\.com[^\r\n]*$/gm,'');},
}]}));
