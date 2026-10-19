import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { MonitorDot, RefreshCw, Settings2, Search, ArrowLeft, UsersRound, Inbox, AlertTriangle, CheckCircle2, Clock3, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { PERMISSIONS as P, QUEUE_SECTION_LABELS, STATUS_SOURCE_LABELS, type QueueSection } from '@mip/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { duration, useServerClock, type QueueOptions } from '../../lib/queue';
import { hours, minutesText, statusLabel, STATUS_ORDER, type Board, type BoardAgent } from '../../lib/workforce';
import { selectBoardAgents, loadRatio, workloadLabel, type AgentSort } from '../../lib/queue-board';
import { fmtDateTime, fmtNum } from '../../lib/format';
import { DEFAULT_DATE_RANGE, useDateRange } from '../../lib/useDateRange';
import DateRangeFilter from '../DateRangeFilter';
import { Panel } from '../dashboard/ui';
import DialogSurface from './DialogSurface';
import { Button } from '../ui/Button';
import './queue-board.css';

export type BoardAction = 'status' | 'release' | 'periods';
export default function QueueBoardOverview({ onAction }: { onAction: (agent: BoardAgent, kind: BoardAction, range: string) => void }) {
  const { can } = useAuth();
  const manage = can(P.QUEUE_SUPERVISE, P.QUEUE_VIEW_ALL);
  const [params, setParams] = useSearchParams();
  const date = useDateRange();
  const qs = new URLSearchParams(date.apiQuery);
  for (const key of ['teamId', 'programId', 'employeeId']) if (params.get(key)) qs.set(key, params.get(key)!);
  const board = useQuery({ queryKey: ['workforce', 'board', qs.toString()], queryFn: () => api.get<Board>(`/workforce/board?${qs}`), enabled: manage && !date.error, refetchInterval: 20000, refetchIntervalInBackground: false });
  const options = useQuery({ queryKey: ['queue-options'], queryFn: () => api.get<QueueOptions>('/queue/options'), enabled: manage });
  const d = board.data;
  const now = useServerClock(d?.serverNow, 30000);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<AgentSort>('status');
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = d?.agents.find(a => a.id === selectedId);
  const employees = useMemo(() => selectBoardAgents(d?.agents ?? [], search, sort, page), [d?.agents, search, sort, page]);
  useEffect(() => { setPage(1); setSelectedId(null); }, [qs.toString()]);
  const members = (options.data?.members ?? []).filter((m, i, all) => m.kind !== 'supervisor' && all.findIndex(n => n.id === m.id) === i);
  const programs = (options.data?.programs ?? []).filter((p, i, all) => all.findIndex(n => n.id === p.id) === i);
  const set = (key: string, value: string) => setParams(old => { const next = new URLSearchParams(old); value ? next.set(key, value) : next.delete(key); return next; }, { replace: true });
  const active = [
    { key: 'teamId', label: options.data?.teams.find(t => t.id === params.get('teamId'))?.name },
    { key: 'programId', label: programs.find(p => p.id === params.get('programId'))?.name_ar },
    { key: 'employeeId', label: members.find(m => m.id === params.get('employeeId'))?.full_name },
  ].filter(f => params.has(f.key));
  const clear = () => { setParams(old => { const next = new URLSearchParams(old); for (const k of ['teamId', 'programId', 'employeeId', 'range', 'from', 'to']) next.delete(k); return next; }, { replace: true }); setSearch(''); setPage(1); };
  const act = (a: BoardAgent, kind: BoardAction) => { if (!manage) return; setSelectedId(null); onAction(a, kind, date.apiQuery); };
  return <div className="queue-board" dir="rtl">
    <header className="qb-header">
      <div><span className="dash-eyebrow">إدارة العمليات</span><h1><MonitorDot size={23} />لوحة فرق الرصد</h1><p>نظرة سريعة على وضع الفريق، حمل الصناديق والتذاكر التي تحتاج تدخلًا.</p></div>
      <div className="qb-header-actions">
        <span className="qb-update">{d ? <>آخر تحديث للبيانات <time dateTime={d.serverNow}>{fmtDateTime(d.serverNow)}</time></> : 'لم تُحمّل البيانات بعد'}</span>
        <Button variant="ghost" type="submit" aria-label="تحديث اللوحة" disabled={board.isFetching || !!date.error} onClick={() => { board.refetch(); options.refetch(); }}><RefreshCw size={15} className={board.isFetching ? 'animate-spin' : ''} />تحديث</Button>
        {manage && <Link className="btn-ghost" to="/queue/settings"><Settings2 size={15} />إعدادات الموظفين</Link>}
      </div>
    </header>
    <section className="qb-filters card" aria-label="فلاتر اللوحة">
      <div className="qb-filter-grid">
        <label className="queue-field">الفريق<select className="input" value={params.get('teamId') ?? ''} onChange={e => set('teamId', e.target.value)}><option value="">كل فرقي</option>{options.data?.teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        <label className="queue-field">البرنامج<select className="input" value={params.get('programId') ?? ''} onChange={e => set('programId', e.target.value)}><option value="">كل البرامج</option>{programs.map(p => <option key={p.id} value={p.id}>{p.name_ar}</option>)}</select></label>
        <label className="queue-field">الموظف<select className="input" value={params.get('employeeId') ?? ''} onChange={e => set('employeeId', e.target.value)}><option value="">كل الموظفين</option>{members.map(m => <option key={m.id} value={m.id}>{m.full_name}</option>)}</select></label>
        <div className="queue-field qb-date-filter">فترة الأداء والوقت<DateRangeFilter state={date} /></div>
      </div>
      <div className="qb-filter-foot"><span className="qb-scope-note">الصناديق والانتظار: الآن · الإنجاز والمدد: الفترة المختارة · توقيت الرياض</span>
        {(active.length > 0 || date.preset !== DEFAULT_DATE_RANGE || search) && <button className="qb-text-button" onClick={clear}>مسح الفلاتر</button>}
        {active.map(f => <button key={f.key} className="qb-filter-chip" onClick={() => set(f.key, '')}>{f.label ?? 'فلتر محدد'}<X size={12} /><span className="sr-only">إزالة الفلتر</span></button>)}
      </div>
      {options.error && <p role="alert" className="text-sm text-(--status-danger)">تعذر تحميل خيارات الفلاتر. <button className="underline" onClick={() => options.refetch()}>إعادة المحاولة</button></p>}
    </section>
    {board.error && <div role="alert" className="qb-error card"><AlertTriangle size={17} /><span>{d ? 'تعذر التحديث؛ تُعرض آخر بيانات ناجحة.' : 'تعذر تحميل اللوحة.'} {board.error.message}</span><Button variant="ghost" type="submit" onClick={() => board.refetch()}>إعادة المحاولة</Button></div>}
    {board.isPending && !date.error && <div className="qb-kpis" role="status" aria-label="جارٍ تحميل اللوحة">{Array.from({ length: 6 }, (_, i) => <div className="dash-skeleton" key={i} style={{ height: 116 }} />)}</div>}
    {d && <>
      <section className="qb-kpis" aria-label="مؤشرات الطابور الآن">
        <Kpi title="بانتظار الإسناد" value={d.backlog.waiting} icon={Inbox} note={`${fmtNum(d.backlog.waiting_high)} عالية الأولوية · أقدم ${minutesText(d.backlog.oldest_waiting_min)}`} />
        <Kpi title="تجاوز حد الانتظار" value={d.backlog.starving} icon={Clock3} critical={d.backlog.starving > 0} note={`انتظار ${d.starvationMinutes} دقيقة فأكثر`} />
        <Kpi title="المتأخر في الصناديق" value={d.backlog.overdue} icon={AlertTriangle} critical={d.backlog.overdue > 0} note={`أكثر من ${d.warnMinutes} دقيقة منذ الإسناد`} />
        <Kpi title="في صناديق الموظفين" value={d.backlog.in_boxes} icon={UsersRound} note="مسندة وجارٍ العمل عليها الآن" />
        <Kpi title="التذاكر المصعّدة" value={d.backlog.escalated} icon={ArrowLeft} critical={d.backlog.escalated > 0} note="تحتاج متابعة المسار التصعيدي" />
        <Kpi title="المغلق اليوم" value={d.backlog.closedToday} icon={CheckCircle2} note="تفاعلات دون تكرار · اليوم بتوقيت الرياض" />
      </section>
      {!d.autoAssignEnabled && <div className="qb-notice"><AlertTriangle size={15} /><span>الإسناد التلقائي متوقف على مستوى النظام.</span>{manage && <Link to="/queue/settings">مراجعة الإعدادات</Link>}</div>}
      <Panel id="board-agents" title="فريق الرصد" eyebrow="الوضع التشغيلي" info="الحالة التشغيلية والحمل من الخادم. آخر نبضة اتصال ليست آخر نشاط، ولا تثبت اتصالًا لحظيًا." actions={<span className="qb-total">{fmtNum(d.agents.length)} موظف</span>}>
        <div className="qb-agent-toolbar">
          <label className="qb-search"><Search size={16} /><input type="search" aria-label="البحث عن موظف" placeholder="ابحث باسم الموظف أو الفريق…" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} /></label>
          <label className="qb-sort">ترتيب حسب<select className="input" aria-label="ترتيب الموظفين" value={sort} onChange={e => { setSort(e.target.value as AgentSort); setPage(1); }}><option value="status">الحالة التشغيلية</option><option value="load">الحمل الأعلى</option><option value="tickets">عدد التذاكر</option><option value="closed">المغلق اليوم</option><option value="name">الاسم</option></select></label>
          <div className="qb-availability-summary"><span><i className="qb-dot is-ready" />{d.agents.filter(a => workloadLabel(a) === 'متاح').length} متاح</span><span><i className="qb-dot is-busy" />{d.agents.filter(a => workloadLabel(a) === 'مشغول').length} مشغول</span><span><i className="qb-dot" />{d.agents.filter(a => a.status === 'offline').length} غير متصل</span></div>
        </div>
        {employees.total === 0 ? <div className="qb-empty"><UsersRound size={22} /><strong>{d.agents.length ? 'لا يوجد موظف يطابق البحث' : 'لا يوجد موظفو رصد في الفرق المحددة'}</strong><span>{d.agents.length ? 'جرّب اسمًا آخر أو امسح البحث.' : 'تحقق من الفريق والفلاتر المختارة.'}</span></div> : <>
          <div className="qb-table-wrap"><table className="qb-table"><thead><tr>{['الموظف والفريق', 'الحالة والاتصال', 'الصندوق والطاقة', 'المغلق اليوم', 'المصعّد', ''].map((t, i) => <th key={i} scope="col">{t || <span className="sr-only">التفاصيل</span>}</th>)}</tr></thead>
            <tbody>{employees.rows.map(a => <tr key={a.id} className={a.status === 'offline' ? 'qb-row-offline' : ''}>
              <td><button className="qb-person" onClick={() => setSelectedId(a.id)}><span className="qb-avatar">{a.full_name.trim().slice(0, 1)}</span><span><strong>{a.full_name}</strong><small>{a.team_name}</small></span></button></td>
              <td><Status agent={a} now={now} /><span className="qb-secondary">{a.status === 'offline' ? 'غير متصل حسب الحالة' : a.last_heartbeat_at ? 'نبضة اتصال مسجلة' : 'الاتصال غير موثق'}</span></td>
              <td><Capacity agent={a} /></td><td className="qb-count">{fmtNum(a.closedToday)}</td><td className="qb-count">{fmtNum(a.escalatedOpen)}</td>
              <td><button className="qb-details-button" aria-label={`تفاصيل ${a.full_name}`} onClick={() => setSelectedId(a.id)}>التفاصيل<ChevronLeft size={14} /></button></td>
            </tr>)}</tbody></table></div>
          <div className="qb-mobile-agents">{employees.rows.map(a => <button key={a.id} className="qb-mobile-agent" aria-label={`تفاصيل ${a.full_name}`} onClick={() => setSelectedId(a.id)}>
            <span className="qb-mobile-agent-head"><span><strong>{a.full_name}</strong><small>{a.team_name}</small></span><span className={`wf-status-chip agent-status--${a.status}`}><span className="agent-status-dot" />{statusLabel(a.status)}</span></span>
            <span className="qb-mobile-meta"><span>{workloadLabel(a)} · {a.status_since ? duration(a.status_since, now) : 'مدة غير متاحة'}</span><span>{a.last_heartbeat_at ? 'نبضة اتصال مسجلة' : 'لا يوجد اتصال موثق'}</span></span>
            <Capacity agent={a} /><span className="qb-mobile-counts"><span>المغلق اليوم <b>{fmtNum(a.closedToday)}</b></span><span>المصعّد <b>{fmtNum(a.escalatedOpen)}</b></span><span className="qb-details-button">التفاصيل<ChevronLeft size={14} /></span></span>
          </button>)}</div>
          <footer className="qb-pagination"><span>عرض {fmtNum((employees.current - 1) * 10 + 1)}–{fmtNum(Math.min(employees.current * 10, employees.total))} من {fmtNum(employees.total)} موظف</span>
            {employees.pages > 1 && <nav aria-label="صفحات الموظفين"><button className="icon-button" aria-label="الصفحة السابقة" disabled={employees.current === 1} onClick={() => setPage(employees.current - 1)}><ChevronRight size={16} /></button><span>{employees.current} / {employees.pages}</span><button className="icon-button" aria-label="الصفحة التالية" disabled={employees.current === employees.pages} onClick={() => setPage(employees.current + 1)}><ChevronLeft size={16} /></button></nav>}
          </footer>
        </>}
      </Panel>
      <div className="qb-analytics">
        <Panel id="board-programs" title="التذاكر حسب البرنامج"><Distribution rows={d.byProgram.map(p => ({ ...p, key: p.program_id, label: p.name }))} /></Panel>
        <Panel id="board-sections" title="التذاكر حسب المسار"><Distribution rows={d.bySection.map(s => ({ ...s, key: s.section, label: QUEUE_SECTION_LABELS[s.section as QueueSection]?.ar ?? s.section }))} /></Panel>
        <Panel id="board-times" title="الوقت حسب حالة الموظفين" info="سجلات الخادم مقسمة بتوقيت الرياض. الوقت المسجل منفصل عن الإنتاجية وعن الدوام المجدول."><TimeSummary time={d.timeTotals} operational={d.operationalStatuses.map(statusLabel).join('، ')} /><p className="qb-period">{fmtDateTime(d.range.from)} — {fmtDateTime(d.range.to)}</p></Panel>
      </div>
    </>}
    {selected && d && <DialogSurface drawer title="تفاصيل الموظف" onClose={() => setSelectedId(null)}>
      <div className="qb-drawer-person"><span className="qb-avatar">{selected.full_name.trim().slice(0, 1)}</span><div><h3>{selected.full_name}</h3><p>{selected.team_name}</p></div></div>
      <Status agent={selected} now={now} />
      <dl className="qb-facts"><Fact title="الحالة التشغيلية" value={workloadLabel(selected)} /><Fact title="بدأت الحالة" value={selected.status_since ? fmtDateTime(selected.status_since) : 'غير متاح'} /><Fact title="مصدر الحالة" value={selected.status_source ? STATUS_SOURCE_LABELS[selected.status_source as keyof typeof STATUS_SOURCE_LABELS] ?? selected.status_source : 'غير متاح'} /><Fact title="آخر نبضة اتصال" value={selected.last_heartbeat_at ? fmtDateTime(selected.last_heartbeat_at) : 'غير موثقة'} /></dl>
      <p className="qb-scope-note">نبضة الاتصال ليست آخر نشاط وظيفي، ولا تثبت اتصالًا لحظيًا.</p>
      <section className="qb-drawer-section"><h3>الحمل وتوزيع التذاكر</h3><Capacity agent={selected} /><dl className="qb-facts"><Fact title="الطاقة الاستيعابية" value={fmtNum(selected.maxOpen)} /><Fact title="الإسناد التلقائي للموظف" value={selected.autoAssign ? 'مفعّل' : 'معطّل'} /><Fact title="المصعّد المفتوح" value={fmtNum(selected.escalatedOpen)} /><Fact title="المغلق اليوم" value={fmtNum(selected.closedToday)} /><Fact title="أقدم مفتوح" value={minutesText(selected.oldestOpenMin)} /><Fact title="متوسط عمر المفتوح" value={minutesText(selected.performance.avgOpenAgeMin)} /></dl></section>
      <section className="qb-drawer-section"><h3>الإنجاز خلال الفترة</h3><p className="qb-period">{fmtDateTime(d.range.from)} — {fmtDateTime(d.range.to)}</p><dl className="qb-facts"><Fact title="مغلق في الفترة" value={fmtNum(selected.performance.completedItems)} /><Fact title="دورات الإغلاق" value={fmtNum(selected.performance.completedCycles)} /><Fact title="من الإسناد حتى الإغلاق" value={minutesText(selected.performance.avgAssignmentToCloseMin)} /><Fact title="متوسط الانتظار في الطابور" value={minutesText(selected.performance.avgQueueWaitMin)} /><Fact title="أُعيد فتحه" value={fmtNum(selected.performance.reopened)} /><Fact title="صُعّد في الفترة" value={fmtNum(selected.performance.escalated)} /><Fact title="إسناد أول في الفترة" value={fmtNum(selected.performance.firstAssignedItems)} /></dl></section>
      <section className="qb-drawer-section"><h3>مدد الحالات التشغيلية</h3><TimeSummary time={selected.time} operational={d.operationalStatuses.map(statusLabel).join('، ')} /></section>
      {manage && <section className="qb-drawer-section"><h3>الإجراءات</h3><div className="qb-drawer-actions"><Button variant="primary" type="submit" onClick={() => act(selected, 'status')}>تغيير الحالة</Button><Button variant="ghost" type="submit" disabled={!selected.open} onClick={() => act(selected, 'release')}>إعادة توزيع الصندوق</Button><Button variant="ghost" type="submit" onClick={() => act(selected, 'periods')}>سجل الحالات والتصحيحات</Button></div></section>}
    </DialogSurface>}
  </div>;
}

function Kpi({ title, value, note, critical, icon: Icon }: { title: string; value: number; note: string; critical?: boolean; icon: typeof Inbox }) {
  return <article className={`qb-kpi card ${critical ? 'is-critical' : ''}`}><div className="qb-kpi-heading"><span>{title}</span><Icon size={17} /></div><strong className="qb-kpi-value">{fmtNum(value)}</strong><p>{note}</p>{critical && <span className="sr-only">تحتاج متابعة</span>}</article>;
}
function Status({ agent: a, now }: { agent: BoardAgent; now?: string }) {
  return <span className="qb-status"><span className={`wf-status-chip agent-status--${a.status}`}><span className="agent-status-dot" aria-hidden="true" />{statusLabel(a.status)}</span><span className="qb-secondary">{a.status_since && now ? duration(a.status_since, now) : 'مدة غير متاحة'}</span></span>;
}
function Capacity({ agent: a }: { agent: BoardAgent }) {
  const ratio = loadRatio(a);
  return <span className={`qb-capacity ${ratio >= 1 && a.open > 0 ? 'is-full' : ''}`}><span className="qb-capacity-text"><strong dir="ltr">{fmtNum(a.open)} <small>/ {fmtNum(a.maxOpen)}</small></strong><span>{a.maxOpen > 0 ? `${Math.round(ratio * 100)}٪` : 'طاقة معطلة'}</span></span><span className="qb-capacity-track" aria-hidden="true"><span style={{ width: `${Math.min(100, ratio * 100)}%` }} /></span><span className="qb-secondary">{workloadLabel(a)}{!a.autoAssign ? ' · الإسناد التلقائي معطّل' : ''}</span></span>;
}
function Fact({ title, value }: { title: string; value: string }) { return <div><dt>{title}</dt><dd>{value}</dd></div>; }
function Distribution({ rows }: { rows: Array<{ key: string; label: string; waiting: number; in_boxes: number; escalated: number; color?: string | null }> }) {
  const visible = rows.filter(r => r.waiting + r.in_boxes + r.escalated > 0);
  if (!visible.length) return <p className="qb-small-empty">لا توجد تذاكر مفتوحة ضمن الفلاتر.</p>;
  const max = Math.max(...visible.map(r => r.waiting + r.in_boxes + r.escalated));
  return <div className="qb-distribution"><div className="qb-legend"><span><i className="qb-dot is-waiting" />منتظر</span><span><i className="qb-dot is-ready" />في الصناديق</span><span><i className="qb-dot is-escalated" />مصعّد</span></div>{visible.map(r => <div className="qb-distribution-row" key={r.key}><div><strong>{r.label}</strong><span>{fmtNum(r.waiting + r.in_boxes + r.escalated)}</span></div><div className="wf-stack" aria-hidden="true" style={{ width: `${(r.waiting + r.in_boxes + r.escalated) / max * 100}%` }}><span className="wf-stack-waiting" style={{ flexGrow: r.waiting }} /><span className="wf-stack-box" style={{ flexGrow: r.in_boxes }} /><span className="wf-stack-esc" style={{ flexGrow: r.escalated }} /></div><p>منتظر {fmtNum(r.waiting)} · في الصناديق {fmtNum(r.in_boxes)} · مصعّد {fmtNum(r.escalated)}</p></div>)}</div>;
}
function TimeSummary({ time, operational }: { time: BoardAgent['time']; operational: string }) {
  if (!STATUS_ORDER.some(s => time[s] > 0) && !time.logged && !time.operational) return <p className="qb-small-empty">لا توجد مدد حالات مسجلة في الفترة.</p>;
  const max = Math.max(1, ...STATUS_ORDER.map(s => time[s]));
  return <div className="qb-time"><dl className="qb-time-summary"><Fact title="المسجل في النظام" value={hours(time.logged)} /><Fact title="العمل التشغيلي" value={hours(time.operational)} /></dl><p className="qb-scope-note">العمل التشغيلي: {operational}</p>{STATUS_ORDER.map(s => <div className="qb-time-row" key={s}><span>{statusLabel(s)}</span><span className="qb-time-track"><i style={{ width: `${time[s] / max * 100}%` }} /></span><b>{hours(time[s])}</b></div>)}</div>;
}
