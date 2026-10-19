import {useBrowsingParams} from '../lib/useBrowsingParams';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {useLocation} from 'react-router-dom';
import { PERMISSIONS as P } from '@mip/shared';
import { useAuth } from '../lib/auth';

import { Button } from './ui/Button';
export function hasQueueDraft(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Record<string, unknown>;
  const review = draft.review as { outcome?: string; reason?: string; changes?: object } | undefined;
  return Object.entries(draft).some(([key, value]) => key !== 'transferOpen' && typeof value === 'string' && !!value.trim()) || !!review && (!!review.outcome || !!review.reason?.trim() || !!Object.keys(review.changes ?? {}).length);
}

/** Drafts stay in this tab's memory, scoped by user; auth logout clears the QueryClient. */
export default function QueueDraftNotice() {
  const qc=useQueryClient();const {user,can}=useAuth();const [params,setParams]=useBrowsingParams();const location=useLocation();
  const snapshot=useCallback(()=>qc.getQueryCache().getAll().filter(query=>query.queryKey[0]==='queue-draft'&&query.queryKey[1]===user?.id&&hasQueueDraft(query.state.data)).map(query=>String(query.queryKey[2])).sort().join('|'),[qc,user?.id]);
  const subscribe=useCallback((notify:()=>void)=>qc.getQueryCache().subscribe(notify),[qc]);
  const ids=useSyncExternalStore(subscribe,snapshot,()=> '');
  useEffect(()=>{if(!ids)return;const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[ids]);
  if(!ids||!can(P.QUEUE_WORK,P.QUEUE_SUPERVISE,P.QUEUE_VIEW_ALL))return null;
  const pending=ids.split('|').filter(id=>id!==params.get('item'));
  if(!pending.length)return null;
  return <aside className="card p-3 text-sm" aria-label="مسودات الطابور غير المحفوظة"><p>لديك {pending.length} مسودة غير محفوظة في هذه الجلسة. لا تُرسل للخادم قبل تنفيذ الحفظ.</p>{pending.map(id=><Button variant="ghost" type="submit" key={id} onClick={()=>setParams(old=>{const next=new URLSearchParams(old);next.set('item',id);return next;},{state:location.state})}>استكمال مسودة #{id.slice(0,8)}</Button>)}</aside>;
}
