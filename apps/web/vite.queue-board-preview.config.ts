/** Explicit UI-only fixture server. No proxy, database, workers, credentials or outbound calls. */
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync, appendFileSync } from 'node:fs';
import { makeFixtureBoard, fixtureUser, teams, programs } from './src/test/queue-board-fixtures';
const states=new Map<string,ReturnType<typeof makeFixtureBoard>>();
const logs=process.env.QUEUE_BOARD_QA_LOG;
const before=process.env.QUEUE_BOARD_QA_BEFORE;
const fixtures:Plugin={
  name:'queue-board-local-fixtures',
  enforce:'pre',
  load(id) { if(before&&id.replaceAll('\\','/').endsWith('/src/pages/QueueBoard.tsx')) return readFileSync(before,'utf8'); },
  configureServer(server) {
    server.middlewares.use(async(req,res,next)=>{
      const url=new URL(req.url??'/','http://127.0.0.1');
      if(!url.pathname.startsWith('/api/')&&url.pathname!=='/health')return next();
      const ref=new URL(req.headers.referer??'/','http://127.0.0.1');
      const scenario=ref.searchParams.get('qaScenario')??'many', role=ref.searchParams.get('qaRole')??'admin';
      const user=fixtureUser(role),manage=user.permissions.includes('queue:supervise')||user.permissions.includes('queue:view_all');
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
export default defineConfig({plugins:[fixtures,react(),tailwindcss()],server:{host:'127.0.0.1',port:5176,strictPort:true}});
