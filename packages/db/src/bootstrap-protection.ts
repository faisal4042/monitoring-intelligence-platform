/** Generic bootstrap commands may never target an operational database. No override. */
export function assertBootstrapTestTarget(rawUrl:string,nodeEnv:string|undefined){
  const u=new URL(rawUrl);
  if(nodeEnv!=='test'||!['localhost','127.0.0.1'].includes(u.hostname)||!u.pathname.endsWith('_test')||u.search||u.hash)
    throw new Error('BOOTSTRAP_FORBIDDEN: seed/bulk migrations require a local *_test database; operational releases use separately approved tools');
}
