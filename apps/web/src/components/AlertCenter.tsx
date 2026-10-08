import {useEffect,useRef,useState} from 'react';
import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import {useNavigate} from 'react-router-dom';
import {Bell,BellRing,CheckCheck,Sparkles,UserRound,Volume2,VolumeX,X} from 'lucide-react';
import {PERMISSIONS as P} from '@mip/shared';
import {api} from '../lib/api';
import {useAuth} from '../lib/auth';
import {fmtRelative} from '../lib/format';
import {ALERT_KIND_LABELS,type AlertPrefs,type AlertUnread,type QueueAlert} from '../lib/queue';
import {audioState,chime,onAudioState,unlockAudio,type AudioState} from '../lib/alertSound';

export const ALERTS_UNREAD_KEY=['queue-alerts','unread'];
const DEFAULT_PREFS:AlertPrefs={soundEnabled:true,toastsEnabled:true,volume:0.6};
const openUrl=(a:QueueAlert)=>`/queue?section=${a.section}&item=${a.item_id}`;

/**
 * Influencer/story alerts for users with queue access: a bell with the saved
 * alerts, short-lived toasts and a chime for genuinely new ones.
 *
 * New = claimed from the server (POST /queue/alerts/claim), which hands each
 * alert to a user once — never again on the next poll, a reload or in another
 * tab. The first claim of a page is silent, so signing in or reloading never
 * replays old sounds. Sound and toasts are separate from the saved alert:
 * muting, a blocked autoplay or a failed chime never hides it from the bell.
 */
