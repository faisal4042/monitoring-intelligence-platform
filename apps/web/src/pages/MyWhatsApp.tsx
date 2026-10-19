import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellOff, CheckCircle2, Info, MessageCircle } from 'lucide-react';
import { WHATSAPP_GROUP_LABELS } from '@mip/shared';
import { api, type ApiError } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import AsyncState from '../components/AsyncState';
import { useConfirmAction } from '../components/ConfirmAction';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { OPT_IN_LABEL, type WaRecipient } from '../components/whatsapp/types';
import '../components/whatsapp/whatsapp.css';

interface Sub { eventType: string; label: string; group: 'monitoring' | 'queue' | 'operations'; optional: boolean; enabled: boolean }
interface Me { registered: boolean; phone?: string; optInStatus?: WaRecipient['opt_in_status']; optInAt?: string | null; isActive?: boolean; subscriptions?: Sub[] }

/** The employee's own WhatsApp alerts: consent, opt-out, and which optional alerts to receive. */
export default function MyWhatsApp() {
  const qc = useQueryClient();
  const confirmation = useConfirmAction();
  const me = useQuery({ queryKey: ['wa-me'], queryFn: () => api.get<Me>('/whatsapp/me'), retry: false });
  const refresh = () => qc.invalidateQueries({ queryKey: ['wa-me'] });
  const optIn = useMutation({ mutationFn: () => api.post('/whatsapp/me/opt-in'), onSuccess: refresh });
  const optOut = useMutation({ mutationFn: () => api.post('/whatsapp/me/opt-out'), onSuccess: refresh });
  const [draft, setDraft] = useState<Record<string, boolean>>({});
  const save = useMutation({
    mutationFn: () => api.put('/whatsapp/me/subscriptions', { subscriptions: Object.entries(draft).map(([eventType, enabled]) => ({ eventType, enabled })) }),
    onSuccess: () => { setDraft({}); refresh(); },
  });
  const notInstalled = (me.error as ApiError | null)?.code === 'WHATSAPP_NOT_INSTALLED';
  const d = me.data;
  const error = optIn.error ?? optOut.error ?? save.error;

  return (
    <div className="space-y-5 max-w-4xl">
      {confirmation.dialog}
      <div className="page-heading"><div>
        <h1 className="flex items-center gap-2.5"><MessageCircle size={22} className="text-brand-600" aria-hidden="true" /> تنبيهاتي على واتساب</h1>
        <p>رسائل العمل التي تصلك من المنصة على واتساب: موافقتك، وإيقافها، واختيار التنبيهات الاختيارية.</p>
      </div></div>
      {notInstalled ? (
        <div className="card wa-section"><div className="wa-note"><Info size={16} aria-hidden="true" /><span>تنبيهات واتساب غير متاحة في المنصة حاليًا.</span></div></div>
      ) : (
        <AsyncState loading={me.isLoading} error={me.error} onRetry={() => me.refetch()}>
          {d && !d.registered && (
            <div className="card wa-section"><div className="wa-note"><Info size={16} aria-hidden="true" />
              <span>لم يُسجَّل رقم واتساب لحسابك. إذا كان عملك يتطلب استقبال التنبيهات، اطلب من مسؤول الإشعارات تسجيل رقمك.</span></div></div>
          )}
          {d?.registered && (
            <>
              <section className="card wa-section" aria-labelledby="me-wa-h">
                <div className="wa-section-head">
                  <div><h2 id="me-wa-h">رقمك وموافقتك</h2>
                    <p>الرقم المسجّل: <bdi dir="ltr" className="num">{d.phone}</bdi>{d.optInStatus === 'opted_in' && d.optInAt && <> · وافقت في {fmtDateTime(d.optInAt)}</>}</p></div>
                  {d.optInStatus && <Badge tone={OPT_IN_LABEL[d.optInStatus].tone} dot>{OPT_IN_LABEL[d.optInStatus].label}</Badge>}
                </div>
                {d.optInStatus !== 'opted_in'
                  ? <div className="space-y-3">
                      <p className="text-sm muted">بالموافقة تقبل استقبال رسائل العمل من المنصة على هذا الرقم عبر واتساب. يمكنك إلغاؤها في أي وقت من هنا أو بإرسال «إيقاف» ردًا على أي رسالة.</p>
                      <Button variant="primary" icon={<CheckCircle2 size={16} aria-hidden="true" />} loading={optIn.isPending} onClick={() => optIn.mutate()}>أوافق على استقبال الرسائل</Button>
                    </div>
                  : <Button variant="ghost" icon={<BellOff size={16} aria-hidden="true" />} onClick={() => confirmation.request({
                      title: 'إيقاف رسائل واتساب', description: 'لن تصلك أي رسالة من المنصة على واتساب، بما فيها التنبيهات الإلزامية، حتى توافق مجددًا.',
                      confirmLabel: 'إيقاف الرسائل', danger: true, allowed: () => true, execute: () => optOut.mutateAsync() })}>إيقاف كل الرسائل</Button>}
              </section>
              <section className="card wa-section" aria-labelledby="me-subs-h">
                <div><h2 id="me-subs-h">التنبيهات التي تصلني</h2>
                  <p className="text-sm muted mt-1">يمكنك إيقاف التنبيهات الاختيارية. التنبيهات الإلزامية جزء من مهام العمل التشغيلية ولا يمكن إيقافها إلا بإيقاف كل الرسائل.</p></div>
                {(['monitoring', 'queue', 'operations'] as const).map((g) => {
                  const subs = (d.subscriptions ?? []).filter((s) => s.group === g);
                  if (!subs.length) return null;
                  return (
                    <div key={g} className="wa-event-group"><h3>{WHATSAPP_GROUP_LABELS[g]}</h3>
                      <div className="wa-subs">{subs.map((s) => {
                        const on = !s.optional ? true : draft[s.eventType] ?? s.enabled;
                        return (
                          <div key={s.eventType} className="wa-sub"><span>{s.label}{!s.optional && <span className="text-xs muted"> · إلزامي</span>}</span>
                            <label className="wa-switch"><input type="checkbox" checked={on} disabled={!s.optional || d.optInStatus !== 'opted_in'} aria-label={s.label}
                              onChange={(e) => setDraft((x) => ({ ...x, [s.eventType]: e.target.checked }))} /><span className="wa-switch-track" aria-hidden="true" /></label></div>
                        );
                      })}</div>
                    </div>
                  );
                })}
                <div><Button variant="primary" loading={save.isPending} disabled={!Object.keys(draft).length} onClick={() => save.mutate()}>حفظ اختياراتي</Button></div>
              </section>
            </>
          )}
          {error && <p className="text-xs text-(--status-danger)" role="alert">{(error as ApiError).message}</p>}
        </AsyncState>
      )}
    </div>
  );
}
