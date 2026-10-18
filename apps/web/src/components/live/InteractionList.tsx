import {useBrowsingParams} from '../../lib/useBrowsingParams';
import {useLocation} from 'react-router-dom';
import BulkOutcome from './BulkOutcome';
import { useRef, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PERMISSIONS as P } from '@mip/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import InteractionCard from './InteractionCard';
import InteractionDetails from './InteractionDetails';
import AuthorHistoryModal from '../AuthorHistoryModal';
import QueueDrawer from '../QueueDrawer';
import Lightbox from '../Lightbox';
import DialogSurface from '../queue-board/DialogSurface';
import { interactionLabel, type DetailSection, type Interaction, type InteractionActions } from './interaction';

type BulkResult = { preview: boolean; success: number; failed: number; results: { id: string; ok: boolean; error?: string }[]; exported?: unknown };

/** Shared interaction cards and their actions across search and influencer feeds. */
export default function InteractionList({ posts, renderText, onAccount, syncUrl=false }: { posts: Interaction[]; renderText?: (post: Interaction) => ReactNode; onAccount?: (username: string) => void; syncUrl?: boolean }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [params,setParams]=useBrowsingParams();const location=useLocation();
  const [localDetail,setLocalDetail]=useState<{id:string;section:DetailSection}|null>(null);
  const detail=syncUrl?(params.get('detail')?{id:params.get('detail')!,section:(['interaction','analysis','account','history','ticket','events'].includes(params.get('detailSection')??'')?params.get('detailSection'):'interaction') as DetailSection}:null):localDetail;
  const setDetail=(next:{id:string;section:DetailSection}|null)=>{if(!syncUrl){setLocalDetail(next);return;}setParams(old=>{const n=new URLSearchParams(old);if(next){n.set('detail',next.id);n.set('detailSection',next.section);}else{n.delete('detail');n.delete('detailSection');}return n;},{state:location.state});};
  const [history, setHistory] = useState<string | null>(null);
  const [localTicket,setLocalTicket]=useState<string|null>(null);
  const ticket=syncUrl?params.get('item'):localTicket;
  const setTicket=(id:string|null)=>{if(!syncUrl){setLocalTicket(id);return;}setParams(old=>{const n=new URLSearchParams(old);id?n.set('item',id):n.delete('item');n.delete('detail');n.delete('detailSection');return n;},{state:location.state});};
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [operation, setOperation] = useState<{ action: 'classify' | 'queue' | 'export'; id: string } | null>(null);
  const [value, setValue] = useState('relevant');
  const [reason, setReason] = useState('');
  const bulk = useMutation({
    mutationFn: (preview: boolean) => api.post<BulkResult>('/posts/bulk', { action: operation!.action, ids: [operation!.id], preview, confirmed: !preview, ...(operation!.action === 'classify' ? { value, reason: reason.trim() } : {}) }),
    onSuccess: async result => {
      if (result.preview) return;
      await Promise.all(['search', 'influencer-feed', 'influencer-overview', 'live-feed', 'live-detail', 'queue'].map(key => qc.invalidateQueries({ queryKey: [key] })));
      if (result.exported) {
        const url = URL.createObjectURL(new Blob([JSON.stringify(result.exported, null, 2)], { type: 'application/json;charset=utf-8' }));
        const link = document.createElement('a'); link.href = url; link.download = 'mip-interactions.json'; link.click(); URL.revokeObjectURL(url);
      }
    },
  });
  const running=useRef(false);const [executionUnknown,setExecutionUnknown]=useState(false);
  const actionAllowed=()=>!!operation&&can(operation.action==='queue'?P.QUEUE_SUPERVISE:operation.action==='classify'?P.FEEDBACK_WRITE:P.POSTS_EXPORT);
  const runBulk=async(preview:boolean)=>{if(running.current||executionUnknown||!actionAllowed()||(!preview&&!bulk.data?.preview))return;running.current=true;try{await bulk.mutateAsync(preview);}catch{if(!preview)setExecutionUnknown(true);}finally{running.current=false;}};
  const start = (action: 'classify' | 'queue' | 'export', post: Interaction) => { setDetail(null); bulk.reset(); setExecutionUnknown(false); setOperation({ action, id: post.id }); setValue('relevant'); setReason(''); };
  const actions: InteractionActions = {
    onDetails: (post, section = 'interaction') => setDetail({ id: post.id, section }),
    ...(can(P.CUSTOMERS_READ) ? { onHistory: (post: Interaction) => { setDetail(null); setHistory(post.x_author_id); } } : {}),
    ...(can(P.QUEUE_WORK, P.QUEUE_SUPERVISE, P.QUEUE_VIEW_ALL) ? { onTicket: (post: Interaction) => { setDetail(null); setTicket(post.queue_id); } } : {}),
    ...(can(P.FEEDBACK_WRITE) ? { onClassify: (post: Interaction) => start('classify', post) } : {}),
    ...(can(P.QUEUE_SUPERVISE) ? { onAddToQueue: (post: Interaction) => start('queue', post) } : {}),
    ...(can(P.POSTS_EXPORT) ? { onExport: (post: Interaction) => start('export', post) } : {}),
  };
  return <div className="ic-list" dir="rtl">
    {posts.map(post => <InteractionCard key={post.id} post={post} density="compact" actions={actions} onLightbox={setLightbox} textContent={renderText?.(post)} onAccount={onAccount}/>)}
    {detail && <InteractionDetails id={detail.id} initialSection={detail.section} actions={actions} onClose={() => setDetail(null)} onLightbox={setLightbox}/>}
    {history && <AuthorHistoryModal xAuthorId={history} onClose={() => setHistory(null)}/>}
    {ticket && <QueueDrawer id={ticket} onClose={() => { setTicket(null); qc.invalidateQueries({ queryKey: ['influencer-feed'] }); qc.invalidateQueries({ queryKey: ['search'] }); }}/>}
    {lightbox && <Lightbox url={lightbox} onClose={() => setLightbox(null)}/>}
    {operation && <DialogSurface busy={bulk.isPending} title={operation.action === 'classify' ? 'تعديل تصنيف التفاعل' : operation.action === 'queue' ? 'إضافة إلى طابور الرصد' : 'تصدير التفاعل'} onClose={() => { if (!running.current&&!bulk.isPending) setOperation(null); }}>
      {operation.action === 'classify' && <>
        <label className="queue-field">الصلة المصححة<select className="input" value={value} disabled={executionUnknown||bulk.isPending||!!bulk.data&&!bulk.data.preview} onChange={event => { setValue(event.target.value); bulk.reset(); }}>{['relevant', 'irrelevant', 'advertisement', 'spam', 'unknown'].map(label => <option key={label} value={label}>{interactionLabel(label)}</option>)}</select></label>
        <label className="queue-field">سبب التعديل<input className="input" value={reason} disabled={executionUnknown||bulk.isPending||!!bulk.data&&!bulk.data.preview} onChange={event => { setReason(event.target.value); bulk.reset(); }}/></label>
      </>}
      <p>النطاق: التفاعل {operation.id} فقط. راجع نتيجة المعاينة قبل التأكيد.</p>
      {bulk.error && <p role="alert">{bulk.error.message}</p>}{executionUnknown&&<p role="alert">لم تصل نتيجة مؤكدة. تحقق من حالة التفاعل قبل طلب جديد؛ إعادة التنفيذ هنا متوقفة لتجنب التكرار.</p>}
      {bulk.data&&!bulk.data.preview&&<BulkOutcome ids={[operation.id]} results={bulk.data.results} busy={bulk.isPending||!actionAllowed()} onRetry={()=>bulk.reset()}/>}
      {bulk.data && <div aria-live="polite"><p>{bulk.data.preview ? 'نتيجة المعاينة' : 'نتيجة التنفيذ'}: {bulk.data.success} ناجح · {bulk.data.failed} فشل</p>{bulk.data.results.filter(row => !row.ok).map(row => <p key={row.id}>{row.error}</p>)}</div>}
      <div className="flex gap-2 mt-3">
        {!bulk.data ? <button className="btn-primary" disabled={executionUnknown||!actionAllowed()||bulk.isPending} onClick={() => void runBulk(true)}>معاينة الإجراء</button> : bulk.data.preview && <button className="btn-primary" disabled={executionUnknown || !actionAllowed() || bulk.isPending || !bulk.data.success || (operation.action === 'classify' && !reason.trim())} onClick={() => void runBulk(false)}>تأكيد التنفيذ</button>}
        <button className="btn-ghost" disabled={bulk.isPending} onClick={() => {if(!running.current)setOperation(null);}}>إغلاق</button>
      </div>
    </DialogSurface>}
  </div>;
}
