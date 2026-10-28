'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const governance = require('../src/backend/governance/context');
const { check } = require('../src/backend/governance/sql_policy');
const scopes = require('../src/backend/governance/scope');

// Schema metadata only: table and column names, no business rows.
const column = (name, extra = {}) => ({ columnName: name, dataType: 'int', isVisible: true, ...extra });
const tables = [
  { tableId: 's1::db::dbo::t_contract', tableName: 'T_Contract', schemaName: 'dbo', dbSourceId: 's1',
    columns: [column('ContractID', { isPrimaryKey: true }), column('CustomerID'), column('Amount'), column('Note')] },
  { tableId: 's1::db::dbo::m_customer', tableName: 'M_Customer', schemaName: 'dbo', dbSourceId: 's1',
    columns: [column('ID', { isPrimaryKey: true }), column('CustomerName'), column('Phone')] },
  { tableId: 's1::db::dbo::t_revenue', tableName: 'T_Revenue', schemaName: 'dbo', dbSourceId: 's1',
    columns: [column('RevenueID', { isPrimaryKey: true }), column('ContractID'), column('Total')] },
  { tableId: 's1::db::dbo::hr_salary', tableName: 'HR_Salary', schemaName: 'dbo', dbSourceId: 's1',
    columns: [column('EmpID', { isPrimaryKey: true }), column('Salary')] },
  { tableId: 's1::db::dbo::s_user_otp', tableName: 'S_User_OTP', schemaName: 'dbo', dbSourceId: 's1',
    columns: [column('UserID', { isPrimaryKey: true }), column('Code')] }
];
const relations = [
  { id: 'r1', status: 'verified', cardinality: 'many-to-one', sourceTableId: tables[0].tableId, targetTableId: tables[1].tableId,
    sourceTable: 'T_Contract', targetTable: 'M_Customer', columnPairs: [{ sourceColumn: 'CustomerID', targetColumn: 'ID' }], displayColumn: 'CustomerName' },
  { id: 'r2', status: 'verified', cardinality: 'many-to-one', sourceTableId: tables[2].tableId, targetTableId: tables[0].tableId,
    sourceTable: 'T_Revenue', targetTable: 'T_Contract', columnPairs: [{ sourceColumn: 'ContractID', targetColumn: 'ContractID' }] }
];
const source = { id: 's1', dbName: 'Metadata', governedPolicy: { schemaVersion: 2, revision: 1, access: { mode: 'all' }, aiSharing: { level: 'all' },
  sql: { hiddenTables: ['dbo.S_User_OTP'], packages: [
    { id: 'contracts', name: 'Hợp đồng', tables: ['dbo.T_Contract'], sensitiveColumns: ['T_Contract.Note'] },
    { id: 'finance', name: 'Tài chính', tables: ['dbo.T_Revenue'] },
    { id: 'catalog', name: 'Danh mục chung', tables: ['dbo.M_Customer'], base: true, baseLevel: 'lookup' },
    { id: 'hr', name: 'Nhân sự', tables: ['dbo.HR_Salary'], allowBridge: false }] } } };

function withDictionary(t) {
  const dictionary = require('../src/backend/services/dictionary_service');
  const previous = { tables: dictionary.tablesStore, relations: dictionary.tableRelationships };
  dictionary.tablesStore = tables; dictionary.tableRelationships = relations;
  t.after(() => { dictionary.tablesStore = previous.tables; dictionary.tableRelationships = previous.relations; });
}
const actor = packages => ({ subject: 'account:u', role: 'sales', permissions: ['sql:read'], grants: { sql: [], packages: { s1: packages } }, accessRevision: JSON.stringify(packages) });
const run = (packages, sql) => governance.run(() => { governance.setPrincipal(actor(packages)); return check(sql, source); });

