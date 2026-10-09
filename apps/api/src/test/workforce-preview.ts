/**
 * Optional local-only synthetic fixtures for browser checks of the workforce
 * screens. Never runs from production startup. Use a dedicated database:
 *   TEST_DATABASE_URL=postgresql://…@localhost:5433/mip_wfpreview_test pnpm test:db
 *   TEST_DATABASE_URL=… npx tsx src/test/workforce-preview.ts
 *   TEST_DATABASE_URL=… npx tsx src/test/queue-preview-server.ts
 * It turns automatic assignment on in that database only.
 */
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {call,createUser,login,makeApp,sql,PASSWORD} from './harness.js';

if(!new URL(process.env.DATABASE_URL!).pathname.endsWith('_test'))throw new Error('Preview requires a local *_test database');
const app=await makeApp();
try {
  const accounts:Record<string,{id:string;email:string;password:string;name:string}>={};
  const tokens:Record<string,string>={};
  const people:Array<[string,string,string]>=[['admin','admin','مدير التجربة'],['supervisor','supervisor','نورة المشرفة'],
    ['agent','agent','سارة القحطاني'],['khalid','agent','خالد العتيبي'],['muna','agent','منى الشهري'],['fahad','agent','فهد الدوسري']];
  for(const [key,role,name] of people){
    const u=await createUser(role);await sql`UPDATE users SET full_name=${name} WHERE id=${u.id}::uuid`;
    accounts[key]={id:u.id,email:u.email,password:PASSWORD,name};tokens[key]=(await login(app,u.email)).accessToken;
  }
  const run=async(method:string,path:string,body?:unknown,token=tokens.admin)=>{
    const r=await call(app,token,method,path,body);if(r.statusCode>=400)throw new Error(`${method} ${path} → ${r.statusCode} ${r.body}`);return r.json();
  };
  const team=(await run('POST','/api/v1/teams',{name:'فريق خدمة المستفيدين — تجربة محلية'})).id;
  const programs:string[]=[];
  for(const [name,color] of [['إيجار — تجربة','#14b8a6'],['ملاك — تجربة','#6366f1']]){
    const [p]=await sql`INSERT INTO programs(key,name_ar,name_en,color) VALUES (${crypto.randomUUID()},${name},'Workforce preview',${color}) RETURNING id`;programs.push(p.id);
  }
  await run('PUT',`/api/v1/teams/${team}/programs`,{programIds:programs});
  for(const key of ['supervisor','agent','khalid','muna','fahad'])await run('POST',`/api/v1/teams/${team}/members`,{userId:accounts[key].id});
  await run('PUT',`/api/v1/workforce/settings/teams/${team}`,{maxOpen:4});
  await run('PUT',`/api/v1/workforce/settings/agents/${accounts.fahad.id}`,{sections:['general'],acceptsHighPriority:false});

  // Yesterday and earlier today: closed periods (one across midnight Riyadh), so the time figures have history.
  const day=(offsetH:number)=>new Date(Date.now()+offsetH*3600000).toISOString();
  for(const key of ['agent','khalid','muna','fahad']){
    const u=accounts[key].id;
    const plan:Array<[string,number,number]>=[['available',-30,-27],['break',-27,-26.5],['available',-26.5,-23],['meeting',-23,-22],['offline',-22,-5],['available',-5,-3],['training',-3,-2.5],['available',-2.5,-1.5]];
    let prev='offline';
    for(const [status,from,to] of plan){
      await sql`INSERT INTO agent_status_periods(user_id,status,previous_status,started_at,ended_at,source,end_source)
        VALUES (${u},${status},${prev},${day(from)},${day(to)},'agent','agent')`;prev=status;
    }
    await sql`INSERT INTO agent_status_periods(user_id,status,previous_status,started_at,ended_at,source,end_source,end_reason)
      VALUES (${u},'offline',${prev},${day(-1.5)},${day(-0.01)},'agent','system','انقطعت الجلسة دون إشارة من المتصفح؛ انتهت الحالة عند آخر إشارة')`;
  }

  const texts=['كيف أوثق عقد الإيجار بعد موافقة المؤجر؟','لم تظهر دفعة الإيجار في الحساب رغم السداد. أرجو المساعدة.','أحتاج توضيح خطوات تجديد العقد الإلكتروني.',
    'تعذر تحديث بيانات المستأجر في العقد.','متى تصل رسالة تأكيد سداد الدفعة؟','كيف أراجع تفاصيل مبلغ الضمان؟','المنصة لا تقبل رقم الهوية عند التسجيل.',
    'هل يمكن تقسيط الدفعة السنوية؟','العقد ظهر بحالة ملغي دون طلب مني.','أين أجد شهادة سداد الإيجار؟','تأخر استرداد مبلغ التأمين منذ شهر.','كيف أضيف وسيطاً عقارياً للعقد؟'];
  const items:string[]=[];
  const add=async(i:number,section:'general'|'influencer',minutesAgo:number)=>{
    const stamp=new Date().toISOString();const id=crypto.randomUUID();const p=programs[i%2];
    await sql`INSERT INTO posts(id,x_post_id,x_author_id,text,text_normalized,posted_at,content_hash,status) VALUES
      (${id},${id},'local-workforce-preview',${texts[i%texts.length]},${texts[i%texts.length]},${stamp},'\\x00','classified')`;
    await sql`INSERT INTO post_classifications(post_id,posted_at,relevance,intent,program_id,stage) VALUES (${id},${stamp},'relevant',${i%3?'complaint':'inquiry'},${p},1)`;
    await sql`INSERT INTO post_sentiments(post_id,posted_at,label,stage) VALUES (${id},${stamp},${i%3?'negative':'neutral'},1)`;
    const item=await run('POST','/api/v1/queue/items',{postId:id,postedAt:stamp});
    await sql`UPDATE queue_items SET entered_at=clock_timestamp()-make_interval(mins=>${minutesAgo}),section=${section} WHERE id=${item.id}::uuid`;
    items.push(item.id);return item;
  };
  for(let i=0;i<12;i++)await add(i,i<3?'influencer':'general',i===11?90:5+i*3);
  for(const [k,title] of [[0,'تأخر استرداد مبالغ التأمين في عدة مدن'],[1,'تعطل تسجيل العقود الإلكترونية صباح اليوم']] as const){
    const [s]=await sql`INSERT INTO queue_items(interaction_type,story_id,story_snapshot,program_id,program_snapshot,team_id,section,entered_at)
      VALUES ('story',${crypto.randomUUID()},${JSON.stringify({title,summary:'قصة تجريبية لمعاينة الواجهة: مصادر مستقلة تتحدث عن الموضوع نفسه.',postCount:6+k*3,state:'rising'})}::jsonb,
        ${programs[k]},${JSON.stringify({id:programs[k],key:'p',name:k?'ملاك — تجربة':'إيجار — تجربة',color:k?'#6366f1':'#14b8a6'})}::jsonb,${team},'story',clock_timestamp()-interval '12 minutes') RETURNING id,version`;
    await sql`INSERT INTO queue_events(queue_item_id,event_type,to_status,version) VALUES (${s.id},'created','new',1)`;items.push(s.id);
  }
  const high=await sql`SELECT id,version FROM queue_items WHERE id=${items[6]}::uuid`;
  await run('POST',`/api/v1/queue/items/${items[6]}/priority`,{expectedVersion:high[0].version,priority:'high',reason:'عميل ذو أولوية — بيانات تجربة'},tokens.supervisor);

  const sys=await run('GET','/api/v1/workforce/system-settings');
  await run('PUT','/api/v1/workforce/system-settings',{...sys,autoAssignEnabled:true});
  await run('POST','/api/v1/workforce/status',{status:'available'},tokens.agent);
  await run('POST','/api/v1/workforce/status',{status:'available'},tokens.fahad);
  await run('POST','/api/v1/workforce/status',{status:'break'},tokens.khalid);
  await run('POST',`/api/v1/workforce/agents/${accounts.muna.id}/status`,{status:'meeting',reason:'اجتماع الفريق الأسبوعي'},tokens.supervisor);
  // Two closures today for the preview agent; the box refills automatically.
  for(let i=0;i<2;i++){
    const [it]=await sql`SELECT id,version FROM queue_items WHERE assignee_id=${accounts.agent.id}::uuid AND status='assigned' ORDER BY assigned_at LIMIT 1`;
    if(it)await run('POST',`/api/v1/queue/items/${it.id}/complete`,{expectedVersion:it.version,review:{outcome:i?'confirmed':'corrected',intent:i?undefined:'complaint',reason:i?undefined:'التفاعل شكوى'}},tokens.agent);
  }
  const file=join(tmpdir(),'mip-workforce-preview.json');
  await writeFile(file,JSON.stringify({accounts,team,programs,items},null,2));
  console.log(`Local synthetic workforce preview saved to ${file}`);
} finally {await app.close();await sql.end();}
