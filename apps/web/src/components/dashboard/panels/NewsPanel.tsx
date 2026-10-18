import { Link } from 'react-router-dom';
import { ChevronLeft, ExternalLink } from 'lucide-react';
import { fmtDateTime, fmtNum, fmtRelative } from '../../../lib/format';
import type { NewsData, Q } from '../types';
import { Delta, Panel, State, Unavailable } from '../ui';

const LATEST = 5;
const SOURCES = 5;

/** A short news brief: totals, the latest relevant items and the sources they come from. */
export default function NewsPanel({ q, allowed, panel }: { q: Q<NewsData>; allowed: boolean; panel: object }) {
  const d = q.data;
  const maxSource = Math.max(1, ...(d?.bySource ?? []).slice(0, SOURCES).map((s) => s.relevant));
  return <Panel id="news" title="الأخبار المهمة" eyebrow="ذكاء الأخبار" {...panel}
    info="أخبار المصادر المرصودة حسب تاريخ نشرها (أو اكتشافها إن لم يتوفر)، منفصلة تمامًا عن منشورات X ولا تُضاف إلى إجمالياتها. «ذات صلة» = مرتبطة ببرنامج."
    footer={allowed && <Link className="dash-link" to="/news/articles">كل الأخبار<ChevronLeft size={14} /></Link>}>
    {!allowed ? <Unavailable reason="يتطلب هذا القسم صلاحية عرض الأخبار." /> :
    <State loading={q.isLoading} error={q.error} height={260}>
      {d && <>
        <div className="dash-news-stats">
          <div><span>الأخبار المجمعة</span><strong className="num">{fmtNum(d.total)}</strong><Delta value={d.total} previous={d.totalPrevious} compact /></div>
          <div><span>ذات صلة بالبرامج</span><strong className="num">{fmtNum(d.relevant)}</strong><Delta value={d.relevant} previous={d.relevantPrevious} compact /></div>
        </div>
        {d.latest.length ? <ul className="dash-news">{d.latest.slice(0, LATEST).map((n) => <li key={n.id}>
          <a href={n.url} target="_blank" rel="noreferrer" className="dash-news-item">
            <span className="dash-news-title">{n.title}</span>
            <span className="dash-news-meta"><strong>{n.source}</strong>{n.program_name && <span>{n.program_name}</span>}
              <time dateTime={n.published_at} title={fmtDateTime(n.published_at)}>{fmtRelative(n.published_at)}</time></span>
            <ExternalLink size={14} aria-label="يفتح المصدر في نافذة جديدة" className="dash-news-go" />
          </a></li>)}</ul>
          : <p className="dash-state is-compact">لا توجد أخبار ذات صلة في هذه الفترة.</p>}
        {d.bySource.length > 0 && <>
          <h3 className="dash-subtitle mt-3">أكثر المصادر نشرًا للأخبار ذات الصلة</h3>
          <ul className="dash-meter-list">{d.bySource.slice(0, SOURCES).map((s) => <li key={s.source} className="dash-meter-row" title={`${fmtNum(s.relevant)} ذات صلة من ${fmtNum(s.articles)} خبرًا`}>
            <span className="truncate">{s.source}</span>
            <span className="dash-meter"><span style={{ width: `${(s.relevant / maxSource) * 100}%` }} /></span>
            <span className="num">{fmtNum(s.relevant)}</span>
          </li>)}</ul>
        </>}
      </>}
    </State>}
  </Panel>;
}
