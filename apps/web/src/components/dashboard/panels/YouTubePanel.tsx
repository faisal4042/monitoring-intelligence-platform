import { Link } from 'react-router-dom';
import { ChevronLeft, ExternalLink } from 'lucide-react';
import { fmtCompact, fmtDateTime, fmtNum, fmtRelative } from '../../../lib/format';
import type { Q, YouTubeData } from '../types';
import { Delta, Panel, State, Unavailable } from '../ui';

/** A YouTube brief: totals, the most watched relevant videos, and where they come from. Separate from X totals. */
export default function YouTubePanel({ q, allowed, programMode, panel }: { q: Q<YouTubeData>; allowed: boolean; programMode: boolean; panel: object }) {
  const d = q.data?.activated ? q.data : null;
  const meters = programMode || !d ? (d?.channels ?? []).map((c) => ({ id: c.channel, label: c.channel, value: c.videos }))
    : d.byProgram.map((p) => ({ id: p.key, label: p.name_ar, value: p.videos }));
  const maxMeter = Math.max(1, ...meters.map((m) => m.value));
  return <Panel id="youtube" title="رصد يوتيوب" eyebrow="فيديوهات وتعليقات" {...panel}
    info="فيديوهات يوتيوب حسب تاريخ نشرها، منفصلة تمامًا عن منشورات X ولا تُضاف إلى إجمالياتها. «ذات صلة» = مطابقة أو مؤكدة لبرنامج. التعليقات حسب تاريخ نشرها على الفيديوهات ذات الصلة. المشاهدات من آخر تحديث لإحصاءات كل فيديو."
    footer={allowed && <Link className="dash-link" to="/youtube">كل فيديوهات يوتيوب<ChevronLeft size={14} /></Link>}>
    {!allowed ? <Unavailable reason="يتطلب هذا القسم صلاحية عرض يوتيوب." /> :
    <State loading={q.isLoading} error={q.error} height={260}>
      {q.data && !q.data.activated && <p className="dash-state is-compact">رصد يوتيوب غير مفعّل في هذه البيئة.</p>}
      {d && <div className="dash-yt">
        <div>
          <div className="dash-news-stats dash-yt-stats">
            <div><span>فيديوهات ذات صلة</span><strong className="num">{fmtNum(d.relevant)}</strong><Delta value={d.relevant} previous={d.relevantPrevious} compact /></div>
            <div><span>التعليقات</span><strong className="num">{fmtNum(d.comments)}</strong><Delta value={d.comments} previous={d.commentsPrevious} compact /></div>
            <div><span>المشاهدات</span><strong className="num" title={fmtNum(d.views)}>{fmtCompact(d.views)}</strong></div>
            <div><span>تحتاج مراجعة</span><strong className="num">{fmtNum(d.needsReview)}</strong></div>
          </div>
          <h3 className="dash-subtitle">الأكثر مشاهدة</h3>
          {d.top.length ? <ul className="dash-news">{d.top.map((v) => <li key={v.id}>
            <a href={`https://www.youtube.com/watch?v=${v.youtube_video_id}`} target="_blank" rel="noreferrer" className="dash-news-item">
              <span className="dash-news-title">{v.title ?? 'فيديو بلا عنوان'}</span>
              <span className="dash-news-meta"><strong>{v.channel_title ?? 'قناة غير معروفة'}</strong>{v.program_name && <span>{v.program_name}</span>}
                {v.views != null && <span>{fmtCompact(v.views)} مشاهدة</span>}
                <time dateTime={v.published_at} title={fmtDateTime(v.published_at)}>{fmtRelative(v.published_at)}</time></span>
              <ExternalLink size={14} aria-label="يفتح الفيديو في نافذة جديدة" className="dash-news-go" />
            </a></li>)}</ul>
            : <p className="dash-state is-compact">لا توجد فيديوهات ذات صلة في هذه الفترة.</p>}
        </div>
        {meters.length > 0 && <div>
          <h3 className="dash-subtitle">{programMode ? 'أكثر القنوات نشرًا' : 'الفيديوهات ذات الصلة حسب البرنامج'}</h3>
          <ul className="dash-meter-list">{meters.map((m) => <li key={m.id} className="dash-meter-row" title={`${fmtNum(m.value)} فيديو`}>
            <span className="truncate">{m.label}</span>
            <span className="dash-meter"><span style={{ width: `${(m.value / maxMeter) * 100}%` }} /></span>
            <span className="num">{fmtNum(m.value)}</span>
          </li>)}</ul>
        </div>}
      </div>}
    </State>}
  </Panel>;
}
