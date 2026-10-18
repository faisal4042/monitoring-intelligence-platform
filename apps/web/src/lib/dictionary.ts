import { PERMISSIONS } from '@mip/shared';

/** Keyword group types, in the order the dictionary shows them. */
export const GROUP_TYPES = ['primary', 'service', 'related', 'negative', 'sensitive'] as const;
export type GroupType = (typeof GROUP_TYPES)[number];

export const GROUP_TYPE_LABELS: Record<GroupType, string> = {
  primary: 'أساسية', service: 'خدمات', related: 'مرتبطة', negative: 'مستبعدة', sensitive: 'حساسة',
};

export interface QueryRowState {
  status: string;
  is_paused: boolean;
  is_system: boolean;
  deleted_at: string | null;
  resume_to: 'active' | 'draft';
}

export interface QueryActions {
  edit: boolean; pause: boolean; resume: boolean; remove: boolean; collect: boolean; test: boolean;
  /** Why resume is unavailable although the query is paused (shown as a hint). */
  resumeBlockedReason: string | null;
}

type Can = (...permissions: string[]) => boolean;

/**
 * Which actions a query row offers. System queries are owned by the dictionary sync:
 * they can be paused and resumed, never edited or deleted by hand. Deleted rows are read-only.
 */
export function queryActions(q: QueryRowState, can: Can): QueryActions {
  const write = can(PERMISSIONS.QUERIES_WRITE);
  const deleted = q.deleted_at !== null;
  const paused = q.status === 'paused';
  const resumeNeedsPromote = q.resume_to === 'active';
  const mayResume = write && (!resumeNeedsPromote || can(PERMISSIONS.QUERY_PROMOTE));
  return {
    edit: write && !deleted && !q.is_system,
    pause: write && !deleted && q.status === 'active',
    resume: !deleted && paused && mayResume,
    remove: write && !deleted && !q.is_system,
    collect: write && !deleted && q.status === 'active' && !q.is_paused,
    test: !deleted,
    resumeBlockedReason: !deleted && paused && write && !mayResume ? 'الاستئناف يتطلب صلاحية ترقية الاستعلامات' : null,
  };
}

export function queryStateLabel(q: Pick<QueryRowState, 'status' | 'deleted_at'>): { text: string; tone: 'ok' | 'warn' | 'muted' | 'info' | 'danger' } {
  if (q.deleted_at) return { text: 'محذوف منطقيًا', tone: 'danger' };
  switch (q.status) {
    case 'active': return { text: 'نشط', tone: 'ok' };
    case 'paused': return { text: 'موقوف', tone: 'warn' };
    case 'tested': return { text: 'مُختبَر', tone: 'info' };
    case 'approved': return { text: 'معتمد', tone: 'info' };
    case 'archived': return { text: 'مؤرشف', tone: 'muted' };
    default: return { text: 'مسودة', tone: 'muted' };
  }
}

/** Text of the resume confirmation: where the query goes, and what that means. */
export function resumeDescription(name: string, q: Pick<QueryRowState, 'resume_to' | 'is_system'>): string {
  if (q.resume_to === 'active') {
    return q.is_system
      ? `سيعود «${name}» نشطًا ويستأنف الجمع التلقائي في الدورة التالية، ما قد يستهلك حصة X.`
      : `اجتاز «${name}» اختبار الدقة سابقًا، فسيعود نشطًا ويستأنف الجمع، ما قد يستهلك حصة X.`;
  }
  return `لم يجتز «${name}» اختبار الدقة بعد، فسيعود مسودة ولن يُجمع حتى يُختبر ويُرقّى.`;
}

/** Programs show only their own groups: grouping is by id, never by the shared Arabic name. */
export function groupsForProgram<T extends { program_id: string | null }>(groups: readonly T[], programId: string): T[] {
  return programId ? groups.filter((g) => g.program_id === programId) : [...groups];
}