export default function AlertCenter() {
  const {can}=useAuth();const qc=useQueryClient();const navigate=useNavigate();
  const supervise=can(P.QUEUE_SUPERVISE,P.QUEUE_VIEW_ALL);
  const [open,setOpen]=useState(false);
  const [toasts,setToasts]=useState<QueueAlert[]>([]);
  const [audio,setAudio]=useState<AudioState>(()=>audioState());
  // How many chimes actually played on this page (exposed on the bell for QA).
  const [chimes,setChimes]=useState(0);
  const panel=useRef<HTMLDivElement>(null);

  const {data:prefs=DEFAULT_PREFS}=useQuery({queryKey:['queue-alert-prefs'],queryFn:()=>api.get<AlertPrefs>('/queue/alerts/prefs')});
  const prefsRef=useRef(prefs);prefsRef.current=prefs;
  const savePrefs=useMutation({mutationFn:(next:AlertPrefs)=>api.put<AlertPrefs>('/queue/alerts/prefs',next),
    onMutate:next=>qc.setQueryData(['queue-alert-prefs'],next),onSuccess:data=>qc.setQueryData(['queue-alert-prefs'],data)});
  const {data:unread}=useQuery<AlertUnread>({queryKey:ALERTS_UNREAD_KEY,queryFn:()=>api.get<AlertUnread&{items:QueueAlert[]}>('/queue/alerts'),staleTime:Infinity});
  const list=useQuery({queryKey:['queue-alerts','list'],queryFn:()=>api.get<AlertUnread&{items:QueueAlert[]}>('/queue/alerts'),enabled:open});

  // Lift the autoplay block on the first interaction anywhere in the app.
  useEffect(()=>{
    const off=onAudioState(setAudio);
    const unlock=()=>{void unlockAudio();};
    window.addEventListener('pointerdown',unlock,{once:true});window.addEventListener('keydown',unlock,{once:true});
    return()=>{off();window.removeEventListener('pointerdown',unlock);window.removeEventListener('keydown',unlock);};
  },[]);

  // One claim loop for the whole app; paused while the tab is hidden.
  useEffect(()=>{
    let stopped=false,busy=false,initial=true;
    const tick=async()=>{
      if(busy||stopped||document.hidden)return;busy=true;
      try {
        const res=await api.post<AlertUnread&{fresh:QueueAlert[]}>('/queue/alerts/claim',{initial});
        initial=false;
        if(stopped)return;
        qc.setQueryData(ALERTS_UNREAD_KEY,{unread:res.unread,unreadBySection:res.unreadBySection});
        if(res.fresh.length){
          qc.invalidateQueries({queryKey:['queue-alerts','list']});qc.invalidateQueries({queryKey:['queue']});
          const p=prefsRef.current;
          if(p.toastsEnabled)setToasts(old=>[...res.fresh.slice().reverse(),...old].slice(0,3));
          // One chime per batch, rate-limited; failure never affects the alert itself.
          if(p.soundEnabled&&chime(p.volume))setChimes(n=>n+1);
        }
      } catch {/* offline: the alert stays on the server and shows up later, silently if stale */}
      finally {busy=false;}
    };
    void tick();
    const timer=setInterval(()=>void tick(),supervise?20000:15000);
    const onVisible=()=>{if(!document.hidden)void tick();};
    document.addEventListener('visibilitychange',onVisible);
    return()=>{stopped=true;clearInterval(timer);document.removeEventListener('visibilitychange',onVisible);};
  },[qc,supervise]);

  useEffect(()=>{if(!toasts.length)return;const t=setTimeout(()=>setToasts(old=>old.slice(0,-1)),8000);return()=>clearTimeout(t);},[toasts]);
  useEffect(()=>{
    if(!open)return;
    const onKey=(e:KeyboardEvent)=>{if(e.key==='Escape')setOpen(false);};
    const onDown=(e:MouseEvent)=>{if(panel.current&&!panel.current.contains(e.target as Node))setOpen(false);};
    document.addEventListener('keydown',onKey);document.addEventListener('mousedown',onDown);
    return()=>{document.removeEventListener('keydown',onKey);document.removeEventListener('mousedown',onDown);};
  },[open]);

  const afterRead=(res:AlertUnread)=>{qc.setQueryData(ALERTS_UNREAD_KEY,res);qc.invalidateQueries({queryKey:['queue-alerts','list']});};
  const markRead=useMutation({mutationFn:(id:string)=>api.post<AlertUnread>(`/queue/alerts/${id}/read`,{}),onSuccess:afterRead});
  const markAll=useMutation({mutationFn:()=>api.post<AlertUnread>('/queue/alerts/read-all',{}),onSuccess:afterRead});
  const go=(a:QueueAlert)=>{if(!a.read_at)markRead.mutate(a.id);setOpen(false);setToasts(old=>old.filter(t=>t.id!==a.id));navigate(openUrl(a));};

  const count=unread?.unread??0;
  const soundOn=prefs.soundEnabled;
  return <div className="relative" ref={panel}>
    <button className="icon-button relative" aria-label={count?`التنبيهات — ${count} غير مقروء`:'التنبيهات'} aria-expanded={open} data-chimes={chimes} onClick={()=>setOpen(o=>!o)}>
      {count?<BellRing size={18}/>:<Bell size={18}/>}
      {count>0&&<span className="alert-count" aria-hidden="true">{count>99?'99+':count}</span>}
    </button>
    <span className={`alert-sound-dot ${soundOn&&audio==='running'?'is-on':''}`} title={!soundOn?'الصوت مكتوم':audio==='running'?'الصوت مفعّل':'الصوت بانتظار التفعيل'} aria-hidden="true"/>

    {open&&<div className="alert-panel card" role="dialog" aria-label="مركز التنبيهات">
      <header className="flex items-center justify-between gap-2 px-4 pt-3 pb-2">
        <strong>التنبيهات</strong>
        <button className="btn-ghost !py-1 !px-2 !text-xs" disabled={!count||markAll.isPending} onClick={()=>markAll.mutate()}><CheckCheck size={14}/>تعليم الكل كمقروء</button>
      </header>
      <div className="alert-sound-row">
        <button className="icon-button" aria-pressed={soundOn} aria-label={soundOn?'كتم صوت التنبيهات':'تشغيل صوت التنبيهات'}
          onClick={()=>savePrefs.mutate({...prefs,soundEnabled:!soundOn})}>{soundOn?<Volume2 size={17}/>:<VolumeX size={17}/>}</button>
        <input type="range" min={0} max={1} step={0.1} aria-label="مستوى صوت التنبيه" value={prefs.volume} disabled={!soundOn}
          onChange={e=>qc.setQueryData(['queue-alert-prefs'],{...prefs,volume:Number(e.target.value)})}
          onPointerUp={e=>savePrefs.mutate({...prefs,volume:Number((e.target as HTMLInputElement).value)})}
          onKeyUp={e=>savePrefs.mutate({...prefs,volume:Number((e.target as HTMLInputElement).value)})}/>
        {audio==='running'
          ?<button className="btn-ghost !py-1 !px-2 !text-xs" disabled={!soundOn} onClick={()=>chime(prefs.volume,true)}>تجربة الصوت</button>
          :<button className="btn-primary !py-1 !px-2 !text-xs" onClick={async()=>{if(await unlockAudio()&&soundOn)chime(prefs.volume,true);}}>تفعيل التنبيهات الصوتية</button>}
      </div>
      <label className="flex items-center gap-2 px-4 pb-2 text-xs muted">
        <input type="checkbox" checked={prefs.toastsEnabled} onChange={e=>savePrefs.mutate({...prefs,toastsEnabled:e.target.checked})}/>إظهار الإشعارات المنبثقة
      </label>
      <p className="px-4 pb-2 text-xs muted">{!soundOn?'الصوت مكتوم — تبقى التنبيهات ظاهرة هنا.':audio==='running'?'الصوت مفعّل لتنبيهات المؤثرين والقصص فقط.':audio==='unsupported'?'المتصفح لا يدعم الصوت — التنبيهات المرئية تعمل.':'المتصفح يمنع الصوت حتى تفعّله.'}</p>
      <ul className="alert-list">
        {list.isLoading&&<li className="p-4 text-sm muted">جارٍ التحميل…</li>}
        {list.data&&!list.data.items.length&&<li className="p-6 text-center text-sm muted">لا توجد تنبيهات. تصل هنا تنبيهات المؤثرين والقصص ضمن نطاقك.</li>}
        {list.data?.items.map(a=><li key={a.id}>
          <button className={`alert-row ${a.read_at?'':'is-unread'}`} onClick={()=>go(a)}>
            <AlertIcon kind={a.kind}/>
            <span className="min-w-0 flex-1 text-start">
              <span className="flex items-center gap-2 text-xs"><strong>{ALERT_KIND_LABELS[a.kind]}</strong><span className="muted">{a.program_name}</span><span className="muted ms-auto">{fmtRelative(a.created_at)}</span></span>
              <span className="block text-sm line-clamp-2 mt-0.5">{a.author_name?<b className="font-semibold">{a.author_name}: </b>:null}{a.title??'عنصر محفوظ المرجع'}</span>
            </span>
            {!a.read_at&&<span className="alert-unread-dot" aria-label="غير مقروء"/>}
          </button>
        </li>)}
      </ul>
    </div>}

    {toasts.length>0&&<div className="alert-toasts" role="status" aria-live="polite">
      {toasts.map(t=><div key={t.id} className="alert-toast card">
        <button className="flex items-start gap-3 text-start flex-1 min-w-0" onClick={()=>go(t)}>
          <AlertIcon kind={t.kind}/>
          <span className="min-w-0"><strong className="text-sm block">{t.kind==='story'?'قصة جديدة للرصد':t.kind==='influencer'?'تفاعل مؤثر جديد':'أُسند إليك عنصر'}</strong>
            <span className="text-xs muted block">{t.program_name}</span>
            <span className="text-sm line-clamp-2">{t.author_name?`${t.author_name}: `:''}{t.title}</span></span>
        </button>
        <button className="icon-button !w-7 !h-7" aria-label="إغلاق الإشعار" onClick={()=>setToasts(old=>old.filter(x=>x.id!==t.id))}><X size={14}/></button>
      </div>)}
    </div>}
  </div>;
}

function AlertIcon({kind}:{kind:QueueAlert['kind']}) {
  const Icon=kind==='story'?Sparkles:kind==='influencer'?UserRound:BellRing;
  return <span className={`alert-kind alert-kind--${kind}`} aria-hidden="true"><Icon size={15}/></span>;
}
