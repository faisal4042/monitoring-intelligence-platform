import {useState} from 'react';
import {useMutation,useQueryClient} from '@tanstack/react-query';
import {Link} from 'react-router-dom';
import {api} from '../lib/api';
import {useAuth} from '../lib/auth';
import {PERMISSIONS as P} from '@mip/shared';
export default function QueueManualAdd({postId,postedAt}:{postId:string;postedAt:string}) {
  const {can}=useAuth();const qc=useQueryClient();const [confirm,setConfirm]=useState(false);
  const add=useMutation({mutationFn:()=>api.post<{id:string}>('/queue/items',{postId,postedAt:new Date(postedAt).toISOString()}),
    onSuccess:()=>{setConfirm(false);qc.invalidateQueries({queryKey:['queue']});}});
  if(!can(P.QUEUE_SUPERVISE))return null;
  return <div className="flex gap-2 flex-wrap items-center px-3 py-2 text-xs">
    {add.data?<Link className="text-emerald-600 underline" to={`/queue?item=${add.data.id}`}>أُضيف للطابور — فتح العنصر</Link>:
    confirm?<><span>إضافة لفريق البرنامج المصنّف؟</span><button className="btn-primary !text-xs" disabled={add.isPending} onClick={()=>add.mutate()}>تأكيد الإضافة</button><button className="btn-ghost !text-xs" onClick={()=>setConfirm(false)}>رجوع</button></>:
    <button className="btn-ghost !text-xs" onClick={()=>setConfirm(true)}>إضافة إلى طابور الرصد</button>}
    {add.error&&<span role="alert" className="text-red-600">{add.error.message}</span>}
  </div>;
}
