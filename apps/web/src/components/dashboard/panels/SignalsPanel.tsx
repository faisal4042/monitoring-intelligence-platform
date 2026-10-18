import { useState } from 'react';
import { AlertTriangle, ChevronLeft, Sparkles } from 'lucide-react';
import type { InsightsData, OnDrill, Q } from '../types';
import { Panel, State } from '../ui';

const SHOWN = 4;

/** Rule-based signals beside the trend: what changed enough to look at, and why. */
export default function SignalsPanel({ q, onDrill, panel }: { q: Q<InsightsData>; onDrill: OnDrill; panel: object }) {
  const [all, setAll] = useState(false);
  const items = q.data?.items ?? [];
  const ordered = [...items].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'warning' ? -1 : 1));
  const shown = all ? ordered : ordered.slice(0, SHOWN);
  return <Panel id="insights" title="إشارات تستحق الانتباه" eyebrow="الإنذار المبكر" {...panel}
    info="تُحسب من أرقام اللوحة نفسها بقواعد ثابتة وحد أدنى للعينة، ولا تستخدم نموذجًا لغويًا. منفصلة عن تنبيهات طابور الرصد.">
    <State loading={q.isLoading} error={q.error} empty={!items.length} height={240}
      emptyText={q.data && !q.data.comparable ? 'لا توجد فترة مقارنة لهذه الفترة الزمنية.' : 'لا توجد تغيرات تتجاوز حدود القواعد في هذه الفترة.'}>
      <ul className="dash-signals">{shown.map((i) => {
        const Icon = i.severity === 'warning' ? AlertTriangle : Sparkles;
        const body = <>
          <Icon size={16} aria-hidden="true" className="dash-signal-icon" />
          <span className="min-w-0 flex-1">
            <span className="dash-signal-kind">{i.severity === 'warning' ? 'تحذير' : 'معلومة'}</span>
            <strong>{i.title}</strong><span className="dash-signal-detail">{i.detail}</span>
            <span className="dash-signal-rule">القاعدة: {i.rule}</span>
          </span>
          {i.drill && <ChevronLeft size={16} aria-hidden="true" className="dash-signal-go" />}
        </>;
        return <li key={i.key} className={`dash-signal is-${i.severity}`}>
          {i.drill ? <button onClick={() => onDrill({ title: i.title, params: i.drill! })}>{body}</button> : <div>{body}</div>}
        </li>;
      })}</ul>
      {items.length > SHOWN && <button className="dash-link mt-2" aria-expanded={all} onClick={() => setAll((a) => !a)}>{all ? 'عرض أقل' : `عرض الكل (${items.length})`}</button>}
    </State>
  </Panel>;
}
