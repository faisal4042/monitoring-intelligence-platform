import {useCallback} from 'react';
import {useLocation,useSearchParams,type SetURLSearchParams} from 'react-router-dom';

/** Rebase rapid URL edits on the committed browser URL, even before a React transition renders. */
export function useBrowsingParams(rebase=true) {
  const [params,setRaw]=useSearchParams();const location=useLocation();
  const setParams=useCallback<SetURLSearchParams>((next,options)=>setRaw(previous=>{
    // MemoryRouter and SSR retain their own router state rather than reading an unrelated browser URL.
    const current=rebase&&typeof window!=='undefined'&&window.location.pathname===location.pathname?new URLSearchParams(window.location.search):previous;
    return typeof next==='function'?next(current):next??new URLSearchParams();
  },options),[setRaw,location.pathname,rebase]);
  return [params,setParams] as const;
}
