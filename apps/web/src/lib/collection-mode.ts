const MODES: Record<string, { text: string; cls: string; title: string }> = {
  demo: { text: 'وضع تجريبي', cls: 'status-pill--info', title: 'لا يوجد اتصال بـ X API في الوضع التجريبي' },
  dry_run: { text: 'تشغيل جاف', cls: 'status-pill--warning', title: 'الطلبات لا تُرسل إلى X في التشغيل الجاف' },
  live: { text: 'تشغيل حي', cls: 'status-pill--success', title: 'طلبات حقيقية تستهلك حصة فعلية' },
};
export function collectionModeBadge(mode?: string | null, failed = false) {
  if (failed) return { text: 'تعذر التحقق', cls: 'status-pill--warning', title: 'تعذر التحقق من وضع التشغيل الحالي' };
  return mode && Object.hasOwn(MODES, mode) ? MODES[mode]
    : { text: 'غير متاح', cls: 'status-pill--info', title: 'معلومات وضع التشغيل غير متاحة' };
}