test('table packages give full, lookup and bridge levels and hide secret tables', t => {
  withDictionary(t);
  const scope = scopes.effectiveScope(source, actor({ contracts: 'full' }));
  assert.equal(scope.entries.get(tables[0].tableId).level, 'full');
  // Q1: the customer lookup comes with the contract package; the base package is lookup only.
  assert.equal(scope.entries.get(tables[1].tableId).level, 'lookup');
  assert.deepEqual([...scope.entries.get(tables[1].tableId).columns].sort(), ['customername', 'id']);
  // Q2: revenue may be joined through by keys; HR does not allow bridging; OTP is hidden.
  assert.equal(scope.entries.get(tables[2].tableId).level, 'bridge');
  assert.equal(scope.entries.has(tables[3].tableId), false);
  assert.equal(scope.entries.has(tables[4].tableId), false);
  assert.ok(!scope.entries.get(tables[0].tableId).columns.has('note'));
  // Admin sees every table except hidden ones, sensitive columns included.
  const admin = scopes.effectiveScope(source, { subject: 'account:a', role: 'admin' });
  assert.ok(admin.entries.get(tables[0].tableId).columns.has('note')); assert.equal(admin.entries.has(tables[4].tableId), false);
});

test('SQL is checked per clause against the actor table scope', t => {
  withDictionary(t);
  assert.match(run({ contracts: 'full' }, 'SELECT c.Amount, m.CustomerName FROM dbo.T_Contract c JOIN dbo.M_Customer m ON c.CustomerID = m.ID'), /SELECT/);
  // Q3: bridge keys may join, never be read.
  assert.doesNotThrow(() => run({ contracts: 'full' }, 'SELECT c.Amount FROM dbo.T_Contract c JOIN dbo.T_Revenue r ON r.ContractID = c.ContractID'));
  assert.throws(() => run({ contracts: 'full' }, 'SELECT r.Total FROM dbo.T_Revenue r'), { code: 'SQL_COLUMN_DENIED' });
  assert.throws(() => run({ contracts: 'full' }, 'SELECT ContractID FROM dbo.T_Revenue WHERE Total > 1'), { code: 'SQL_COLUMN_DENIED' });
  // Lookup tables expose keys and names only; sensitive columns are blocked in filters too.
  assert.throws(() => run({ contracts: 'full' }, 'SELECT Phone FROM dbo.M_Customer'), { code: 'SQL_COLUMN_DENIED' });
  assert.throws(() => run({ contracts: 'full' }, 'SELECT Amount FROM dbo.T_Contract WHERE Note = 1'), { code: 'SQL_COLUMN_DENIED' });
  // Q7: a table outside the role names the missing package; hidden tables stay hidden.
  assert.throws(() => run({ contracts: 'full' }, 'SELECT Salary FROM dbo.HR_Salary'), error => error.code === 'SQL_TABLE_DENIED' && /Nhân sự/.test(error.message));
  assert.throws(() => run({ contracts: 'full', hr: 'full', finance: 'full' }, 'SELECT Code FROM dbo.S_User_OTP'), error => /ẩn/.test(error.message));
  // Subqueries are checked as statements of their own.
  assert.throws(() => run({ contracts: 'full' }, 'SELECT Amount FROM dbo.T_Contract WHERE ContractID IN (SELECT ContractID FROM dbo.T_Revenue WHERE Total > 0)'), { code: 'SQL_COLUMN_DENIED' });
  assert.doesNotThrow(() => run({ contracts: 'full', finance: 'full' }, 'SELECT Amount FROM dbo.T_Contract WHERE ContractID IN (SELECT ContractID FROM dbo.T_Revenue WHERE Total > 0)'));
});

test('SELECT * becomes the readable column list instead of failing', t => {
  withDictionary(t);
  const sql = run({ contracts: 'full' }, 'SELECT * FROM dbo.T_Contract');
  assert.match(sql, /ContractID/); assert.match(sql, /Amount/); assert.doesNotMatch(sql, /Note/); assert.doesNotMatch(sql, /\*/);
  assert.throws(() => run({ contracts: 'full' }, 'SELECT * FROM dbo.T_Contract c JOIN dbo.M_Customer m ON c.CustomerID = m.ID'), { code: 'SQL_COLUMN_DENIED' });
});

