/**
 * Report catalogue. Column and filter expressions are server constants (never user input); a request
 * only selects keys from these lists. Times are stored in UTC and rendered in Asia/Riyadh (UTC+3, no DST).
 * A report is offered only when its data exists (`needs: 'tickets'` → migration 0047) and the caller holds
 * its data permission; KPIs without an approved definition are listed as unavailable, never invented.
 */
export type ColumnType = 'text' | 'id' | 'int' | 'number' | 'datetime' | 'minutes' | 'bool';
export interface ReportColumn {
  key: string; ar: string; en: string; type: ColumnType; expr: string; group: string; default?: boolean;
  /** Extra permission needed to see this column (content, personal data). */
  requires?: string;
}
export type FilterKey = 'program' | 'channel' | 'status' | 'assignee' | 'intent' | 'sentiment' | 'topic' | 'review' | 'section';
export interface ReportType {
  key: string; ar: string; en: string; descriptionAr: string; section: string;
  needs: 'core' | 'tickets';
  /** Any one of these data permissions (reports:read is always required as well). */
  dataPermissions: string[];
  /** Ticket reports are row-scoped like the ticket API (own + team unless tickets:read_all). */
  ticketScope?: string;
  from: string; dateExpr: string; dateLabelAr: string; orderBy: string;
  groupBy?: string;
  filters: Partial<Record<FilterKey, string>>;
  columns: ReportColumn[];
}

const minutes = (a: string, b: string) => `round((extract(epoch FROM (${b} - ${a})) / 60)::numeric, 1)`;
const TICKET_FROM = `tickets t
  JOIN customer_identities ci ON ci.id = t.customer_identity_id
  LEFT JOIN users ua ON ua.id = t.assignee_id
  LEFT JOIN users uc ON uc.id = t.closed_by
  LEFT JOIN programs pr ON pr.id = t.program_id
  LEFT JOIN topics tp ON tp.id = t.topic_id`;

