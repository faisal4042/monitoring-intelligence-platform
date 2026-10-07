/**
 * Fine-grained permissions. Roles are bundles of these, never checked directly —
 * see docs/DATABASE_SCHEMA.md §1.
 */
export const PERMISSIONS = {
  PROGRAMS_READ: 'programs:read',
  PROGRAMS_WRITE: 'programs:write',
  KEYWORDS_READ: 'keywords:read',
  KEYWORDS_WRITE: 'keywords:write',
  QUERIES_READ: 'queries:read',
  QUERIES_WRITE: 'queries:write',
  QUERY_TEST: 'query:test',
  QUERY_PROMOTE: 'query:promote',
  POSTS_READ: 'posts:read',
  POSTS_EXPORT: 'posts:export',
  FEEDBACK_WRITE: 'feedback:write',
  INFLUENCERS_READ: 'influencers:read',
  INFLUENCERS_WRITE: 'influencers:write',
  TOPICS_READ: 'topics:read',
  TOPICS_MANAGE: 'topics:manage',
  INCIDENTS_READ: 'incidents:read',
  INCIDENTS_WRITE: 'incidents:write',
  ALERTS_READ: 'alerts:read',
  ALERTS_WRITE: 'alerts:write',
  REPORTS_READ: 'reports:read',
  REPORTS_WRITE: 'reports:write',
  COST_READ: 'cost:read',
  BUDGET_WRITE: 'budget:write',
  KILLSWITCH_OPERATE: 'killswitch:operate',
  HISTORICAL_READ: 'historical:read',
  HISTORICAL_WRITE: 'historical:write',
  INTERNAL_DATA_READ: 'internal_data:read',
  SETTINGS_READ: 'settings:read',
  SETTINGS_WRITE: 'settings:write',
  USERS_WRITE: 'users:write',
  AUDIT_READ: 'audit:read',
  ADMIN_SYSTEM: 'admin:system',
  NEWS_READ: 'news:read',
  NEWS_MANAGE_SOURCES: 'news:manage_sources',
  CUSTOMERS_READ: 'customers:read',
  USERS_READ: 'users:read',
  USERS_ASSIGN_ROLES: 'users:assign_roles',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
export const ALL_PERMISSIONS = Object.values(PERMISSIONS) as Permission[];

export const ROLE_KEYS = ['admin', 'supervisor', 'analyst', 'agent', 'viewer'] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

/** مطّلع — read-only stakeholder. No cost figures and no individual customer history. */
const READ_ONLY: Permission[] = [
  PERMISSIONS.PROGRAMS_READ, PERMISSIONS.KEYWORDS_READ, PERMISSIONS.QUERIES_READ,
  PERMISSIONS.POSTS_READ, PERMISSIONS.INFLUENCERS_READ, PERMISSIONS.TOPICS_READ,
  PERMISSIONS.INCIDENTS_READ, PERMISSIONS.ALERTS_READ, PERMISSIONS.REPORTS_READ,
  PERMISSIONS.HISTORICAL_READ, PERMISSIONS.SETTINGS_READ, PERMISSIONS.NEWS_READ,
];

/**
 * موظف رصد — works the interaction stream: reads posts, news, topics/signals
 * and customer history, and corrects classifications. Nothing that changes
 * collection, spends X quota, or administers the platform. Queue permissions
 * (own/team) arrive with the queue phase.
 */
const AGENT: Permission[] = [
  PERMISSIONS.POSTS_READ, PERMISSIONS.PROGRAMS_READ, PERMISSIONS.TOPICS_READ,
  PERMISSIONS.NEWS_READ, PERMISSIONS.CUSTOMERS_READ, PERMISSIONS.FEEDBACK_WRITE,
];

const ANALYST: Permission[] = [
  ...READ_ONLY,
  PERMISSIONS.COST_READ, PERMISSIONS.CUSTOMERS_READ,
  PERMISSIONS.KEYWORDS_WRITE, PERMISSIONS.FEEDBACK_WRITE, PERMISSIONS.QUERY_TEST,
  PERMISSIONS.TOPICS_MANAGE, PERMISSIONS.HISTORICAL_WRITE, PERMISSIONS.POSTS_EXPORT,
  PERMISSIONS.INFLUENCERS_WRITE,
];

const SUPERVISOR: Permission[] = [
  ...ANALYST,
  PERMISSIONS.QUERIES_WRITE, PERMISSIONS.QUERY_PROMOTE, PERMISSIONS.ALERTS_WRITE,
  PERMISSIONS.REPORTS_WRITE, PERMISSIONS.INCIDENTS_WRITE, PERMISSIONS.KILLSWITCH_OPERATE,
  PERMISSIONS.NEWS_MANAGE_SOURCES, PERMISSIONS.USERS_READ,
];

/**
 * budget:write and internal_data:read are deliberately NOT granted to any role
 * by default. They are granted per-user (docs/DATABASE_SCHEMA.md §1).
 */
export const ROLE_PERMISSIONS: Record<RoleKey, Permission[]> = {
  viewer: READ_ONLY,
  agent: AGENT,
  analyst: ANALYST,
  supervisor: SUPERVISOR,
  admin: ALL_PERMISSIONS,
};

export const ROLE_LABELS: Record<RoleKey, { ar: string; en: string }> = {
  admin: { ar: 'مدير النظام', en: 'Admin' },
  supervisor: { ar: 'مشرف', en: 'Supervisor' },
  analyst: { ar: 'محلل', en: 'Analyst' },
  agent: { ar: 'موظف رصد', en: 'Monitoring Agent' },
  viewer: { ar: 'مطّلع', en: 'Viewer' },
};
