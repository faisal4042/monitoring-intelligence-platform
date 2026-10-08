/** Optional local-only synthetic browser fixtures. Never runs from production startup. */
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {call,createUser,login,makeApp,sql,PASSWORD} from './harness.js';

if(new URL(process.env.DATABASE_URL!).pathname!=='/mip_test')throw new Error('Preview requires local mip_test');
const app=await makeApp();
const accounts:Record<string,{id:string;email:string;password:string}>={};
const tokens:Record<string,string>={};
try {
  for(const role of ['admin','supervisor','agent','viewer']) {
    const u=await createUser(role);accounts[role]={id:u.id,email:u.email,password:PASSWORD};tokens[role]=(await login(app,u.email)).accessToken;
  }
  const second=await createUser('agent');accounts.other={id:second.id,email:second.email,password:PASSWORD};
  const run=async(method:string,path:string,body?:unknown)=>{
    const r=await call(app,tokens.admin,method,path,body);if(r.statusCode>=400)throw new Error(r.body);return r.json();
  };
  const teams:string[]=[],programs:string[]=[],items:string[]=[];
  for(let n=0;n<2;n++) {
    const t=await run('POST','/api/v1/teams',{name:n===0?'فريق خدمة المستفيدين — تجربة محلية':'فريق البرامج الأخرى — تجربة محلية'});teams.push(t.id);
    const [p]=await sql`INSERT INTO programs(key,name_ar,name_en,color) VALUES (${crypto.randomUUID()},${n===0?'إيجار — تجربة الطابور':'ملاك — تجربة الطابور'},'Local queue preview',${n===0?'#14b8a6':'#6366f1'}) RETURNING id`;
    programs.push(p.id);await run('PUT',`/api/v1/teams/${t.id}/programs`,{programIds:[p.id]});
    await run('POST',`/api/v1/teams/${t.id}/members`,{userId:n===0?accounts.agent.id:second.id});
    if(n===0)await run('POST',`/api/v1/teams/${t.id}/members`,{userId:accounts.supervisor.id});
    for(let i=0;i<(n===0?6:2);i++) {
      const stamp=new Date().toISOString();const id=crypto.randomUUID();
      const text=['كيف أوثق عقد الإيجار بعد موافقة المؤجر؟','لم تظهر دفعة الإيجار في الحساب رغم السداد. أرجو المساعدة.','أحتاج توضيح خطوات تجديد العقد الإلكتروني.','تعذر تحديث بيانات المستأجر في العقد.','متى تصل رسالة تأكيد سداد الدفعة؟','كيف أراجع تفاصيل مبلغ الضمان؟'][i];
      await sql`INSERT INTO posts(id,x_post_id,x_author_id,text,text_normalized,posted_at,content_hash,status) VALUES
        (${id},${id},'local-queue-preview',${text},${text},${stamp},'\\x00','classified')`;
      await sql`INSERT INTO post_classifications(post_id,posted_at,relevance,intent,program_id,stage) VALUES
        (${id},${stamp},'relevant',${i%2?'complaint':'inquiry'},${p.id},1)`;
      await sql`INSERT INTO post_sentiments(post_id,posted_at,label,stage) VALUES (${id},${stamp},${i%2?'negative':'neutral'},1)`;
      let item=await run('POST','/api/v1/queue/items',{postId:id,postedAt:stamp});items.push(item.id);
      if(i<3||n===1) {
        item=await run('POST',`/api/v1/queue/items/${item.id}/assign`,{expectedVersion:item.version,assigneeId:n===0?accounts.agent.id:second.id});
        if(i===2&&n===0)await run('POST',`/api/v1/queue/items/${item.id}/escalate`,{expectedVersion:item.version,reason:'تحتاج مراجعة من مشرف الفريق — بيانات تجربة'});
      }
    }
  }
  const file=join(tmpdir(),'mip-queue-preview.json');
  await writeFile(file,JSON.stringify({accounts,teams,programs,items},null,2));
  console.log(`Local synthetic preview accounts saved to ${file}`);
} finally {await app.close();await sql.end();}
