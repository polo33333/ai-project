'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { migrate, oldCanRead } = require('../src/backend/governance/migration');

test('migration to function groups keeps every read decision and permission list', () => {
  const roles = [
    { id: 'finance', name: 'Kế toán', permissions: ['chat.use', 'sql:read', 'knowledge:read'], dataAccess: { sql: ['s1'], documents: null }, revision: 2 },
    { id: 'viewer', name: 'Xem tài liệu', permissions: ['chat.use', 'knowledge:read'], dataAccess: null, revision: 1 }
  ];
  const accounts = [
    { id: 'root', role: 'admin' }, { id: 'a', role: 'finance' }, { id: 'b', role: 'user', permissions: ['chat.use', 'knowledge:read'] },
    { id: 'c', role: 'user', dataAccess: { sql: null, documents: [] } }, { id: 'd', role: 'viewer', permissions: ['chat.use', 'knowledge:read', 'sql:read'] }
  ];
  const resources = [
    { type: 'sql', resource: { id: 's1', dbName: 'One', governedPolicy: { visibility: 'restricted', sensitivity: 'internal', subjects: ['account:c'], roles: ['finance'], embedIds: [], modelDestinations: [], revision: 1 } } },
    { type: 'sql', resource: { id: 's2', dbName: 'Two' } },
    { type: 'document', resource: { id: 'd1', title: 'Shared' } },
    { type: 'document', resource: { id: 'd2', title: 'Private', governedPolicy: { visibility: 'restricted', sensitivity: 'restricted', subjects: ['account:b'], roles: [], embedIds: ['w'], modelDestinations: [] } } }
  ];
  const { data, report } = migrate({ resources, roles, accounts, groups: [], tables: [] });
  assert.deepEqual(report.mismatches, []);
  // Roles now point to conversion groups; no role or account keeps the old lists.
  assert.ok(data.roles.every(role => Array.isArray(role.functionGroups) && !role.permissions && !role.dataAccess));
  assert.ok(data.accounts.every(account => account.permissions === undefined && account.dataAccess === undefined));
  // Finance was limited to s1, so s2 now opens through function groups only.
  assert.equal(data.resources.find(item => item.resource.id === 's2').resource.governedPolicy.access.mode, 'grants');
  // The narrower account gets a role of its own; the wider one an extra group.
  assert.equal(data.accounts.find(account => account.id === 'b').role, 'rieng_b');
  assert.ok(data.accounts.find(account => account.id === 'd').extraFunctionGroups.length);
  // Widget grants stay as they were and are listed for review.
  assert.deepEqual(report.keptWidgetGrants, [{ type: 'document', id: 'd2', widgets: ['w'] }]);
  assert.equal(data.resources.find(item => item.resource.id === 'd2').resource.governedPolicy.aiSharing.level, 'local');
  // Sanity: the version 1 rule itself.
  assert.equal(oldCanRead(accounts[3], [], resources[3].resource, 'document'), false);
});
