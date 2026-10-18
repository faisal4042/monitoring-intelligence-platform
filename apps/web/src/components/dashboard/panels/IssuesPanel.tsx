import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, ChevronLeft, Minus, Sparkle } from 'lucide-react';
import { fmtNum, fmtRelative } from '../../../lib/format';
import { STORY_STATE_LABELS } from '../../../lib/dashboard';
import { topIssues } from '../transforms';
import type { OnDrill, Q, StoriesData } from '../types';
import { Panel, State, Unavailable } from '../ui';

/** The story state the system computes; shown with an icon so it never rests on colour. */
const STATE_ICON: Record<string, typeof ArrowUp> = { new: Sparkle, rising: ArrowUp, steady: Minus, fading: ArrowDown };

/** The five largest active issues (approved stories), each opening its posts. No invented severity. */
export default function IssuesPanel({ q, allowed, onDrill, panel }: { q: Q<StoriesData>; allowed: boolean; onDrill: OnDrill; panel: object }) {
  const d = q.data;
  const items = topIssues(d?.items ?? []);
  return <Panel id="stories" title="القضايا الناشئة" eyebrow="القضايا والموضوعات" {...panel}
    info="القضية = قصة معتمدة (مصدران مستقلان على الأقل) لها نشاط في الفترة، مرتبة بحجم التفاعلات. الاتجاه هو حالة القصة المحسوبة في النظام (جديدة، متصاعدة، مستقرة، تخفت). لا يوجد مؤشر خطورة محسوب للقضايا، لذلك لا يُعرض."
    footer={allowed && d && <>
      <span className="dash-muted-sm">{fmtNum(d.active)} قضية نشطة في الفترة · {fmtNum(d.liveNow)} نشطة الآن من {fmtNum(d.approvedTotal)} معتمدة</span>
      <Link className="dash-link" to="/signals">كل القضايا<ChevronLeft size={14} /></Link>
    </>}>
    {!allowed ? <Unavailable reason="يتطلب هذا القسم صلاحية عرض المواضيع والقصص." /> :
    <State loading={q.isLoading} error={q.error} empty={!items.length} height={260} emptyText="لا توجد قضايا معتمدة لها نشاط في هذه الفترة.">
      <ol className="dash-issues">{items.map((s, i) => {
        const Icon = STATE_ICON[s.state] ?? Minus;
        return <li key={s.id}>
          <button className="dash-issue" onClick={() => onDrill({ title: s.title_ar, params: { storyId: s.id } })}>
            <span className="dash-issue-rank num" aria-hidden="true">{i + 1}</span>
            <span className="dash-issue-main">
              <strong>{s.title_ar}</strong>
              <span className="dash-issue-meta">
                <span><span className="dash-dot" style={{ background: s.color ?? undefined }} aria-hidden="true" />{s.program_name}</span>
                <span>آخر نشاط {fmtRelative(s.last_seen_at)}</span>
              </span>
            </span>
            <span className={`dash-state-pill is-${s.state}`}><Icon size={12} aria-hidden="true" />{STORY_STATE_LABELS[s.state] ?? s.state}</span>
            <span className="dash-issue-vol"><strong className="num">{fmtNum(s.post_count)}</strong><span>تفاعل · {fmtNum(s.family_count)} مصدر</span></span>
          </button>
        </li>;
      })}</ol>
    </State>}
  </Panel>;
}
