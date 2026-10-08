import {useState} from 'react';
import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import {PERMISSIONS as P} from '@mip/shared';
import {api} from '../lib/api';
import {useAuth} from '../lib/auth';
import {fmtDateTime} from '../lib/format';
interface Team {id:string;name:string;is_active:boolean;program_ids:string[];members:Array<{id:string;userId:string;name:string;kind:string;joinedAt:string;leftAt:string|null}>}
export default function Teams() {
  const {can}=useAuth();const write=can(P.USERS_WRITE);const qc=useQueryClient();const [name,setName]=useState('');
  const teams=useQuery({queryKey:['teams'],queryFn:()=>api.get<{items:Team[]}>('/teams')});
  const {data:users}=useQuery({queryKey:['team-users'],queryFn:()=>api.get<{items:Array<{id:string;full_name:string;role_key:string;is_active:boolean}>}>('/admin/users'),enabled:write});
  const {data:programs}=useQuery({queryKey:['programs'],queryFn:()=>api.get<{items:Array<{id:string;name_ar:string}>}>('/programs'),enabled:can(P.PROGRAMS_READ)});
  const create=useMutation({mutationFn:()=>api.post('/teams',{name}),onSuccess:()=>{setName('');qc.invalidateQueries({queryKey:['teams']});}});
  return <div className="space-y-5"><div className="page-heading"><div><h1>فرق الرصد</h1><p>عضويات محفوظة التاريخ وبرامج ذات وجهة استقبال واحدة.</p></div></div>
    {write&&<form className="card p-4 flex gap-3" onSubmit={e=>{e.preventDefault();create.mutate();}}><input aria-label="اسم الفريق الجديد" className="input flex-1" placeholder="اسم الفريق الجديد" value={name} maxLength={120} onChange={e=>setName(e.target.value)} required/><button className="btn-primary" disabled={create.isPending}>إنشاء فريق</button></form>}
    {(teams.error||create.error)&&<p role="alert" className="text-red-600">{(teams.error??create.error)?.message}</p>}
    {teams.data?.items.map(t=><TeamCard key={t.id} team={t} write={write} users={users?.items??[]} programs={programs?.items??[]}/>)}
    {can(P.SETTINGS_WRITE)&&<IntakeSettings/>}
  </div>;
}
function TeamCard({team,write,users,programs}:{team:Team;write:boolean;users:Array<{id:string;full_name:string;role_key:string;is_active:boolean}>;programs:Array<{id:string;name_ar:string}>}) {
  const qc=useQueryClient();const [user,setUser]=useState(''),[move,setMove]=useState(false),[name,setName]=useState(team.name);
  const [selected,setSelected]=useState(team.program_ids);
  const change=useMutation({mutationFn:({path,body,method='post'}:{path:string;body:object;method?:'post'|'put'|'patch'})=>api[method](`/teams/${team.id}${path}`,body),
    onSuccess:()=>{qc.invalidateQueries({queryKey:['teams']});qc.invalidateQueries({queryKey:['queue-options']});setUser('');}});
  return <section className="card p-5 space-y-4"><div className="flex justify-between gap-3"><h2 className="font-bold text-lg">{team.name}</h2><span className="badge">{team.is_active?'نشط':'معطل'}</span></div>
    {change.error&&<p role="alert" className="text-red-600">{change.error.message}</p>}
    {write&&<div className="flex flex-wrap gap-2"><input aria-label={`اسم ${team.name}`} className="input" value={name} onChange={e=>setName(e.target.value)} maxLength={120}/><button className="btn-ghost" disabled={change.isPending||!name.trim()} onClick={()=>change.mutate({path:'',body:{name},method:'patch'})}>حفظ الاسم</button><button className="btn-ghost" disabled={change.isPending} onClick={()=>change.mutate({path:'',body:{isActive:!team.is_active},method:'patch'})}>{team.is_active?'تعطيل الفريق':'تفعيل الفريق'}</button></div>}
    <h3 className="font-bold text-sm">البرامج</h3><div className="flex flex-wrap gap-3">{programs.map(p=><label key={p.id} className="flex gap-2 text-sm"><input type="checkbox" disabled={!write} checked={selected.includes(p.id)} onChange={e=>setSelected(old=>e.target.checked?[...old,p.id]:old.filter(id=>id!==p.id))}/>{p.name_ar}</label>)}</div>
    {write&&<button className="btn-ghost" disabled={change.isPending} onClick={()=>change.mutate({path:'/programs',body:{programIds:selected},method:'put'})}>حفظ ربط البرامج</button>}
    <h3 className="font-bold text-sm">الأعضاء وسجل العضويات</h3><div className="overflow-auto"><table className="w-full text-sm"><thead><tr><th className="text-start p-2">العضو</th><th className="text-start p-2">الصفة</th><th className="text-start p-2">انضم</th><th className="text-start p-2">غادر</th><th/></tr></thead><tbody>{team.members.map(m=><tr key={m.id} className={m.leftAt?'opacity-55':''}><td className="p-2">{m.name}</td><td className="p-2">{m.kind==='agent'?'موظف رصد':'مشرف'}</td><td className="p-2">{fmtDateTime(m.joinedAt)}</td><td className="p-2">{m.leftAt?fmtDateTime(m.leftAt):'نشط'}</td><td>{write&&!m.leftAt&&<button className="btn-ghost !text-xs" disabled={change.isPending} onClick={()=>change.mutate({path:'/members/remove',body:{userId:m.userId}})}>إنهاء العضوية</button>}</td></tr>)}</tbody></table></div>
    {write&&team.is_active&&<div className="flex flex-wrap gap-2 items-center"><select aria-label={`عضو جديد في ${team.name}`} className="input" value={user} onChange={e=>setUser(e.target.value)}><option value="">اختر موظفاً أو مشرفاً</option>{users.filter(u=>u.is_active&&['agent','supervisor'].includes(u.role_key)).map(u=><option key={u.id} value={u.id}>{u.full_name}</option>)}</select><label className="text-sm flex gap-2"><input type="checkbox" checked={move} onChange={e=>setMove(e.target.checked)}/>نقل الموظف من فريقه الحالي</label><button className="btn-primary" disabled={!user||change.isPending} onClick={()=>change.mutate({path:'/members',body:{userId:user,move}})}>إضافة العضوية</button></div>}
  </section>;
}
function IntakeSettings() {
  const qc=useQueryClient();const [starts,setStarts]=useState('');
  const settings=useQuery({queryKey:['queue-intake-settings'],queryFn:()=>api.get<{enabled:boolean;startsAt:string|null}>('/queue/intake-settings')});
  const save=useMutation({mutationFn:(enabled:boolean)=>api.put('/queue/intake-settings',{enabled,startsAt:starts||settings.data?.startsAt||null}),onSuccess:()=>qc.invalidateQueries({queryKey:['queue-intake-settings']})});
  return <section className="card p-5 space-y-3"><h2 className="font-bold">استقبال التفاعلات الجديدة</h2><p className="text-sm muted">ابدأ بعد تجهيز الفرق والبرامج. لا تُستقبل بيانات جُمعت قبل بداية الإطلاق.</p><p>الحالة: <strong>{settings.data?.enabled?'مفعّل':'معطل'}</strong> · البداية: {settings.data?.startsAt?fmtDateTime(settings.data.startsAt):'غير محددة'}</p>
    <label className="block text-sm" htmlFor="queue-start">بداية الإطلاق بتوقيت الرياض</label><input id="queue-start" type="datetime-local" className="input" onChange={e=>setStarts(e.target.value?new Date(e.target.value+':00+03:00').toISOString():'')}/>
    <div className="flex gap-2"><button className="btn-primary" disabled={save.isPending||(!starts&&!settings.data?.startsAt)} onClick={()=>save.mutate(true)}>تفعيل الاستقبال من البداية المحددة</button><button className="btn-ghost" disabled={save.isPending||!settings.data?.enabled} onClick={()=>save.mutate(false)}>تعطيل الاستقبال</button></div>
    {(save.error||settings.error)&&<p role="alert" className="text-red-600">{(save.error??settings.error)?.message}</p>}
  </section>;
}
