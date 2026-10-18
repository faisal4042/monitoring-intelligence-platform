/** Explicit UI-only fixture server. No proxy, database, workers, credentials or outbound calls. */
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync, appendFileSync } from 'node:fs';
import { makeFixtureBoard, fixtureUser, teams, programs } from './src/test/queue-board-fixtures';
import { makeLiveFixtures, filterLiveFixture, livePrograms } from './src/test/live-fixtures';
const liveStates=new Map<string,ReturnType<typeof makeLiveFixtures>>();
const states=new Map<string,ReturnType<typeof makeFixtureBoard>>();
const logs=process.env.LIVE_QA_LOG;
const before=process.env.LIVE_QA_BEFORE;
const fixtures:Plugin={
  name:'live-monitoring-local-fixtures',
  enforce:'pre',
  load(id) {
    if(!before)return;
    const path=id.replaceAll('\\','/');
    if(path.endsWith('/src/components/live/LiveMonitoring.tsx'))return readFileSync(before+'/LiveMonitoring.before.tsx','utf8');
    if(path.endsWith('/src/components/live/live.css'))return readFileSync(before+'/live.before.css','utf8');
  },
  configureServer(server) {
    server.middlewares.use(async(req,res,next)=>{
      const url=new URL(req.url??'/','http://127.0.0.1');
      if(url.pathname==='/qa-media.svg'){res.setHeader('Content-Type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160" viewBox="0 0 240 160"><rect width="240" height="160" fill="#0e3554"/><rect x="30" y="28" width="180" height="104" rx="8" fill="#21b6b8"/><path d="M70 110V65h100v45M92 110V80h55v30" fill="none" stroke="white" stroke-width="6"/></svg>');return;}
      if(url.pathname==='/qa-video'){res.setHeader('Content-Type','text/plain');res.end('UI fixture media target; no external requests');return;}
      if(!url.pathname.startsWith('/api/')&&url.pathname!=='/health')return next();
      const ref=new URL(req.headers.referer??'/','http://127.0.0.1');
      const scenario=ref.searchParams.get('qaScenario')??'many', role=ref.searchParams.get('qaRole')??'admin';
      const user=fixtureUser(role),manage=user.permissions.includes('queue:supervise')||user.permissions.includes('queue:view_all');
      const canReadQueue=manage||user.permissions.includes('queue:work');
      const board=states.get(scenario)??makeFixtureBoard(scenario);states.set(scenario,board);
      let code=200,body:unknown={};
      const path=url.pathname.replace('/api/v1','');
      if(path==='/auth/refresh')body={accessToken:'ui-fixture-only'};
      else if(path==='/auth/me')body={user};
      else if(path==='/cost/overview')body={spentMonthUnits:0,monthUnitLimit:1000,usagePct:0,collectionMode:'demo',killSwitchActive:true,lastCollectionAt:null};
      else if(path==='/queue/alerts/prefs')body={soundEnabled:false,toastsEnabled:false,volume:0};
      else if(path==='/queue/alerts'||path==='/queue/alerts/claim')body={unread:0,unreadBySection:{influencer:0,story:0},items:[],fresh:[]};
      else if(path==='/queue/options')body={teams,programs,members:board.agents.map(a=>({id:a.id,full_name:a.full_name,team_id:a.team_id,kind:'agent'}))};
      else if(path==='/workforce/me')body={status:{status:'offline',started_at:board.serverNow,source:'agent'},serverNow:board.serverNow,completedToday:0,open:0,escalatedOpen:0,maxOpen:5,time:board.timeTotals,performance:board.agents[0]?.performance,range:board.range,operationalStatuses:board.operationalStatuses,days:[]};

      else if(path==='/programs')body={items:livePrograms};
      else if(path==='/posts'&&req.method==='GET'){
        if(scenario==='loading')await new Promise(resolve=>setTimeout(resolve,2500));
        if(scenario==='error'){code=503;body={error:'فشل خدمة اختبار مقصود'};}
        else{
          const all=liveStates.get(scenario)??makeLiveFixtures(scenario);liveStates.set(scenario,all);
          let rows=filterLiveFixture(all,url.searchParams);
          if(!canReadQueue||role==='agent')rows=rows.map(r=>({...r,queue_id:null,queue_status:null,assignee_name:null}));
          rows.sort((a,b)=>url.searchParams.get('sort')==='engagement'?(b.like_count??0)-(a.like_count??0):url.searchParams.get('sort')==='oldest'?a.posted_at.localeCompare(b.posted_at):b.posted_at.localeCompare(a.posted_at));
          const page=Number(url.searchParams.get('page')??1),limit=Number(url.searchParams.get('limit')??25);
          body={items:rows.slice((page-1)*limit,page*limit),total:rows.length,page,pageSize:limit,generatedAt:new Date().toISOString(),stats:{total:rows.length,unprocessed:canReadQueue?rows.filter(r=>r.queue_status!=='completed').length:null,queued:canReadQueue?rows.filter(r=>r.queue_id).length:null,excluded:rows.filter(r=>r.status==='filtered_out').length,classified:rows.filter(r=>r.relevance).length,review:rows.filter(r=>!r.relevance||r.relevance==='unknown').length,latest_collected_at:rows[0]?.collected_at??null}};
        }
      }
      else if(/^\/posts\/.+\/detail$/.test(path)){
        const all=liveStates.get(scenario)??makeLiveFixtures(scenario);const post=all.find(r=>r.id===path.split('/')[2]);
        if(scenario==='detail-error'){code=503;body={error:'تعذر تحميل التفاصيل في اختبار محلي'};}
        else body={post:post?{...post,...(!canReadQueue||role==='agent'?{queue_id:null,queue_status:null,assignee_name:null}:{})}:null,why:{query_name:'استعلام إيجار التجريبي',version:3,compiled:'إيجار lang:ar',matched_keywords:['إيجار']},feedback:[{human_value:'relevant',reason:'تصحيح محلي اصطناعي',created_at:post?.collected_at}],queueEvents:[{event_type:'assigned',reason:'إسناد اصطناعي',created_at:post?.collected_at}],events:role==='admin'?[{action:'post.classify',reason:'مراجعة اصطناعية',occurred_at:post?.collected_at}]:[],canReadAudit:role==='admin'};
      }
      else if(path==='/posts/bulk'&&req.method==='POST'){
        const chunks=[];for await(const c of req)chunks.push(c);const input=JSON.parse(Buffer.concat(chunks).toString());
        if(logs)appendFileSync(logs,JSON.stringify({simulated:true,scenario,role,path,action:input.action,preview:input.preview,confirmed:input.confirmed})+'\n');
        const perm=['queue','assign'].includes(input.action)?'queue:supervise':input.action==='classify'?'feedback:write':'posts:export';
        if(!user.permissions.includes(perm)){code=403;body={error:'غير مصرح'};}
        else{
          const all=liveStates.get(scenario)??makeLiveFixtures(scenario);liveStates.set(scenario,all);
          const results=[...new Set<string>(input.ids)].map(id=>{const p=all.find(r=>r.id===id);if(!p)return {id,ok:false,error:'التفاعل غير متاح'};
            if(input.preview){
              if(input.action==='queue'&&p.queue_id)return {id,ok:false,error:'موجود بالطابور بالفعل'};
              if(input.action==='assign'&&!p.queue_id)return {id,ok:false,error:'بلا تذكرة متاحة'};
              return {id,ok:true,label:p.username,version:1};
            }
            if(!input.confirmed)return {id,ok:false,error:'تأكيد مطلوب'};
            if(input.action==='queue'){if(p.queue_id)return {id,ok:false,error:'موجود بالطابور بالفعل'};p.queue_id='00000000-0000-4000-8000-000000099001';p.queue_status='new';return {id,ok:true,queueId:p.queue_id};}
            if(input.action==='assign'){if(!p.queue_id)return {id,ok:false,error:'بلا تذكرة متاحة'};p.assignee_name='موظف معاينة';p.queue_status='assigned';return {id,ok:true,queueId:p.queue_id};}
            if(input.action==='classify'){p.relevance=input.value;p.human_corrected=true;}return {id,ok:true};});
          body={preview:input.preview,results,success:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok).length,...(input.action==='export'&&!input.preview?{exported:all.filter(r=>input.ids.includes(r.id))}:{})};
        }
      }
      else if(/^\/posts\/authors\/.+\/history$/.test(path)){
        const all=liveStates.get(scenario)??makeLiveFixtures(scenario);const p=all.find(r=>r.x_author_id===path.split('/')[3]);
        body={author:{...p,description:'حساب معاينة',x_author_id:p?.x_author_id},stats:{interaction_count:1,complaint_count:1,inquiry_count:0,negative_count:1,engagement_total:5},items:p?[p]:[],rangeDays:7};
      }
      else if(path==='/queue/review-catalog')body={programs:livePrograms,topics:[],selfClaim:false,waitWarningMinutes:45};
      else if(path==='/queue/summary')body={serverNow:new Date().toISOString(),counts:{new:1,assigned:2,completed:0},sections:{},views:{},workload:[]};
      else if(/^\/queue\/items\/[a-f0-9-]+$/.test(path)){
        const all=liveStates.get(scenario)??makeLiveFixtures(scenario);const p=all.find(r=>r.queue_id===path.split('/')[3]);
        if(!p){code=404;body={error:'التذكرة غير متاحة'};}
        else body={...p,id:p.queue_id,interaction_type:'post',section:'general',section_hold:null,team_id:teams[0].id,team_name:teams[0].name,version:1,program_snapshot:{id:p.program_id,key:'preview',name:p.program_name,color:'#1fb5b5'},post_id:p.id,post_posted_at:p.posted_at,status:p.queue_status,
          entered_at:p.collected_at,assigned_at:p.collected_at,first_assigned_at:p.collected_at,completed_at:null,assignee_id:p.assignee_id??board.agents[0]?.id,events:[],notes:[],reviews:[],members:[],reassignment_count:0,escalation_count:0};
      }
      else if(/^\/queue\/items\/[a-f0-9-]+\/assign$/.test(path)&&req.method==='POST'){
        const chunks=[];for await(const c of req)chunks.push(c);const input=JSON.parse(Buffer.concat(chunks).toString());
        const all=liveStates.get(scenario)??makeLiveFixtures(scenario);const p=all.find(r=>r.queue_id===path.split('/')[3]);
        if(!manage){code=403;body={error:'غير مصرح'};}
        else if(!p){code=404;body={error:'التذكرة غير متاحة'};}
        else{const member=board.agents.find(a=>a.id===input.assigneeId);p.assignee_id=member?.id;p.assignee_name=member?.full_name;p.queue_status='assigned';body={ok:true,simulated:true};}
      }
      else if(path==='/workforce/board'){

        if(!manage){code=403;body={error:'غير مصرح'};}
        else if(scenario==='error'){code=503;body={error:'تعذر الاتصال بخدمة الاختبار'};}
        else {
          let agents=board.agents;
          if(url.searchParams.has('teamId'))agents=agents.filter(a=>a.team_id===url.searchParams.get('teamId'));
          if(url.searchParams.has('employeeId'))agents=agents.filter(a=>a.id===url.searchParams.get('employeeId'));
          body={...board,agents,serverNow:new Date().toISOString()};
        }
      }
      else if(path==='/workforce/periods')body={items:[{id:'00000000-0000-4000-8000-000000006001',status:'available',previous_status:'offline',started_at:board.range.from,ended_at:board.serverNow,source:'agent',reason:null,end_source:'agent',end_reason:null,corrected_count:0,seconds:3600,actor_name:null,corrections:[]}]};
      else if(/^\/workforce\/agents\/.+\/(status|release)$/.test(path)&&req.method==='POST'){
        const chunks=[];for await(const c of req)chunks.push(c);
        const payload=JSON.parse(Buffer.concat(chunks).toString()||'{}');
        const agent=board.agents.find(a=>a.id===path.split('/')[3]);
        if(!manage){code=403;body={error:'غير مصرح'};}
        else if(!payload.reason?.trim()){code=400;body={error:'السبب إلزامي'};}
        else if(!agent){code=404;body={error:'موظف غير موجود'};}
        else if(path.endsWith('/status')){agent.status=payload.status;body={status:payload.status};}
        else {body={released:agent.open,reassigned:0};agent.open=0;}
      }
      else if(path.endsWith('/correct')&&req.method==='POST')body={ok:true};
      else if(path==='/health')body={ok:true,mode:'demo',xStream:{enabled:false}};
      else {code=404;body={error:'Endpoint not supplied by local fixture server'};}
      if(logs)appendFileSync(logs,JSON.stringify({method:req.method,path,status:code,scenario,role,simulated:true})+'\n');
      res.statusCode=code;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body));
    });
  },
};
export default defineConfig({plugins:[fixtures,react(),tailwindcss()],server:{host:'127.0.0.1',port:5177,strictPort:true}});
