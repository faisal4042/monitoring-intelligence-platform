import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { WHATSAPP_GROUP_LABELS, TEMPLATE_STATUS_LABELS, type TemplateMetaStatus } from '@mip/shared';
import { api, type ApiError } from '../../lib/api';
import AsyncState from '../AsyncState';
import { Badge } from '../ui/Badge';
import { AUDIENCE_LABELS, TEMPLATE_TONE, type WaAccess, type WaEvent, type WaTemplate } from './types';

const DEFAULT_AUDIENCE: Record<string, string> = {
  assignee: 'الموظف المُسند إليه', supervisors: 'المشرفون', role: 'مديرو النظام', program_team: 'فريق البرنامج', recipient: 'مستلم محدد',
};

/** Which alerts go to WhatsApp, and with which approved template. Unavailable events are shown, never enabled. */
export default function EventsSection({ access }: { access: WaAccess }) {
  const qc = useQueryClient();
  const events = useQuery({ queryKey: ['wa-events'], queryFn: () => api.get<{ items: (WaEvent & { defaultAudience: string })[] }>('/whatsapp/events') });
  const templates = useQuery({ queryKey: ['wa-templates'], queryFn: () => api.get<{ items: WaTemplate[] }>('/whatsapp/templates') });
  const update = useMutation({
    mutationFn: (v: { key: string; enabled: boolean; templateId: string | null }) => api.put(`/whatsapp/events/${v.key}`, { enabled: v.enabled, templateId: v.templateId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['wa-events'] }),
  });
  const active = (templates.data?.items ?? []).filter((t) => t.is_active);
  const groups = ['monitoring', 'queue', 'operations'] as const;

  return (
    <section className="card wa-section" aria-labelledby="wa-events-h">
      <div className="wa-section-head"><div><h2 id="wa-events-h">أنواع التنبيهات</h2>
        <p>فعّل كل نوع على حدة واختر قالبه. يُرسل التنبيه فقط إذا كان قالبه معتمدًا من Meta.</p></div></div>
      <div className="wa-note"><Info size={16} aria-hidden="true" />
        <span>«جزئي» يعني أن المصدر المتوفر في المنصة أضيق من اسم التنبيه (التفاصيل تحت كل نوع). «غير متوفر» لا يسجّله النظام بعد ويحتاج تطويرًا قبل تفعيله.</span></div>
      {update.error && <p className="text-xs text-(--status-danger)" role="alert">{(update.error as ApiError).message}</p>}
      <AsyncState loading={events.isLoading || templates.isLoading} error={events.error ?? templates.error} onRetry={() => { events.refetch(); templates.refetch(); }}>
        {groups.map((g) => (
          <div key={g} className="wa-event-group">
            <h3>{WHATSAPP_GROUP_LABELS[g]}</h3>
            {(events.data?.items ?? []).filter((e) => e.group === g).map((e) => {
              const unavailable = e.availability === 'unavailable';
              const tpl = active.find((t) => t.id === e.templateId);
              return (
                <div key={e.key} className={`wa-event ${unavailable ? 'is-unavailable' : ''}`}>
                  <div className="min-w-0">
                    <div className="wa-event-title">{e.label}
                      {e.availability === 'partial' && <Badge tone="info">جزئي</Badge>}
                      {unavailable && <Badge tone="neutral">غير متوفر</Badge>}
                      {!e.optional && <Badge tone="warning">إلزامي للمستلم</Badge>}
                    </div>
                    <div className="wa-event-note">{e.note}</div>
                    {!unavailable && <div className="wa-event-note">المستلمون: {e.routes ? `${e.routes} مسار توجيه` : `افتراضيًا ${DEFAULT_AUDIENCE[e.defaultAudience] ?? AUDIENCE_LABELS[e.defaultAudience]}`}
                      {tpl && <> · القالب: <bdi dir="ltr">{tpl.name}</bdi> <Badge tone={TEMPLATE_TONE[tpl.meta_status]}>{TEMPLATE_STATUS_LABELS[tpl.meta_status as TemplateMetaStatus]}</Badge></>}</div>}
                  </div>
                  {!unavailable && (
                    <div className="wa-event-controls">
                      <select className="input" aria-label={`قالب «${e.label}»`} disabled={!access.configure || update.isPending} value={e.templateId ?? ''}
                        onChange={(ev) => update.mutate({ key: e.key, enabled: e.enabled && !!ev.target.value, templateId: ev.target.value || null })}>
                        <option value="">— بلا قالب —</option>
                        {active.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.language}){t.meta_status !== 'approved' ? ' · غير معتمد' : ''}</option>)}
                      </select>
                      <label className="wa-switch">
                        <input type="checkbox" checked={e.enabled} disabled={!access.configure || update.isPending || !e.templateId}
                          onChange={(ev) => update.mutate({ key: e.key, enabled: ev.target.checked, templateId: e.templateId })} />
                        <span className="wa-switch-track" aria-hidden="true" />
                        <span>{e.enabled ? 'مفعّل' : 'معطّل'}</span>
                      </label>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </AsyncState>
    </section>
  );
}
