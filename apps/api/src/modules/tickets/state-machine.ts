/**
 * Ticket lifecycle. Pure: no I/O, used by the API, the ingestion path and the tests.
 * Active = every status except `closed`. A closed ticket never becomes active again through messaging:
 * new customer messages after close open a NEW ticket (see ingestion.ts). The only way back is the audited
 * `admin_correction` action (tickets:manage), which keeps the ticket number and never pulls in newer messages.
 */
export const TICKET_STATUSES = ['open', 'assigned', 'in_progress', 'pending', 'escalated', 'resolved', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const ACTIVE_STATUSES: TicketStatus[] = TICKET_STATUSES.filter((s) => s !== 'closed');
export const isActive = (s: TicketStatus) => s !== 'closed';

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  open: 'مفتوحة غير مسندة', assigned: 'مسندة', in_progress: 'قيد المعالجة', pending: 'معلقة بانتظار العميل',
  escalated: 'مصعّدة', resolved: 'محلولة', closed: 'مغلقة',
};

/** Who may run an action: `assign` (tickets:assign), `owner` (tickets:work and assignee), `manage` (tickets:manage). */
type Gate = 'assign' | 'owner' | 'owner_or_assign' | 'self_claim' | 'manage';
export interface ActionRule { from: TicketStatus[]; to: TicketStatus | 'same'; gate: Gate; reason: boolean; needsAssignee?: boolean; event: string }
export const TICKET_ACTIONS = {
  claim:            { from: ['open'], to: 'assigned', gate: 'self_claim', reason: false, event: 'assigned' },
  assign:           { from: ['open'], to: 'assigned', gate: 'assign', reason: false, needsAssignee: true, event: 'assigned' },
  reassign:         { from: ['assigned', 'in_progress', 'pending', 'escalated', 'resolved'], to: 'assigned', gate: 'assign', reason: false, needsAssignee: true, event: 'reassigned' },
  unassign:         { from: ['assigned'], to: 'open', gate: 'assign', reason: false, event: 'unassigned' },
  start:            { from: ['assigned', 'pending'], to: 'in_progress', gate: 'owner', reason: false, event: 'started' },
  reply:            { from: ['assigned', 'in_progress', 'pending', 'escalated'], to: 'in_progress', gate: 'owner', reason: false, event: 'replied' },
  hold:             { from: ['in_progress'], to: 'pending', gate: 'owner', reason: true, event: 'on_hold' },
  resume:           { from: ['pending'], to: 'in_progress', gate: 'owner', reason: false, event: 'resumed' },
  escalate:         { from: ['assigned', 'in_progress', 'pending'], to: 'escalated', gate: 'owner_or_assign', reason: true, event: 'escalated' },
  deescalate:       { from: ['escalated'], to: 'in_progress', gate: 'assign', reason: false, event: 'deescalated' },
  resolve:          { from: ['in_progress', 'pending', 'escalated'], to: 'resolved', gate: 'owner_or_assign', reason: false, event: 'resolved' },
  close:            { from: ['open', 'assigned', 'in_progress', 'pending', 'escalated', 'resolved'], to: 'closed', gate: 'owner_or_assign', reason: false, event: 'closed' },
  set_priority:     { from: ['open', 'assigned', 'in_progress', 'pending', 'escalated', 'resolved'], to: 'same', gate: 'assign', reason: false, event: 'priority_changed' },
  clear_review:     { from: [...TICKET_STATUSES], to: 'same', gate: 'manage', reason: true, event: 'review_cleared' },
  admin_correction: { from: ['closed'], to: 'in_progress', gate: 'manage', reason: true, needsAssignee: true, event: 'admin_correction' },
} satisfies Record<string, ActionRule>;
export type TicketAction = keyof typeof TICKET_ACTIONS;
export const TICKET_ACTION_LABELS: Record<TicketAction, string> = {
  claim: 'استلام', assign: 'إسناد', reassign: 'إعادة إسناد', unassign: 'إلغاء الإسناد', start: 'بدء المعالجة', reply: 'تسجيل رد',
  hold: 'تعليق', resume: 'استئناف', escalate: 'تصعيد', deescalate: 'إلغاء التصعيد', resolve: 'حل', close: 'إغلاق',
  set_priority: 'تغيير الأولوية', clear_review: 'إنهاء المراجعة', admin_correction: 'تصحيح إداري للإغلاق',
};

export interface Actor { id: string; perms: Set<string> }
export interface TicketLike { status: TicketStatus; assignee_id: string | null }
export type Decision = { ok: true; to: TicketStatus; event: string } | { ok: false; code: string; message: string };

/** Decides an action without touching the database. Close from `open` (never worked) requires a reason. */
export function decide(t: TicketLike, action: string, actor: Actor, input: { reason?: string; assigneeId?: string | null } = {}): Decision {
  const rule = (TICKET_ACTIONS as Record<string, ActionRule>)[action];
  if (!rule) return { ok: false, code: 'UNKNOWN_ACTION', message: 'إجراء غير معروف' };
  if (!rule.from.includes(t.status)) return { ok: false, code: 'INVALID_TRANSITION', message: `لا يمكن «${TICKET_ACTION_LABELS[action as TicketAction]}» من حالة «${TICKET_STATUS_LABELS[t.status]}»` };
  const can = (p: string) => actor.perms.has(p);
  const owner = t.assignee_id === actor.id && can('tickets:work');
  const allowed = rule.gate === 'assign' ? can('tickets:assign')
    : rule.gate === 'owner' ? owner
    : rule.gate === 'owner_or_assign' ? owner || can('tickets:assign')
    : rule.gate === 'self_claim' ? can('tickets:work')
    : can('tickets:manage');
  if (!allowed) return { ok: false, code: 'FORBIDDEN', message: 'لا تملك صلاحية هذا الإجراء على هذه التذكرة' };
  const needsReason = rule.reason || (action === 'close' && t.status === 'open');
  if (needsReason && !(input.reason ?? '').trim()) return { ok: false, code: 'REASON_REQUIRED', message: 'السبب مطلوب لهذا الإجراء' };
  if (rule.needsAssignee && !input.assigneeId) return { ok: false, code: 'ASSIGNEE_REQUIRED', message: 'حدد الموظف المسؤول' };
  if (action === 'reassign' && input.assigneeId === t.assignee_id) return { ok: false, code: 'SAME_ASSIGNEE', message: 'التذكرة مسندة لهذا الموظف بالفعل' };
  return { ok: true, to: rule.to === 'same' ? t.status : rule.to, event: rule.event };
}

/** Actions the actor could run now (for the UI); the API re-decides on every call. */
export function availableActions(t: TicketLike, actor: Actor): TicketAction[] {
  return (Object.keys(TICKET_ACTIONS) as TicketAction[]).filter((a) => {
    const d = decide(t, a, actor, { reason: 'x', assigneeId: a === 'reassign' ? '__other__' : actor.id });
    return d.ok || (d.code !== 'INVALID_TRANSITION' && d.code !== 'FORBIDDEN' && d.code !== 'UNKNOWN_ACTION');
  });
}

/** Status after an inbound customer message lands on an active ticket (never applied to closed tickets). */
export function statusAfterCustomerMessage(t: TicketLike): TicketStatus {
  if (t.status === 'pending' || t.status === 'resolved') return t.assignee_id ? 'in_progress' : 'open';
  return t.status;
}