test('function groups combine into a role and widgets read through their role', t => {
  withDictionary(t);
  const groups = require('../src/backend/services/account_function_groups');
  const roles = require('../src/backend/services/account_roles');
  const previous = { groups: groups.groups, roles: roles.roles };
  t.after(() => { groups.groups = previous.groups; roles.roles = previous.roles; });
  t.mock.method(groups, 'persist', () => {});
  const storage = require('../src/backend/utils/storage_helper');
  t.mock.method(storage, 'saveJson', () => true);
  groups.groups = []; roles.roles = [];
  groups.save({ id: 'co_ban', name: 'Cơ bản', permissions: ['chat.use', 'knowledge:read'] });
  groups.save({ id: 'tra_cuu_hd', name: 'Tra cứu hợp đồng', permissions: ['sql:read'], packages: { s1: { contracts: 'lookup' } } });
  groups.save({ id: 'quan_ly_hd', name: 'Quản lý hợp đồng', permissions: ['sql:read'], packages: { s1: { contracts: 'full' } }, workflows: ['contracts-report'] });
  roles.save({ id: 'sales', name: 'Kinh doanh', functionGroups: ['co_ban', 'tra_cuu_hd', 'quan_ly_hd'] });
  const effective = roles.effective({ role: 'sales' });
  assert.deepEqual(effective.permissions.sort(), ['chat.use', 'knowledge:read', 'sql:read']);
  // The higher level wins when two groups grant one package.
  assert.equal(effective.grants.packages.s1.contracts, 'full');
  assert.deepEqual(effective.grants.workflows, ['contracts-report']);
  // Extra groups on one account add to the role.
  groups.save({ id: 'tai_chinh', name: 'Tài chính', permissions: ['sql:read'], packages: { s1: { finance: 'full' } } });
  assert.equal(roles.effective({ role: 'sales', extraFunctionGroups: ['tai_chinh'] }).grants.packages.s1.finance, 'full');
  assert.throws(() => groups.remove('co_ban', 1), { statusCode: 409 });
  // A widget defaults to khach_widget (chat only) and may be given a role.
  assert.deepEqual(roles.forEmbed({ id: 'w' }).permissions, ['chat.use']);
  assert.equal(roles.forEmbed({ id: 'w', role: 'sales' }).grants.packages.s1.contracts, 'full');
  governance.run(() => {
    governance.setPrincipal({ subject: 'embed:w:s', channel: 'embed', embedId: 'w', ...roles.forEmbed({ id: 'w' }) });
    assert.equal(governance.canRead(source, 'sql'), false);
    governance.setPrincipal({ subject: 'embed:w:s', channel: 'embed', embedId: 'w', ...roles.forEmbed({ id: 'w', role: 'sales' }) });
    assert.equal(governance.canRead(source, 'sql'), true);
  });
  // Restricted sources are opened by listing them in a function group.
  const restricted = { ...source, id: 's2', governedPolicy: { schemaVersion: 2, access: { mode: 'grants', denyUsers: ['account:blocked'] } } };
  governance.run(() => {
    governance.setPrincipal({ subject: 'account:u', role: 'sales', ...roles.effective({ role: 'sales' }) });
    assert.equal(governance.explain(restricted, 'sql').reason, 'NOT_GRANTED');
    groups.save({ ...groups.get('quan_ly_hd'), sources: { sql: ['s2'] } }, 'quan_ly_hd');
    governance.setPrincipal({ subject: 'account:u', role: 'sales', ...roles.effective({ role: 'sales' }) });
    assert.equal(governance.explain(restricted, 'sql').reason, 'GRANT_FUNCTION_GROUP');
    governance.setPrincipal({ subject: 'account:blocked', role: 'sales', ...roles.effective({ role: 'sales' }) });
    assert.equal(governance.explain(restricted, 'sql').reason, 'DENIED_USER');
  });
});