export const REPORT_TYPES: ReportType[] = [
  {
    key: 'tickets', ar: 'تقرير التذاكر', en: 'Tickets', section: 'tickets', needs: 'tickets', ticketScope: 't',
    descriptionAr: 'تذكرة واحدة لكل صف: الحالة والمسؤول والأوقات والعدادات. الفترة على تاريخ فتح التذكرة.',
    dataPermissions: ['tickets:read', 'tickets:read_all'], from: TICKET_FROM, dateExpr: 't.opened_at', dateLabelAr: 'تاريخ فتح التذكرة',
    orderBy: 't.opened_at, t.id',
    filters: {program: 't.program_id', channel: 't.channel', status: 't.status', assignee: 't.assignee_id', intent: 't.intent', sentiment: 't.sentiment', topic: 't.topic_id', review: 't.needs_review'},
    columns: [
      {key: 'ticket_number', ar: 'رقم التذكرة', en: 'Ticket Number', type: 'id', expr: 't.ticket_number', group: 'ticket', default: true},
      {key: 'status', ar: 'الحالة', en: 'Status', type: 'text', expr: 't.status', group: 'ticket', default: true},
      {key: 'priority', ar: 'الأولوية', en: 'Priority', type: 'text', expr: 't.priority', group: 'ticket'},
      {key: 'channel', ar: 'القناة', en: 'Channel', type: 'text', expr: 't.channel', group: 'ticket', default: true},
      {key: 'program', ar: 'البرنامج', en: 'Program', type: 'text', expr: 'pr.name_ar', group: 'ticket', default: true},
      {key: 'customer_handle', ar: 'حساب العميل', en: 'Customer Handle', type: 'text', expr: 'ci.handle', group: 'customer', default: true, requires: 'customers:read'},
      {key: 'customer_provider_id', ar: 'معرف العميل لدى المزود', en: 'Customer Provider ID', type: 'id', expr: 'ci.provider_customer_id', group: 'customer', requires: 'customers:read'},
      {key: 'assignee', ar: 'الموظف المسؤول', en: 'Assignee', type: 'text', expr: 'ua.full_name', group: 'workflow', default: true},
      {key: 'opened_at', ar: 'وقت الفتح', en: 'Opened At', type: 'datetime', expr: 't.opened_at', group: 'times', default: true},
      {key: 'first_assigned_at', ar: 'أول إسناد', en: 'First Assigned At', type: 'datetime', expr: 't.first_assigned_at', group: 'times'},
      {key: 'first_response_at', ar: 'أول رد', en: 'First Response At', type: 'datetime', expr: 't.first_response_at', group: 'times', default: true},
      {key: 'last_response_at', ar: 'آخر رد', en: 'Last Response At', type: 'datetime', expr: 't.last_response_at', group: 'times'},
      {key: 'last_customer_message_at', ar: 'آخر رسالة من العميل', en: 'Last Customer Message At', type: 'datetime', expr: 't.last_customer_message_at', group: 'times'},
      {key: 'resolved_at', ar: 'وقت الحل', en: 'Resolved At', type: 'datetime', expr: 't.resolved_at', group: 'times'},
      {key: 'closed_at', ar: 'وقت الإغلاق', en: 'Closed At', type: 'datetime', expr: 't.closed_at', group: 'times', default: true},
      {key: 'closed_by', ar: 'أغلقها', en: 'Closed By', type: 'text', expr: 'uc.full_name', group: 'workflow'},
      {key: 'close_reason', ar: 'سبب الإغلاق', en: 'Close Reason', type: 'text', expr: 't.close_reason', group: 'workflow'},
      {key: 'message_count', ar: 'عدد الرسائل', en: 'Messages', type: 'int', expr: 't.message_count', group: 'counts', default: true},
      {key: 'customer_message_count', ar: 'رسائل العميل', en: 'Customer Messages', type: 'int', expr: 't.customer_message_count', group: 'counts'},
      {key: 'agent_message_count', ar: 'ردود الموظفين', en: 'Agent Replies', type: 'int', expr: 't.agent_message_count', group: 'counts'},
      {key: 'reassignment_count', ar: 'مرات إعادة الإسناد', en: 'Reassignments', type: 'int', expr: 't.reassignment_count', group: 'counts'},
      {key: 'escalation_count', ar: 'مرات التصعيد', en: 'Escalations', type: 'int', expr: 't.escalation_count', group: 'counts'},
      {key: 'first_response_minutes', ar: 'زمن أول رد (دقيقة)', en: 'First Response (min)', type: 'minutes', expr: minutes('t.opened_at', 't.first_response_at'), group: 'kpi', default: true},
      {key: 'assignment_wait_minutes', ar: 'انتظار الإسناد (دقيقة)', en: 'Assignment Wait (min)', type: 'minutes', expr: minutes('t.opened_at', 't.first_assigned_at'), group: 'kpi'},
      {key: 'close_tat_minutes', ar: 'زمن الإغلاق TAT (دقيقة)', en: 'Close TAT (min)', type: 'minutes', expr: minutes('t.opened_at', 't.closed_at'), group: 'kpi'},
      {key: 'needs_review', ar: 'تحتاج مراجعة', en: 'Needs Review', type: 'bool', expr: 't.needs_review', group: 'ticket'},
      {key: 'review_reason', ar: 'سبب المراجعة', en: 'Review Reason', type: 'text', expr: 't.review_reason', group: 'ticket'},
      {key: 'intent', ar: 'نوع التفاعل', en: 'Intent', type: 'text', expr: 't.intent', group: 'classification'},
      {key: 'sentiment', ar: 'المشاعر', en: 'Sentiment', type: 'text', expr: 't.sentiment', group: 'classification'},
      {key: 'topic', ar: 'الموضوع', en: 'Topic', type: 'text', expr: 'tp.name_ar', group: 'classification'},
    ],
  },
  {
    key: 'ticket_messages', ar: 'تقرير الرسائل', en: 'Messages', section: 'messages', needs: 'tickets', ticketScope: 't',
    descriptionAr: 'رسالة واحدة لكل صف مع رقم تذكرتها. عدد الصفوف = عدد الرسائل وليس عدد التذاكر. الفترة على وقت الرسالة.',
    dataPermissions: ['tickets:read', 'tickets:read_all'],
    from: `ticket_messages m JOIN tickets t ON t.id = m.ticket_id LEFT JOIN users ag ON ag.id = m.agent_id
      LEFT JOIN posts po ON po.id = m.post_id AND po.posted_at = m.post_posted_at LEFT JOIN programs pr ON pr.id = t.program_id`,
    dateExpr: 'm.event_at', dateLabelAr: 'وقت الرسالة', orderBy: 'm.event_at, m.id',
    filters: {program: 't.program_id', channel: 't.channel', status: 't.status', assignee: 't.assignee_id'},
    columns: [
      {key: 'ticket_number', ar: 'رقم التذكرة', en: 'Ticket Number', type: 'id', expr: 't.ticket_number', group: 'ticket', default: true},
      {key: 'message_id', ar: 'معرف الرسالة', en: 'Message ID', type: 'id', expr: 'm.provider_message_id', group: 'message', default: true},
      {key: 'provider', ar: 'المزود', en: 'Provider', type: 'text', expr: 'm.provider', group: 'message'},
      {key: 'channel', ar: 'القناة', en: 'Channel', type: 'text', expr: 't.channel', group: 'ticket', default: true},
      {key: 'program', ar: 'البرنامج', en: 'Program', type: 'text', expr: 'pr.name_ar', group: 'ticket'},
      {key: 'direction', ar: 'الاتجاه', en: 'Direction', type: 'text', expr: 'm.direction', group: 'message', default: true},
      {key: 'author_kind', ar: 'المرسل', en: 'Author Kind', type: 'text', expr: 'm.author_kind', group: 'message', default: true},
      {key: 'agent', ar: 'الموظف', en: 'Agent', type: 'text', expr: 'ag.full_name', group: 'message'},
      {key: 'event_at', ar: 'وقت الرسالة', en: 'Event At', type: 'datetime', expr: 'm.event_at', group: 'message', default: true},
      {key: 'received_at', ar: 'وقت الاستلام', en: 'Received At', type: 'datetime', expr: 'm.received_at', group: 'message'},
      {key: 'disposition', ar: 'وضع الربط', en: 'Disposition', type: 'text', expr: 'm.disposition', group: 'message'},
      {key: 'text', ar: 'نص الرسالة', en: 'Text', type: 'text', expr: 'COALESCE(m.body, po.text)', group: 'message', default: true, requires: 'customers:read'},
    ],
  },
  {
    key: 'ticket_activity', ar: 'سجل نشاط التذاكر', en: 'Ticket Activity', section: 'activity', needs: 'tickets', ticketScope: 't',
    descriptionAr: 'كل انتقال وإجراء على التذاكر بترتيبه: الفاعل والحالة السابقة والجديدة والسبب.',
    dataPermissions: ['tickets:read', 'tickets:read_all'],
    from: `ticket_events e JOIN tickets t ON t.id = e.ticket_id LEFT JOIN users ua ON ua.id = e.actor_id LEFT JOIN users ub ON ub.id = e.assignee_id`,
    dateExpr: 'e.occurred_at', dateLabelAr: 'وقت الإجراء', orderBy: 'e.occurred_at, e.ticket_id, e.version',
    filters: {program: 't.program_id', channel: 't.channel', status: 'e.to_status', assignee: 'e.assignee_id'},
    columns: [
      {key: 'ticket_number', ar: 'رقم التذكرة', en: 'Ticket Number', type: 'id', expr: 't.ticket_number', group: 'ticket', default: true},
      {key: 'version', ar: 'رقم الحدث', en: 'Version', type: 'int', expr: 'e.version', group: 'event', default: true},
      {key: 'event_type', ar: 'الإجراء', en: 'Event', type: 'text', expr: 'e.event_type', group: 'event', default: true},
      {key: 'from_status', ar: 'من حالة', en: 'From Status', type: 'text', expr: 'e.from_status', group: 'event', default: true},
      {key: 'to_status', ar: 'إلى حالة', en: 'To Status', type: 'text', expr: 'e.to_status', group: 'event', default: true},
      {key: 'actor_kind', ar: 'نوع الفاعل', en: 'Actor Kind', type: 'text', expr: 'e.actor_kind', group: 'event'},
      {key: 'actor', ar: 'الفاعل', en: 'Actor', type: 'text', expr: 'ua.full_name', group: 'event', default: true},
      {key: 'assignee', ar: 'المسؤول بعد الإجراء', en: 'Assignee After', type: 'text', expr: 'ub.full_name', group: 'event'},
      {key: 'reason', ar: 'السبب', en: 'Reason', type: 'text', expr: 'e.reason', group: 'event'},
      {key: 'occurred_at', ar: 'الوقت', en: 'Occurred At', type: 'datetime', expr: 'e.occurred_at', group: 'event', default: true},
      {key: 'correlation_id', ar: 'معرف الارتباط', en: 'Correlation ID', type: 'id', expr: 'e.correlation_id', group: 'event'},
    ],
  },
  {
    key: 'ticket_kpis', ar: 'مؤشرات أداء التذاكر', en: 'Ticket KPIs', section: 'performance', needs: 'tickets', ticketScope: 't',
    descriptionAr: 'لكل يوم (بتوقيت الرياض) وبرنامج: الحجم والمفتوح والمغلق وأزمنة الرد والإغلاق (الوسيط وp90). تعريفات المؤشرات في KPI Definitions.',
    dataPermissions: ['tickets:read_all'], from: TICKET_FROM, dateExpr: 't.opened_at', dateLabelAr: 'تاريخ فتح التذكرة',
    orderBy: '1, 2', groupBy: `(t.opened_at AT TIME ZONE 'Asia/Riyadh')::date, pr.name_ar`,
    filters: {program: 't.program_id', channel: 't.channel', assignee: 't.assignee_id'},
    columns: [
      {key: 'day', ar: 'اليوم', en: 'Day', type: 'text', expr: `to_char((t.opened_at AT TIME ZONE 'Asia/Riyadh')::date, 'YYYY-MM-DD')`, group: 'dim', default: true},
      {key: 'program', ar: 'البرنامج', en: 'Program', type: 'text', expr: `coalesce(pr.name_ar, 'غير محدد')`, group: 'dim', default: true},
      {key: 'ticket_volume', ar: 'حجم التذاكر', en: 'Ticket Volume', type: 'int', expr: 'count(*)', group: 'kpi', default: true},
      {key: 'open_tickets', ar: 'غير المغلقة الآن', en: 'Open Now', type: 'int', expr: `count(*) FILTER (WHERE t.status <> 'closed')`, group: 'kpi', default: true},
      {key: 'closed_tickets', ar: 'المغلقة', en: 'Closed', type: 'int', expr: `count(*) FILTER (WHERE t.status = 'closed')`, group: 'kpi', default: true},
      {key: 'frt_median', ar: 'وسيط أول رد (دقيقة)', en: 'FRT Median (min)', type: 'minutes', expr: `round((percentile_cont(.5) WITHIN GROUP (ORDER BY extract(epoch FROM t.first_response_at - t.opened_at)) / 60)::numeric, 1)`, group: 'kpi', default: true},
      {key: 'frt_p90', ar: 'p90 أول رد (دقيقة)', en: 'FRT P90 (min)', type: 'minutes', expr: `round((percentile_cont(.9) WITHIN GROUP (ORDER BY extract(epoch FROM t.first_response_at - t.opened_at)) / 60)::numeric, 1)`, group: 'kpi'},
      {key: 'close_tat_median', ar: 'وسيط زمن الإغلاق (دقيقة)', en: 'Close TAT Median (min)', type: 'minutes', expr: `round((percentile_cont(.5) WITHIN GROUP (ORDER BY extract(epoch FROM t.closed_at - t.opened_at)) / 60)::numeric, 1)`, group: 'kpi', default: true},
      {key: 'assign_wait_median', ar: 'وسيط انتظار الإسناد (دقيقة)', en: 'Assignment Wait Median (min)', type: 'minutes', expr: `round((percentile_cont(.5) WITHIN GROUP (ORDER BY extract(epoch FROM t.first_assigned_at - t.opened_at)) / 60)::numeric, 1)`, group: 'kpi'},
      {key: 'responded_tickets', ar: 'تذاكر تلقت ردًا', en: 'Responded', type: 'int', expr: 'count(t.first_response_at)', group: 'kpi'},
      {key: 'reassignments', ar: 'إعادات الإسناد', en: 'Reassignments', type: 'int', expr: 'sum(t.reassignment_count)', group: 'kpi'},
      {key: 'messages', ar: 'الرسائل', en: 'Messages', type: 'int', expr: 'sum(t.message_count)', group: 'kpi'},
      {key: 'repeat_customers', ar: 'عملاء بأكثر من تذكرة', en: 'Repeat Customers', type: 'int', expr: 'count(DISTINCT t.customer_identity_id) FILTER (WHERE (SELECT count(*) FROM tickets x WHERE x.customer_identity_id = t.customer_identity_id) > 1)', group: 'kpi'},
    ],
  },
  {
    key: 'queue_items', ar: 'تقرير طابور الرصد', en: 'Monitoring Queue', section: 'queue', needs: 'core',
    descriptionAr: 'عنصر طابور لكل صف من الطابور الحالي (قراءة فقط): الحالة والقسم والفريق والمسؤول والأوقات. الفترة على وقت الدخول.',
    dataPermissions: ['queue:view_all'],
    from: `queue_items q LEFT JOIN users ua ON ua.id = q.assignee_id LEFT JOIN users uc ON uc.id = q.completed_by
      LEFT JOIN programs pr ON pr.id = q.program_id LEFT JOIN teams tm ON tm.id = q.team_id`,
    dateExpr: 'q.entered_at', dateLabelAr: 'وقت دخول الطابور', orderBy: 'q.entered_at, q.id',
    filters: {program: 'q.program_id', status: 'q.status', assignee: 'q.assignee_id', section: 'q.section'},
    columns: [
      {key: 'queue_item_id', ar: 'معرف العنصر', en: 'Queue Item ID', type: 'id', expr: 'q.id::text', group: 'item', default: true},
      {key: 'interaction_type', ar: 'النوع', en: 'Type', type: 'text', expr: 'q.interaction_type', group: 'item'},
      {key: 'status', ar: 'الحالة', en: 'Status', type: 'text', expr: 'q.status', group: 'item', default: true},
      {key: 'section', ar: 'القسم', en: 'Section', type: 'text', expr: 'q.section', group: 'item', default: true},
      {key: 'priority', ar: 'الأولوية', en: 'Priority', type: 'text', expr: 'q.priority', group: 'item'},
      {key: 'program', ar: 'البرنامج', en: 'Program', type: 'text', expr: 'pr.name_ar', group: 'item', default: true},
      {key: 'team', ar: 'الفريق', en: 'Team', type: 'text', expr: 'tm.name', group: 'item'},
      {key: 'assignee', ar: 'المسؤول', en: 'Assignee', type: 'text', expr: 'ua.full_name', group: 'workflow', default: true},
      {key: 'entered_at', ar: 'دخل الطابور', en: 'Entered At', type: 'datetime', expr: 'q.entered_at', group: 'times', default: true},
      {key: 'first_assigned_at', ar: 'أول إسناد', en: 'First Assigned At', type: 'datetime', expr: 'q.first_assigned_at', group: 'times'},
      {key: 'first_started_at', ar: 'بدء المعالجة', en: 'First Started At', type: 'datetime', expr: 'q.first_started_at', group: 'times'},
      {key: 'completed_at', ar: 'الإنجاز', en: 'Completed At', type: 'datetime', expr: 'q.completed_at', group: 'times', default: true},
      {key: 'completed_by', ar: 'أنجزه', en: 'Completed By', type: 'text', expr: 'uc.full_name', group: 'workflow'},
      {key: 'resolution', ar: 'نتيجة المعالجة', en: 'Resolution', type: 'text', expr: 'q.resolution', group: 'workflow'},
      {key: 'queue_wait_minutes', ar: 'انتظار الطابور (دقيقة)', en: 'Queue Wait (min)', type: 'minutes', expr: minutes('q.entered_at', 'q.first_assigned_at'), group: 'kpi', default: true},
      {key: 'handling_minutes', ar: 'زمن المعالجة (دقيقة)', en: 'Handling (min)', type: 'minutes', expr: minutes('q.first_started_at', 'q.completed_at'), group: 'kpi'},
      {key: 'reassignment_count', ar: 'إعادات الإسناد', en: 'Reassignments', type: 'int', expr: 'q.reassignment_count', group: 'counts'},
      {key: 'escalation_count', ar: 'التصعيدات', en: 'Escalations', type: 'int', expr: 'q.escalation_count', group: 'counts'},
      {key: 'reopen_count', ar: 'إعادات الفتح', en: 'Reopens', type: 'int', expr: 'q.reopen_count', group: 'counts'},
    ],
  },
  {
    key: 'agents_queue', ar: 'تقرير الموظفين (الطابور)', en: 'Agents (Queue)', section: 'agents', needs: 'core',
    // The period applies to entered_at, and statuses/assignee are the CURRENT state — say exactly that, no more.
    descriptionAr: 'لكل موظف (المسؤول الحالي): العناصر التي دخلت الطابور في الفترة وحالتها الآن، مع وسيط انتظار الطابور وزمن المعالجة. ليست إنتاجية إغلاق في الفترة؛ لعدّ الإغلاقات بفترتها استخدم تقرير عناصر الطابور بفلتر الحالة.',
    dataPermissions: ['queue:view_all'],
    from: `queue_items q JOIN users ua ON ua.id = q.assignee_id`, dateExpr: 'q.entered_at', dateLabelAr: 'وقت دخول الطابور',
    orderBy: '1', groupBy: 'ua.full_name',
    filters: {program: 'q.program_id', section: 'q.section'},
    columns: [
      {key: 'agent', ar: 'الموظف', en: 'Agent', type: 'text', expr: 'ua.full_name', group: 'dim', default: true},
      {key: 'assigned_items', ar: 'عناصر مسندة', en: 'Assigned Items', type: 'int', expr: 'count(*)', group: 'kpi', default: true},
      {key: 'completed_items', ar: 'عناصر منجزة', en: 'Completed Items', type: 'int', expr: `count(*) FILTER (WHERE q.status = 'completed')`, group: 'kpi', default: true},
      {key: 'open_items', ar: 'غير منجزة', en: 'Open Items', type: 'int', expr: `count(*) FILTER (WHERE q.status <> 'completed')`, group: 'kpi', default: true},
      {key: 'queue_wait_median', ar: 'وسيط انتظار الطابور (دقيقة)', en: 'Queue Wait Median (min)', type: 'minutes', expr: `round((percentile_cont(.5) WITHIN GROUP (ORDER BY extract(epoch FROM q.first_assigned_at - q.entered_at)) / 60)::numeric, 1)`, group: 'kpi', default: true},
      {key: 'handling_median', ar: 'وسيط زمن المعالجة (دقيقة)', en: 'Handling Median (min)', type: 'minutes', expr: `round((percentile_cont(.5) WITHIN GROUP (ORDER BY extract(epoch FROM q.completed_at - q.first_started_at)) / 60)::numeric, 1)`, group: 'kpi', default: true},
      {key: 'reassignments', ar: 'إعادات الإسناد', en: 'Reassignments', type: 'int', expr: 'sum(q.reassignment_count)', group: 'kpi'},
      {key: 'escalations', ar: 'التصعيدات', en: 'Escalations', type: 'int', expr: 'sum(q.escalation_count)', group: 'kpi'},
    ],
  },
  {
    key: 'classifications', ar: 'تقرير التصنيفات', en: 'Classifications', section: 'classifications', needs: 'core',
    descriptionAr: 'عدد المنشورات المرصودة لكل برنامج ونوع تفاعل ومشاعر وحالة ارتباط. الفترة على تاريخ النشر.',
    dataPermissions: ['posts:read'],
    from: `posts p JOIN post_classifications c ON c.post_id = p.id AND c.posted_at = p.posted_at LEFT JOIN programs pr ON pr.id = c.program_id
      LEFT JOIN LATERAL (SELECT s.label AS sentiment FROM post_sentiments s WHERE s.post_id = p.id AND s.posted_at = p.posted_at ORDER BY s.stage DESC LIMIT 1) ps ON true`,
    dateExpr: 'p.posted_at', dateLabelAr: 'تاريخ النشر', orderBy: '5 DESC, 1, 2, 3, 4',
    groupBy: `coalesce(pr.name_ar, 'غير محدد'), coalesce(c.intent::text, 'غير محدد'), coalesce(ps.sentiment::text, 'غير مصنف'), c.relevance`,
    filters: {program: 'c.program_id', intent: 'c.intent', sentiment: 'ps.sentiment'},
    columns: [
      {key: 'program', ar: 'البرنامج', en: 'Program', type: 'text', expr: `coalesce(pr.name_ar, 'غير محدد')`, group: 'dim', default: true},
      {key: 'intent', ar: 'نوع التفاعل', en: 'Intent', type: 'text', expr: `coalesce(c.intent::text, 'غير محدد')`, group: 'dim', default: true},
      {key: 'sentiment', ar: 'المشاعر', en: 'Sentiment', type: 'text', expr: `coalesce(ps.sentiment::text, 'غير مصنف')`, group: 'dim', default: true},
      {key: 'relevance', ar: 'الارتباط', en: 'Relevance', type: 'text', expr: 'c.relevance', group: 'dim', default: true},
      {key: 'posts', ar: 'عدد المنشورات', en: 'Posts', type: 'int', expr: 'count(*)', group: 'kpi', default: true},
    ],
  },
  {
    key: 'monitoring', ar: 'تقرير الرصد', en: 'Monitoring', section: 'monitoring', needs: 'core',
    descriptionAr: 'منشور مرصود لكل صف مع تصنيفه ومؤشرات تفاعله المخزنة. لا يستدعي X: يقرأ البيانات المجمعة فقط.',
    dataPermissions: ['posts:read'],
    from: `posts p LEFT JOIN post_classifications c ON c.post_id = p.id AND c.posted_at = p.posted_at LEFT JOIN programs pr ON pr.id = c.program_id
      LEFT JOIN authors a ON a.id = p.author_id LEFT JOIN topics tp ON tp.id = c.topic_id
      LEFT JOIN LATERAL (SELECT s.label AS sentiment FROM post_sentiments s WHERE s.post_id = p.id AND s.posted_at = p.posted_at ORDER BY s.stage DESC LIMIT 1) ps ON true
      LEFT JOIN LATERAL (SELECT pm.like_count, pm.repost_count, pm.reply_count FROM post_metrics pm WHERE pm.post_id = p.id AND pm.posted_at = p.posted_at ORDER BY pm.captured_at DESC LIMIT 1) mt ON true`,
    dateExpr: 'p.posted_at', dateLabelAr: 'تاريخ النشر', orderBy: 'p.posted_at, p.id',
    filters: {program: 'c.program_id', intent: 'c.intent', sentiment: 'ps.sentiment', topic: 'c.topic_id'},
    columns: [
      {key: 'post_id', ar: 'معرف المنشور على X', en: 'X Post ID', type: 'id', expr: 'p.x_post_id', group: 'post', default: true},
      {key: 'posted_at', ar: 'تاريخ النشر', en: 'Posted At', type: 'datetime', expr: 'p.posted_at', group: 'post', default: true},
      {key: 'collected_at', ar: 'تاريخ الجمع', en: 'Collected At', type: 'datetime', expr: 'p.collected_at', group: 'post'},
      {key: 'author', ar: 'الحساب', en: 'Author', type: 'text', expr: 'a.username', group: 'post', default: true, requires: 'customers:read'},
      {key: 'text', ar: 'النص', en: 'Text', type: 'text', expr: 'p.text', group: 'post', default: true},
      {key: 'status', ar: 'حالة المعالجة', en: 'Processing Status', type: 'text', expr: 'p.status', group: 'post'},
      {key: 'program', ar: 'البرنامج', en: 'Program', type: 'text', expr: 'pr.name_ar', group: 'classification', default: true},
      {key: 'intent', ar: 'نوع التفاعل', en: 'Intent', type: 'text', expr: 'c.intent', group: 'classification', default: true},
      {key: 'sentiment', ar: 'المشاعر', en: 'Sentiment', type: 'text', expr: 'ps.sentiment', group: 'classification', default: true},
      {key: 'relevance', ar: 'الارتباط', en: 'Relevance', type: 'text', expr: 'c.relevance', group: 'classification'},
      {key: 'topic', ar: 'الموضوع', en: 'Topic', type: 'text', expr: 'tp.name_ar', group: 'classification'},
      {key: 'likes', ar: 'الإعجابات', en: 'Likes', type: 'int', expr: 'mt.like_count', group: 'engagement'},
      {key: 'reposts', ar: 'إعادات النشر', en: 'Reposts', type: 'int', expr: 'mt.repost_count', group: 'engagement'},
      {key: 'replies', ar: 'الردود', en: 'Replies', type: 'int', expr: 'mt.reply_count', group: 'engagement'},
      {key: 'url', ar: 'الرابط', en: 'URL', type: 'text', expr: 'p.url', group: 'post', requires: 'customers:read'},
    ],
  },
];

/** Listed in the Reporting Center but never generated: their definitions or data are not approved yet. */
export const UNAVAILABLE_REPORTS = [
  {key: 'sla', ar: 'تقارير الأداء وSLA', section: 'performance', reasonAr: 'لا توجد سياسة SLA معتمدة (أهداف لكل قناة/أولوية وساعات عمل). المؤشرات الخام متاحة في «مؤشرات أداء التذاكر».'},
  {key: 'aht', ar: 'متوسط زمن المعالجة AHT', section: 'performance', reasonAr: 'لا يُحسب من الفرق بين الفتح والإغلاق. يتطلب تسجيل زمن العمل الفعلي لكل تذكرة (غير مسجل حاليًا).'},
];

export const reportType = (key: string) => REPORT_TYPES.find((r) => r.key === key);
export const SCHEMA_VERSION = '1.0';
