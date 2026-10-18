/** Immutable at process start. v1 default preserves Phase A/B; transitional entrypoint explicitly selects legacy. */
export function parseNewsReaderMode(raw:string|undefined):'legacy'|'v1' {
  if(raw===undefined||raw==='v1')return 'v1';
  if(raw==='legacy')return 'legacy';
  throw new Error('MIP_NEWS_READER must be legacy or v1');
}
export const newsReaderMode=parseNewsReaderMode(process.env.MIP_NEWS_READER);