test('documents inherit the policy of their watch folder until given their own', t => {
  const folders = require('../src/backend/knowledge_core/services/watchfolder_service');
  const path = require('node:path');
  const previous = folders.folders;
  t.after(() => { folders.folders = previous; });
  const root = path.resolve('/watched');
  folders.folders = [{ id: 'f1', path: root, governedPolicy: { schemaVersion: 2, revision: 3, access: { mode: 'admin' }, aiSharing: { level: 'local' } } }];
  const document = { id: 'd1', title: 'Guide', sourcePath: path.join(root, 'guide.pdf') };
  governance.run(() => {
    governance.setPrincipal({ subject: 'account:u', role: 'user', permissions: ['knowledge:read'] });
    assert.equal(governance.canRead(document, 'document'), false);
    assert.equal(governance.policyFor(document, 'document').policy.inheritFrom, 'watchfolder:f1');
    document.governedPolicy = { schemaVersion: 2, revision: 1, access: { mode: 'all' }, aiSharing: { level: 'all' } };
    assert.equal(governance.canRead(document, 'document'), true);
    document.governedPolicy = { schemaVersion: 2, revision: 2, inheritFrom: 'watchfolder' };
    assert.equal(governance.canRead(document, 'document'), false);
  });
});

test('switching a table on is seen at once and reports which roles get it', t => {
  withDictionary(t);
  const roles = require('../src/backend/services/account_roles'), groups = require('../src/backend/services/account_function_groups');
  const storage = require('../src/backend/utils/storage_helper');
  const previous = { groups: groups.groups, roles: roles.roles };
  t.after(() => { groups.groups = previous.groups; roles.roles = previous.roles; });
  t.mock.method(storage, 'saveJson', () => true);
  groups.groups = []; roles.roles = [];
  groups.save({ id: 'hd', name: 'Hợp đồng', permissions: ['sql:read'], packages: { s1: { contracts: 'full' } } });
  roles.save({ id: 'sales', name: 'Kinh doanh', functionGroups: ['hd'] });
  const actor = { subject: 'account:u', role: 'sales', ...roles.effective({ role: 'sales' }) };
  tables[0].isActive = false;
  try {
    assert.equal(scopes.effectiveScope(source, actor).entries.has(tables[0].tableId), false);
    tables[0].isActive = true; // changed in place, as toggleTableActive does
    assert.equal(scopes.effectiveScope(source, actor).entries.get(tables[0].tableId).level, 'full');
  } finally { tables[0].isActive = true; }
  const access = scopes.tableAccess(source, tables[0].tableId);
  assert.equal(access.packageName, 'Hợp đồng'); assert.deepEqual(access.roles.map(role => [role.id, role.level]), [['sales', 'full']]);
  assert.equal(scopes.tableAccess(source, tables[4].tableId).hidden, true);
  const orphanSource = { ...source, governedPolicy: { ...source.governedPolicy, revision: 9, sql: { ...source.governedPolicy.sql, packages: source.governedPolicy.sql.packages.filter(item => item.id !== 'finance') } } };
  assert.equal(scopes.tableAccess(orphanSource, tables[2].tableId).orphan, true);
});

test('custom roles can be deleted only when no account or widget uses them', t => {
  const roles = require('../src/backend/services/account_roles'), embeds = require('../src/backend/services/embed_chat_service');
  const storage = require('../src/backend/utils/storage_helper');
  const previous = { roles: roles.roles, configs: embeds.configs };
  t.after(() => { roles.roles = previous.roles; embeds.configs = previous.configs; });
  t.mock.method(storage, 'saveJson', () => true);
  roles.roles = []; embeds.configs = [{ id: 'w', role: 'widget_role' }];
  roles.save({ id: 'widget_role', name: 'Widget', functionGroups: [] });
  roles.save({ id: 'spare', name: 'Spare', functionGroups: [] });
  assert.throws(() => roles.remove('user', 0), { statusCode: 409 });
  assert.throws(() => roles.remove('widget_role', 1), { statusCode: 409 });
  assert.throws(() => roles.remove('spare', 5), { statusCode: 409 });
  assert.equal(roles.remove('spare', 1), true); assert.equal(roles.get('spare'), undefined);
});
