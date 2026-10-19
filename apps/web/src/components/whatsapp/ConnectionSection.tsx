import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Copy, Info, Pause, Play, Power, ShieldCheck } from 'lucide-react';
import { WHATSAPP_INTEGRATION_LABELS, WHATSAPP_PERMISSIONS as W } from '@mip/shared';
import { api, type ApiError } from '../../lib/api';
import { fmtDateTime, fmtNum, fmtRelative } from '../../lib/format';
import { useConfirmAction } from '../ConfirmAction';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { STATE_TONE, type WaAccess, type WaSettings, type WaStats } from './types';

interface VerifyResult { ok: boolean; step: string; phone?: { displayPhoneNumber?: string; verifiedName?: string; qualityRating?: string }; templates?: { total: number; approved: number } | null; error?: { message: string; code: string } | null }

const numOrNull = (v: string) => (v.trim() === '' ? null : Number(v));

/** Connection, health, operating controls and usage. Secrets are write-only fields. */
export default function ConnectionSection({ access, settings }: { access: WaAccess; settings: WaSettings }) {
  const qc = useQueryClient();
  const confirmation = useConfirmAction();
  const refresh = () => qc.invalidateQueries({ queryKey: ['wa-settings'] });
  const stats = useQuery({ queryKey: ['wa-stats'], queryFn: () => api.get<WaStats>('/whatsapp/stats'), enabled: access.view || access.log, refetchInterval: 30_000 });

  const [form, setForm] = useState(() => toForm(settings));
  useEffect(() => setForm(toForm(settings)), [settings]);
  const [copied, setCopied] = useState(false);

  const save = useMutation({
    mutationFn: () => api.put<WaSettings>('/whatsapp/settings', {
      wabaId: form.wabaId || null, phoneNumberId: form.phoneNumberId || null, apiVersion: form.apiVersion || null,
      ...(form.accessToken ? { accessToken: form.accessToken } : {}), ...(form.appSecret ? { appSecret: form.appSecret } : {}),
      ...(form.verifyToken ? { verifyToken: form.verifyToken } : {}),
      limits: { maxPerMinute: Number(form.maxPerMinute), dailyLimit: numOrNull(form.dailyLimit), monthlyLimit: numOrNull(form.monthlyLimit),
        maxAttempts: Number(form.maxAttempts), backoffBaseSeconds: Number(form.backoffBase), backoffMaxSeconds: Number(form.backoffMax), retentionMinutes: Number(form.retention) },
      thresholds: { overdueDigestMinutes: Number(form.overdueDigest), negativeMinFollowers: Number(form.negativeMin), newsFailuresPerHour: Number(form.newsFailures), quotaAlertPercent: Number(form.quotaPercent) },
      costEstimate: form.costPer.trim() ? { perMessage: Number(form.costPer), currency: form.costCurrency.trim().toUpperCase() || 'USD' } : null,
    }),
    onSuccess: () => { setForm((f) => ({ ...f, accessToken: '', appSecret: '', verifyToken: '' })); refresh(); },
  });
  const verify = useMutation({ mutationFn: () => api.post<VerifyResult>('/whatsapp/settings/verify'), onSuccess: refresh });
  const channel = useMutation({ mutationFn: (b: { enabled?: boolean; paused?: boolean }) => api.post<WaSettings>('/whatsapp/channel', b), onSuccess: refresh });

  const s = settings;
  const configured = s.state !== 'not_configured';
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(); };
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="space-y-4">
      {confirmation.dialog}
      <section className="card wa-section" aria-labelledby="wa-status-h">
        <div className="wa-section-head">
          <div>
            <h2 id="wa-status-h">حالة التكامل</h2>
            <p>واجهة واتساب للأعمال الرسمية من Meta (Cloud API). لا يُرسل شيء إلا بقالب معتمد ولمستلم وافق على الاستقبال.</p>
          </div>
          <Badge tone={STATE_TONE[s.state]} dot>{WHATSAPP_INTEGRATION_LABELS[s.state]}</Badge>
        </div>
        {!s.serverSendingEnabled && (
          <div className="wa-note is-warning" role="status"><AlertTriangle size={16} aria-hidden="true" />
            <span>الإرسال معطّل على مستوى الخادم (WHATSAPP_ENABLED). يمكن الإعداد والتحقق، ولن تُرسل أي رسالة قبل تفعيله في خطوة تشغيل منفصلة معتمدة.</span></div>
        )}
        {s.lastErrorMessage && s.state === 'error' && (
          <div className="wa-note is-danger" role="alert"><AlertTriangle size={16} aria-hidden="true" />
            <span>آخر خطأ: {s.lastErrorMessage} <span className="wa-code">({s.lastErrorCode})</span>{s.lastErrorAt && <> · {fmtRelative(s.lastErrorAt)}</>}</span></div>
        )}
        <dl className="wa-facts">
          <div><dt>الرقم المسجّل لدى Meta</dt><dd>{s.displayPhoneNumber ? <bdi dir="ltr">{s.displayPhoneNumber}</bdi> : '—'}{s.verifiedName && <span className="muted"> · {s.verifiedName}</span>}</dd></div>
          <div><dt>آخر تحقق ناجح</dt><dd>{s.lastVerifiedAt && s.lastVerifiedOk ? fmtDateTime(s.lastVerifiedAt) : s.lastVerifiedOk === false ? 'فشل آخر تحقق' : 'لم يُتحقق بعد'}</dd></div>
          <div><dt>التحقق من رابط الاستقبال (Webhook)</dt><dd>{s.webhookVerifiedAt ? `تم ${fmtRelative(s.webhookVerifiedAt)}` : 'لم يُتحقق بعد'}</dd></div>
          <div><dt>آخر إشعار حالة من Meta</dt><dd>{s.lastWebhookAt ? fmtRelative(s.lastWebhookAt) : '—'}</dd></div>
        </dl>
        <div>
          <div className="text-xs muted mb-1">رابط الاستقبال الذي يُسجَّل في إعدادات تطبيق Meta</div>
          <div className="wa-copy"><code>{s.webhookUrl}</code>
            <Button variant="ghost" size="sm" icon={<Copy size={14} aria-hidden="true" />} onClick={() => navigator.clipboard?.writeText(s.webhookUrl).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {})}>
              {copied ? 'نُسخ' : 'نسخ'}</Button></div>
        </div>
        {(access.toggle || access.configure) && (
          <div className="flex flex-wrap gap-2">
            {access.configure && (
              <Button variant="ghost" icon={<ShieldCheck size={16} aria-hidden="true" />} loading={verify.isPending} disabled={!configured} onClick={() => verify.mutate()}>
                التحقق من الاتصال دون إرسال</Button>)}
            {access.toggle && (s.enabled
              ? <>
                  <Button variant="ghost" icon={s.paused ? <Play size={16} aria-hidden="true" /> : <Pause size={16} aria-hidden="true" />} loading={channel.isPending}
                    onClick={() => channel.mutate({ paused: !s.paused })}>{s.paused ? 'استئناف الإرسال' : 'إيقاف الإرسال مؤقتًا'}</Button>
                  <Button variant="danger" icon={<Power size={16} aria-hidden="true" />} onClick={() => confirmation.request({
                    title: 'تعطيل قناة واتساب', description: 'يتوقف رصد أحداث واتساب وإرسالها. لا يتأثر تيليجرام ولا البريد ولا بقية المنصة. الرسائل المنتظرة تُلغى عند انتهاء صلاحيتها.',
                    confirmLabel: 'تعطيل القناة', danger: true, allowed: (can) => can(W.TOGGLE), execute: () => channel.mutateAsync({ enabled: false }) })}>تعطيل القناة</Button>
                </>
              : <Button variant="primary" icon={<Power size={16} aria-hidden="true" />} disabled={!configured} onClick={() => confirmation.request({
                  title: 'تفعيل قناة واتساب', description: 'يبدأ رصد أنواع التنبيهات المفعّلة من هذه اللحظة (لا تُرسل أحداث سابقة). الإرسال الفعلي يتطلب أيضًا تفعيل الخادم وقوالب معتمدة ومستلمين موافقين.',
                  confirmLabel: 'تفعيل القناة', allowed: (can) => can(W.TOGGLE), execute: () => channel.mutateAsync({ enabled: true }) })}>تفعيل القناة</Button>)}
          </div>
        )}
        {verify.data && (
          <div className={`wa-note ${verify.data.ok ? '' : 'is-danger'}`} role="status">
            {verify.data.ok ? <CheckCircle2 size={16} aria-hidden="true" /> : <AlertTriangle size={16} aria-hidden="true" />}
            <span>{verify.data.ok
              ? <>الاتصال سليم: {verify.data.phone?.verifiedName ?? 'الرقم'} {verify.data.phone?.displayPhoneNumber && <bdi dir="ltr">({verify.data.phone.displayPhoneNumber})</bdi>}{verify.data.phone?.qualityRating && <> · تقييم الجودة {verify.data.phone.qualityRating}</>} · القوالب لدى Meta: {verify.data.templates?.total ?? 0}، المعتمد منها {verify.data.templates?.approved ?? 0}.</>
              : <>فشل التحقق ({verify.data.step === 'phone_number' ? 'معرّف الرقم أو الرمز' : 'قائمة القوالب'}): {verify.data.error?.message}</>}</span>
          </div>
        )}
        {(verify.error || channel.error) && <p className="text-xs text-(--status-danger)" role="alert">{((verify.error ?? channel.error) as ApiError).message}</p>}
      </section>

      {stats.data && (
        <section className="card wa-section" aria-labelledby="wa-usage-h">
          <h2 id="wa-usage-h">الاستهلاك</h2>
          <div className="wa-kpis">
            <div className="wa-kpi"><span>قُبلت اليوم</span><strong>{fmtNum(stats.data.today_accepted)}{stats.data.limits.daily ? <span className="muted"> / {fmtNum(stats.data.limits.daily)}</span> : null}</strong></div>
            <div className="wa-kpi"><span>فشلت اليوم</span><strong>{fmtNum(stats.data.today_failed)}</strong></div>
            <div className="wa-kpi"><span>قُبلت هذا الشهر</span><strong>{fmtNum(stats.data.month_accepted)}{stats.data.limits.monthly ? <span className="muted"> / {fmtNum(stats.data.limits.monthly)}</span> : null}</strong></div>
            <div className="wa-kpi"><span>سُلّمت هذا الشهر</span><strong>{fmtNum(stats.data.month_delivered)}</strong></div>
            <div className="wa-kpi"><span>بانتظار الإرسال</span><strong>{fmtNum(stats.data.queued)}</strong></div>
          </div>
          {stats.data.costEstimate
            ? <div className="wa-note"><Info size={16} aria-hidden="true" /><span>تكلفة تقديرية هذا الشهر: <bdi>{stats.data.costEstimate.amount} {stats.data.costEstimate.currency}</bdi> — {stats.data.costEstimate.basis}.</span></div>
            : <div className="wa-note"><Info size={16} aria-hidden="true" /><span>لا تُعرض تكلفة: لم يُدخل سعر تقديري. التكلفة الفعلية تظهر في فواتير Meta وتختلف حسب فئة الرسالة والدولة.</span></div>}
          <p className="text-xs muted">«قُبلت» تعني أن Meta استلمت الطلب، وليست دليلًا على وصول الرسالة. التسليم والقراءة يُحدَّثان من إشعارات Meta.</p>
        </section>
      )}

      {access.configure && (
        <form className="card wa-section" onSubmit={submit} aria-labelledby="wa-config-h">
          <div className="wa-section-head"><div><h2 id="wa-config-h">إعداد الاتصال والتشغيل</h2>
            <p>الرموز السرية تُحفظ مشفّرة ولا تُعرض بعد الحفظ. اترك حقل الرمز فارغًا للإبقاء على القيمة المحفوظة.</p></div></div>
          <div className="wa-form">
            <Field label="معرّف حساب واتساب للأعمال (WABA ID)"><input className="input" inputMode="numeric" dir="ltr" value={form.wabaId} onChange={set('wabaId')} /></Field>
            <Field label="معرّف رقم الهاتف (Phone Number ID)"><input className="input" inputMode="numeric" dir="ltr" value={form.phoneNumberId} onChange={set('phoneNumberId')} /></Field>
            <Field label="إصدار Graph API" hint="مثل v21.0 — استخدم إصدارًا تدعمه Meta حاليًا"><input className="input" dir="ltr" value={form.apiVersion} onChange={set('apiVersion')} placeholder="v21.0" /></Field>
            <Field label="رمز الوصول (Access Token)" hint={s.accessTokenSet ? `محفوظ، ينتهي بـ ${s.accessTokenLast4}` : 'غير محفوظ'}>
              <input className="input" type="password" autoComplete="off" dir="ltr" value={form.accessToken} onChange={set('accessToken')} placeholder={s.accessTokenSet ? '••••••••' : ''} /></Field>
            <Field label="سر التطبيق (App Secret) للتحقق من توقيع الإشعارات" hint={s.appSecretSet ? 'محفوظ' : 'غير محفوظ — لن تُقبل إشعارات Meta بدونه'}>
              <input className="input" type="password" autoComplete="off" dir="ltr" value={form.appSecret} onChange={set('appSecret')} placeholder={s.appSecretSet ? '••••••••' : ''} /></Field>
            <Field label="رمز التحقق من رابط الاستقبال (Verify Token)" hint={s.verifyTokenSet ? 'محفوظ' : 'نص سري تختاره وتُدخله أيضًا في إعدادات Meta (16 حرفًا على الأقل)'}>
              <input className="input" type="password" autoComplete="off" dir="ltr" value={form.verifyToken} onChange={set('verifyToken')} placeholder={s.verifyTokenSet ? '••••••••' : ''} /></Field>
          </div>
          <h3 className="text-sm">حدود الإرسال وإعادة المحاولة</h3>
          <div className="wa-form">
            <Field label="الحد الأقصى في الدقيقة"><input className="input" type="number" min={1} max={1000} value={form.maxPerMinute} onChange={set('maxPerMinute')} /></Field>
            <Field label="الحد اليومي" hint="فارغ = بلا حد"><input className="input" type="number" min={1} value={form.dailyLimit} onChange={set('dailyLimit')} /></Field>
            <Field label="الحد الشهري" hint="فارغ = بلا حد"><input className="input" type="number" min={1} value={form.monthlyLimit} onChange={set('monthlyLimit')} /></Field>
            <Field label="أقصى عدد للمحاولات"><input className="input" type="number" min={1} max={10} value={form.maxAttempts} onChange={set('maxAttempts')} /></Field>
            <Field label="انتظار أول إعادة (ثانية)"><input className="input" type="number" min={5} max={3600} value={form.backoffBase} onChange={set('backoffBase')} /></Field>
            <Field label="أقصى انتظار (ثانية)"><input className="input" type="number" min={30} max={86400} value={form.backoffMax} onChange={set('backoffMax')} /></Field>
            <Field label="صلاحية الإشعار قبل الإلغاء (دقيقة)" hint="لا يُرسل إشعار متأخر بعدها، ولو كانت القناة موقوفة مؤقتًا"><input className="input" type="number" min={5} max={10080} value={form.retention} onChange={set('retention')} /></Field>
          </div>
          <h3 className="text-sm">عتبات التنبيهات المشتقة</h3>
          <div className="wa-form">
            <Field label="فترة ملخص التذاكر المتأخرة (دقيقة)"><input className="input" type="number" min={30} value={form.overdueDigest} onChange={set('overdueDigest')} /></Field>
            <Field label="حد المتابعين للمحتوى السلبي"><input className="input" type="number" min={0} value={form.negativeMin} onChange={set('negativeMin')} /></Field>
            <Field label="مهام أخبار فاشلة في الساعة"><input className="input" type="number" min={1} value={form.newsFailures} onChange={set('newsFailures')} /></Field>
            <Field label="نسبة التنبيه من حد إكس الشهري (%)"><input className="input" type="number" min={1} max={100} value={form.quotaPercent} onChange={set('quotaPercent')} /></Field>
          </div>
          <h3 className="text-sm">التكلفة التقديرية (اختياري)</h3>
          <div className="wa-form">
            <Field label="سعر تقديري لكل رسالة" hint="يُدخل يدويًا من تسعير Meta المعتمد لحسابكم؛ يُعرض كتقدير فقط"><input className="input" type="number" min={0} step="0.0001" dir="ltr" value={form.costPer} onChange={set('costPer')} /></Field>
            <Field label="العملة"><input className="input" dir="ltr" maxLength={3} value={form.costCurrency} onChange={set('costCurrency')} placeholder="USD" /></Field>
          </div>
          {save.error && <p className="text-xs text-(--status-danger)" role="alert">{(save.error as ApiError).message}</p>}
          {save.isSuccess && !save.isPending && <p className="text-xs text-(--status-success)" role="status">حُفظت الإعدادات.</p>}
          <div><Button variant="primary" type="submit" loading={save.isPending}>حفظ الإعدادات</Button></div>
        </form>
      )}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactElement }) {
  return <label className="block mb-3"><span className="block text-sm mb-1">{label}</span>{children}{hint && <span className="block text-xs muted mt-1">{hint}</span>}</label>;
}

function toForm(s: WaSettings) {
  return {
    wabaId: s.wabaId ?? '', phoneNumberId: s.phoneNumberId ?? '', apiVersion: s.apiVersion ?? '', accessToken: '', appSecret: '', verifyToken: '',
    maxPerMinute: String(s.limits.maxPerMinute), dailyLimit: s.limits.dailyLimit?.toString() ?? '', monthlyLimit: s.limits.monthlyLimit?.toString() ?? '',
    maxAttempts: String(s.limits.maxAttempts), backoffBase: String(s.limits.backoffBaseSeconds), backoffMax: String(s.limits.backoffMaxSeconds), retention: String(s.limits.retentionMinutes),
    overdueDigest: String(s.thresholds.overdueDigestMinutes), negativeMin: String(s.thresholds.negativeMinFollowers), newsFailures: String(s.thresholds.newsFailuresPerHour), quotaPercent: String(s.thresholds.quotaAlertPercent),
    costPer: s.costEstimate ? String(s.costEstimate.perMessage) : '', costCurrency: s.costEstimate?.currency ?? '',
  };
}
