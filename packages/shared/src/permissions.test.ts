import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_PERMISSIONS, PERMISSIONS as P, ROLE_KEYS, ROLE_LABELS, ROLE_PERMISSIONS } from './permissions.js';

const has = (role: keyof typeof ROLE_PERMISSIONS, perm: string) => ROLE_PERMISSIONS[role].includes(perm as never);

test('every role is defined, labelled and free of duplicates or unknown keys', () => {
  assert.deepEqual([...ROLE_KEYS].sort(), ['admin', 'agent', 'analyst', 'supervisor', 'viewer']);
  for (const role of ROLE_KEYS) {
    const perms = ROLE_PERMISSIONS[role];
    assert.equal(new Set(perms).size, perms.length, `${role} has duplicate permissions`);
    for (const p of perms) assert.ok(ALL_PERMISSIONS.includes(p), `${role} has unknown permission ${p}`);
    assert.ok(ROLE_LABELS[role].ar && ROLE_LABELS[role].en);
  }
  assert.deepEqual(ROLE_LABELS.agent, { ar: 'موظف رصد', en: 'Monitoring Agent' });
});

test('agent: exactly the monitoring set, nothing administrative', () => {
  assert.deepEqual([...ROLE_PERMISSIONS.agent].sort(), [
    P.CUSTOMERS_READ, P.FEEDBACK_WRITE, P.NEWS_READ, P.POSTS_READ, P.PROGRAMS_READ, P.TOPICS_READ,
  ].sort());
  for (const forbidden of [
    P.QUERY_TEST, P.QUERY_PROMOTE, P.KEYWORDS_WRITE, P.QUERIES_WRITE, P.INFLUENCERS_WRITE,
    P.TOPICS_MANAGE, P.NEWS_MANAGE_SOURCES, P.COST_READ, P.BUDGET_WRITE, P.KILLSWITCH_OPERATE,
    P.SETTINGS_WRITE, P.USERS_READ, P.USERS_WRITE, P.USERS_ASSIGN_ROLES, P.AUDIT_READ, P.ADMIN_SYSTEM,
  ]) assert.equal(has('agent', forbidden), false, `agent must not have ${forbidden}`);
});

test('viewer: read-only, no cost and no customer history', () => {
  for (const p of ROLE_PERMISSIONS.viewer) assert.match(p, /:read$/, `viewer has non-read ${p}`);
  assert.equal(has('viewer', P.COST_READ), false);
  assert.equal(has('viewer', P.CUSTOMERS_READ), false);
  assert.equal(has('viewer', P.USERS_READ), false);
  assert.equal(has('viewer', P.POSTS_READ), true);
});

test('cost:read belongs to supervisor, analyst and admin only', () => {
  const holders = ROLE_KEYS.filter((r) => has(r, P.COST_READ)).sort();
  assert.deepEqual(holders, ['admin', 'analyst', 'supervisor']);
});

test('supervisor: can see users but never manage them or their roles', () => {
  assert.equal(has('supervisor', P.USERS_READ), true);
  assert.equal(has('supervisor', P.USERS_WRITE), false);
  assert.equal(has('supervisor', P.USERS_ASSIGN_ROLES), false);
  assert.equal(has('supervisor', P.AUDIT_READ), false);
  // Supervisor keeps everything an analyst and an agent can do.
  for (const p of [...ROLE_PERMISSIONS.analyst, ...ROLE_PERMISSIONS.agent]) assert.equal(has('supervisor', p), true, p);
});

test('only admin can manage users, assign roles, audit or operate the system', () => {
  for (const p of [P.USERS_WRITE, P.USERS_ASSIGN_ROLES, P.AUDIT_READ, P.ADMIN_SYSTEM, P.SETTINGS_WRITE]) {
    assert.deepEqual(ROLE_KEYS.filter((r) => has(r, p)), ['admin'], p);
  }
});

test('admin keeps every permission, including budget:write and internal_data:read', () => {
  assert.deepEqual([...ROLE_PERMISSIONS.admin].sort(), [...ALL_PERMISSIONS].sort());
  assert.equal(has('admin', P.BUDGET_WRITE), true);
  assert.equal(has('admin', P.INTERNAL_DATA_READ), true);
});

test('roles are nested: viewer ⊂ analyst ⊂ supervisor ⊂ admin, agent ⊂ supervisor', () => {
  const subset = (a: keyof typeof ROLE_PERMISSIONS, b: keyof typeof ROLE_PERMISSIONS) =>
    ROLE_PERMISSIONS[a].every((p) => has(b, p));
  assert.ok(subset('viewer', 'analyst'));
  assert.ok(subset('analyst', 'supervisor'));
  assert.ok(subset('supervisor', 'admin'));
  assert.ok(subset('agent', 'supervisor'));
});
