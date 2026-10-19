import {useConfirmAction} from '../components/ConfirmAction';
import {useState} from 'react';
import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import {PERMISSIONS as P} from '@mip/shared';
import {api} from '../lib/api';
import {useAuth} from '../lib/auth';
import {fmtDateTime} from '../lib/format';
import { Button } from '../components/ui/Button';
interface Team {id:string;name:string;is_active:boolean;program_ids:string[];members:Array<{id:string;userId:string;name:string;kind:string;joinedAt:string;leftAt:string|null}>}
export default function Teams() {
  const {can}=useAuth();const write=can(P.USERS_WRITE);const qc=useQueryClient();const [name,setName]=useState('');
  const teams=useQuery({queryKey:['teams'],queryFn:()=>api.get<{items:Team[]}>('/teams')});
  const {data:users}=useQuery({queryKey:['team-users'],queryFn:()=>api.get<{items:Array<{id:string;full_name:string;role_key:string;is_active:boolean}>}>('/admin/users'),enabled:write});
  const {data:programs}=useQuery({queryKey:['programs'],queryFn:()=>api.get<{items:Array<{id:string;name_ar:string}>}>('/programs'),enabled:can(P.PROGRAMS_READ)});
  const create=useMutation({mutationFn:()=>api.post('/teams',{name}),onSuccess:()=>{setName('');qc.invalidateQueries({queryKey:['teams']});}});
  return <div className="space-y-5"><div className="page-heading"><div><h1>فرق الرصد</h1><p>عضويات محفوظة التاريخ وبرامج ذات وجهة استقبال واحدة.</p></div></div>
    {write&&<form className="card p-4 flex gap-3" onSubmit={e=>{e.preventDefault();create.mutate();}}><input aria-label="اسم الفريق الجديد" className="input flex-1" placeholder="اسم الفريق الجديد" value={name} maxLength={120} onChange={e=>setName(e.target.value)} required/><Button variant="primary" type="submit" disabled={create.isPending}>إنشاء فريق</Button></form>}
    {(teams.error||create.error)&&<p role="alert" className="text-(--status-danger)">{(teams.error??create.error)?.message}</p>}
    {teams.data?.items.map(t=><TeamCard key={t.id} team={t} write={write} users={users?.items??[]} programs={programs?.items??[]}/>)}
    {can(P.SETTINGS_WRITE)&&<IntakeSettings/>}
  </div>;
}
function TeamCard({team,write,users,programs}:{team:Team;write:boolean;users:Array<{id:string;full_name:string;role_key:string;is_active:boolean}>;programs:Array<{id:string;name_ar:string}>}) {
  const {can}=useAuth(); const confirmation=useConfirmAction();
  const qc=useQueryClient();const [user,setUser]=useState(''),[move,setMove]=useState(false),[name,setName]=useState(team.name);
  const [selected,setSelected]=useState(team.program_ids);
  const change=useMutation({mutationFn:({path,body,method='post'}:{path:string;body:object;method?:'post'|'put'|'patch'})=>api[method](`/teams/${team.id}${path}`,body),
    onSuccess:()=>{qc.invalidateQueries({queryKey:['teams']});qc.invalidateQueries({queryKey:['queue-options']});setUser('');}});
  return <section className="card p-5 space-y-4">{confirmation.dialog}<div className="flex justify-between gap-3"><h2 className="font-bold text-lg">{team.name}</h2><span className="badge">{team.is_active?'نشط':'معطل'}</span></div>
    {change.error&&<p role="alert" className="text-(--status-danger)">{change.error.message}</p>}
    {write&&<div className="flex flex-wrap gap-2"><input aria-label={`اسم ${team.name}`} className="input" value={name} onChange={e=>setName(e.target.value)} maxLength={120}/><Button variant="ghost" type="submit" disabled={change.isPending||!name.trim()} onClick={()=>change.mutate({path:'',body:{name},method:'patch'})}>حفظ الاسم</Button><Button variant="ghost" type="submit" disabled={change.isPending} onClick={()=>confirmation.request({title:team.is_active?'تعطيل الفريق':'تفعيل الفريق',description:`تغيير حالة «${team.name}» يؤثر على استقبال وإسناد التفاعلات.`,confirmLabel:team.is_active?'تعطيل الفريق':'تفعيل الفريق',danger:team.is_active,allowed:can=>can(P.USERS_WRITE),execute:()=>change.mutateAsync({path:'',body:{isActive:!team.is_active},method:'patch'})})}>{team.is_active?'تعطيل الفريق':'تفعيل الفريق'}</Button></div>}
    <h3 className="font-bold text-sm">البرامج</h3><div className="flex flex-wrap gap-3">{programs.map(p=><label key={p.id} className="flex gap-2 text-sm"><input type="checkbox" disabled={!write} checked={selected.includes(p.id)} onChange={e=>setSelected(old=>e.target.checked?[...old,p.id]:old.filter(id=>id!==p.id))}/>{p.name_ar}</label>)}</div>
    {write&&<Button variant="ghost" type="submit" disabled={change.isPending} onClick={()=>confirmation.request({title:'تغيير ربط البرامج',description:`سيتم ربط ${selected.length} برنامج بفريق «${team.name}». يؤثر ذلك على وجهة استقبال التفاعلات.`,confirmLabel:'حفظ الربط',allowed:can=>can(P.USERS_WRITE),execute:()=>change.mutateAsync({path:'/programs',body:{programIds:selected},method:'put'})})}>حفظ ربط البرامج</Button>}
    <h3 className="font-bold text-sm">الأعضاء وسجل العضويات</h3><div className="overflow-auto"><table className="w-full text-sm"><thead><tr><th className="text-start p-2">العضو</th><th className="text-start p-2">الصفة</th><th className="text-start p-2">انضم</th><th className="text-start p-2">غادر</th><th/></tr></thead><tbody>{team.members.map(m=><tr key={m.id} className={m.leftAt?'opacity-55':''}><td className="p-2">{m.name}</td><td className="p-2">{m.kind==='agent'?'موظف رصد':'مشرف'}</td><td className="p-2">{fmtDateTime(m.joinedAt)}</td><td className="p-2">{m.leftAt?fmtDateTime(m.leftAt):'نشط'}</td><td>{write&&!m.leftAt&&<Button variant="ghost" type="submit" className="!text-xs" disabled={change.isPending} onClick={()=>confirmation.request({title:'إنهاء العضوية',description:`إنهاء عضوية «${m.name}» في «${team.name}» يؤثر على الإسناد. سيبقى سجل العضوية محفوظًا.`,confirmLabel:'إنهاء العضوية',danger:true,allowed:can=>can(P.USERS_WRITE),execute:()=>change.mutateAsync({path:'/members/remove',body:{userId:m.userId}})})}>إنهاء العضوية</Button>}</td></tr>)}</tbody></table></div>
    {write&&team.is_active&&<div className="flex flex-wrap gap-2 items-center"><select aria-label={`عضو جديد في ${team.name}`} className="input" value={user} onChange={e=>setUser(e.target.value)}><option value="">اختر موظفاً أو مشرفاً</option>{users.filter(u=>u.is_active&&['agent','supervisor'].includes(u.role_key)).map(u=><option key={u.id} value={u.id}>{u.full_name}</option>)}</select><label className="text-sm flex gap-2"><input type="checkbox" checked={move} onChange={e=>setMove(e.target.checked)}/>نقل الموظف من فريقه الحالي</label><Button variant="primary" type="submit" disabled={!user||change.isPending} onClick={()=>confirmation.request({title:move?'نقل عضوية الموظف':'إضافة عضوية',description:`${users.find(u=>u.id===user)?.full_name??user} إلى «${team.name}». ${move?'ستنتهي عضويته الحالية وفق قواعد الخادم.':'ستطبق قواعد العضوية الحالية.'}`,confirmLabel:move?'نقل العضوية':'إضافة العضوية',danger:move,allowed:can=>can(P.USERS_WRITE),execute:()=>change.mutateAsync({path:'/members',body:{userId:user,move}})})}>إضافة العضوية</Button></div>}
  </section>;
}
function IntakeSettings() {
  const {can}=useAuth();const confirmation=useConfirmAction();
  const qc=useQueryClient();const [starts,setStarts]=useState('');
  const settings=useQuery({queryKey:['queue-intake-settings'],queryFn:()=>api.get<{enabled:boolean;startsAt:string|null}>('/queue/intake-settings')});
  const save=useMutation({mutationFn:(enabled:boolean)=>api.put('/queue/intake-settings',{enabled,startsAt:starts||settings.data?.startsAt||null}),onSuccess:()=>qc.invalidateQueries({queryKey:['queue-intake-settings']})});
  return <section className="card p-5 space-y-3">{confirmation.dialog}<h2 className="font-bold">استقبال التفاعلات الجديدة</h2><p className="text-sm muted">ابدأ بعد تجهيز الفرق والبرامج. لا تُستقبل بيانات جُمعت قبل بداية الإطلاق.</p><p>الحالة: <strong>{settings.data?.enabled?'مفعّل':'معطل'}</strong> · البداية: {settings.data?.startsAt?fmtDateTime(settings.data.startsAt):'غير محددة'}</p>
    <label className="block text-sm" htmlFor="queue-start">بداية الإطلاق بتوقيت الرياض</label><input id="queue-start" type="datetime-local" className="input" onChange={e=>setStarts(e.target.value?new Date(e.target.value+':00+03:00').toISOString():'')}/>
    <div className="flex gap-2"><Button variant="primary" type="submit" disabled={save.isPending||(!starts&&!settings.data?.startsAt)} onClick={()=>confirmation.request({title:'تفعيل استقبال التفاعلات',description:`سيبدأ الاستقبال من ${fmtDateTime(starts||settings.data?.startsAt||'')}. يؤثر ذلك على تشغيل Queue.`,confirmLabel:'تفعيل الاستقبال',allowed:can=>can(P.SETTINGS_WRITE),execute:()=>save.mutateAsync(true)})}>تفعيل الاستقبال من البداية المحددة</Button><Button variant="ghost" type="submit" disabled={save.isPending||!settings.data?.enabled} onClick={()=>confirmation.request({title:'تعطيل استقبال التفاعلات',description:'سيتوقف استقبال التفاعلات الجديدة في الطابور وفق الإعداد الحالي.',confirmLabel:'تعطيل الاستقبال',danger:true,allowed:can=>can(P.SETTINGS_WRITE),execute:()=>save.mutateAsync(false)})}>تعطيل الاستقبال</Button></div>
    {(save.error||settings.error)&&<p role="alert" className="text-(--status-danger)">{(save.error??settings.error)?.message}</p>}
  </section>;
}
