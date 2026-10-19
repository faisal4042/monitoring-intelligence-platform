import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { api, type ApiError } from '../../lib/api';
import AsyncState from '../AsyncState';
import ConnectionSection from './ConnectionSection';
import EventsSection from './EventsSection';
import RecipientsSection from './RecipientsSection';
import TemplatesSection from './TemplatesSection';
import LogSection from './LogSection';
import type { WaAccess, WaSettings } from './types';
import './whatsapp.css';

type Section = 'connection' | 'events' | 'recipients' | 'templates' | 'log';

/** WhatsApp as one more channel of the notifications centre. Each area renders only for its permission. */
export default function WhatsAppPanel({ access }: { access: WaAccess }) {
  const sections: Array<{ key: Section; label: string; show: boolean }> = [
    { key: 'connection', label: 'الاتصال والتشغيل', show: access.view },
    { key: 'events', label: 'أنواع التنبيهات', show: access.view || access.configure },
    { key: 'recipients', label: 'المستلمون والتوجيه', show: access.recipients },
    { key: 'templates', label: 'القوالب', show: access.view || access.templates },
    { key: 'log', label: 'سجل الرسائل', show: access.log },
  ];
  const visible = sections.filter((s) => s.show);
  const [current, setCurrent] = useState<Section>(visible[0]?.key ?? 'log');
  const settings = useQuery({ queryKey: ['wa-settings'], queryFn: () => api.get<WaSettings>('/whatsapp/settings'), enabled: access.view, retry: false });
  const notInstalled = (settings.error as ApiError | null)?.code === 'WHATSAPP_NOT_INSTALLED';

  if (notInstalled) return (
    <div className="card wa-section" role="status">
      <div className="wa-note is-warning"><AlertTriangle size={16} aria-hidden="true" />
        <span>قناة واتساب غير مثبّتة على قاعدة البيانات بعد. يلزم تطبيق الترحيل 0055 في خطوة تشغيل معتمدة قبل استخدامها.</span></div>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="wa-subnav" role="tablist" aria-label="أقسام واتساب">
        {visible.map((s) => <button key={s.key} type="button" role="tab" aria-selected={current === s.key} onClick={() => setCurrent(s.key)}>{s.label}</button>)}
      </div>
      {current === 'connection' && (
        <AsyncState loading={settings.isLoading} error={settings.error} onRetry={() => settings.refetch()}>
          {settings.data && <ConnectionSection access={access} settings={settings.data} />}
        </AsyncState>
      )}
      {current === 'events' && <EventsSection access={access} />}
      {current === 'recipients' && <RecipientsSection access={access} />}
      {current === 'templates' && <TemplatesSection access={access} />}
      {current === 'log' && <LogSection access={access} />}
    </div>
  );
}
