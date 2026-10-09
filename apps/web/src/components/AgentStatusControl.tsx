import {useEffect,useRef,useState} from 'react';
import {ChevronDown} from 'lucide-react';
import {type AgentStatus} from '@mip/shared';
import {useServerClock,duration} from '../lib/queue';
import {STATUS_ORDER,statusLabel,useHeartbeat,useMyWorkforce} from '../lib/workforce';

/**
 * The agent's availability, always in the header: current status, time in it
 * (server clock) and a menu to change it. Only "متاح" receives automatic
 * assignments; signing in does not make an agent available.
 */
export default function AgentStatusControl() {
  const me=useMyWorkforce();
  const [open,setOpen]=useState(false);
  const ref=useRef<HTMLDivElement>(null);
  const status=me.data?.status.status??'offline';
  useHeartbeat(!!me.data&&status!=='offline');
  const now=useServerClock(me.data?.serverNow,30000);
  useEffect(()=>{
    if(!open)return;
    const onDoc=(e:MouseEvent)=>{if(!ref.current?.contains(e.target as Node))setOpen(false);};
    const onKey=(e:KeyboardEvent)=>{if(e.key==='Escape')setOpen(false);};
    document.addEventListener('mousedown',onDoc);document.addEventListener('keydown',onKey);
    return()=>{document.removeEventListener('mousedown',onDoc);document.removeEventListener('keydown',onKey);};
  },[open]);
  if(!me.enabled||!me.data)return null;
  const since=me.data.status.started_at||null;
  const pick=(s:AgentStatus)=>{setOpen(false);if(s!==status)me.setStatus.mutate(s);};
  return <div className="agent-status" ref={ref}>
    <button className={`agent-status-button agent-status--${status}`} aria-haspopup="menu" aria-expanded={open}
      aria-label={`حالتي: ${statusLabel(status)}. تغيير الحالة`} onClick={()=>setOpen(o=>!o)} disabled={me.setStatus.isPending}>
      <span className="agent-status-dot" aria-hidden="true"/>
      <span className="agent-status-text">{statusLabel(status)}</span>
      {since&&<span className="agent-status-time" title="المدة في الحالة الحالية">{duration(since,now)}</span>}
      <ChevronDown size={14} aria-hidden="true"/>
    </button>
    {open&&<div className="card agent-status-menu" role="menu" aria-label="تغيير الحالة">
      {STATUS_ORDER.map(s=><button key={s} role="menuitemradio" aria-checked={s===status} className={`agent-status-option agent-status--${s}`} onClick={()=>pick(s)}>
        <span className="agent-status-dot" aria-hidden="true"/>{statusLabel(s)}
        {s==='available'&&<span className="text-xs muted ms-auto">يستقبل الإسناد</span>}
      </button>)}
      {me.setStatus.error&&<p role="alert" className="text-xs text-red-600 px-3 pb-2">{me.setStatus.error.message}</p>}
    </div>}
  </div>;
}
