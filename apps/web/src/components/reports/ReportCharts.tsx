import ReactECharts from 'echarts-for-react';
import type { summarizeExports } from '../../lib/report-insights';
import { EXPORT_STATUS, type Catalog, type ExportRow } from '../../lib/reports';
import { fmtNum } from '../../lib/format';
import { useChartColors } from '../dashboard/charts/theme';

export default function ReportCharts({summary:s,catalog}:{summary:ReturnType<typeof summarizeExports>;catalog:Catalog}) {
  // The shared chart palette (DESIGN.md → Charts), per theme.
  const c=useChartColors();
  const colors=[...c.series,c.compare];
  const text=c.muted;
  return <div className="rc-analytics">
    <section className="rc-panel rc-chart" aria-labelledby="rc-activity-heading"><div className="rc-section-heading"><div><h3 id="rc-activity-heading">نشاط التصدير</h3><p className="rc-desc">حسب تاريخ الطلب في السجل المتاح · توقيت الرياض</p></div><span className="rc-tag">{fmtNum(s.total)} عملية</span></div>
      <div role="img" aria-label={`نشاط التصدير: ${s.days.map(([d,n])=>`${d}: ${n}`).join('، ')}`}><ReactECharts style={{height:200}} option={{animation:false,aria:{enabled:true},textStyle:{fontFamily:'inherit',color:text},grid:{top:24,bottom:28,left:36,right:18,containLabel:true},tooltip:{trigger:'axis'},xAxis:{type:'category',data:s.days.map(([d])=>d),axisLine:{show:false},axisTick:{show:false},axisLabel:{color:text}},yAxis:{type:'value',minInterval:1,axisLabel:{color:text},splitLine:{lineStyle:{color:text,opacity:.12}}},series:[{name:'عمليات التصدير',type:'bar',barMaxWidth:40,itemStyle:{color:c.primary,borderRadius:[5,5,0,0]},data:s.days.map(([,n])=>n)}]}} /></div>
    </section>
    <section className="rc-panel rc-chart" aria-labelledby="rc-distribution-heading"><div><h3 id="rc-distribution-heading">توزيع حالات التصدير</h3><p className="rc-desc">صورة واضحة عن جاهزية ملفاتك</p></div><div className="rc-distribution">
      <div role="img" aria-label={s.statuses.map(([status,n])=>`${EXPORT_STATUS[status as ExportRow['status']].label}: ${n}`).join('، ')}><ReactECharts style={{height:180,width:'100%'}} option={{animation:false,aria:{enabled:true},color:colors,series:[{type:'pie',radius:['64%','86%'],center:['50%','50%'],label:{show:false},data:s.statuses.map(([status,value])=>({name:EXPORT_STATUS[status as ExportRow['status']].label,value}))}]}} /></div>
      <ul>{s.statuses.map(([status,n],i)=><li key={status}><span style={{background:colors[i%colors.length]}} aria-hidden="true"/><span>{EXPORT_STATUS[status as ExportRow['status']].label}</span><b>{fmtNum(n)}</b></li>)}</ul>
    </div></section>
  </div>;
}
