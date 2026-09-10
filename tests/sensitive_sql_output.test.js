'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const securityGuard = require('../src/backend/intelligent_core/security_guard');

test('SQL result sanitization removes authentication secrets regardless of casing', () => {
  const [row] = securityGuard.sanitizeTabularRows([{
    CustomerID: 4,
    PassWord: 'hash-value',
    password_hash: 'hash-2',
    ApiKey: 'key-value',
    CreateUser: 'admin',
    CreateDate: '2026-01-01',
    UpdateUser: 'operator',
    UpdateDate: '2026-02-01',
    CustomerName: 'An Phát'
  }]);
  assert.deepEqual(row, { CustomerID: 4, CustomerName: 'An Phát' });
});

test('SQL result sanitization masks secrets embedded in ordinary text values', () => {
  const [row] = securityGuard.sanitizeTabularRows([{ Notes: 'Server=x;Password=plain-secret;Database=y' }]);
  assert.equal(row.Notes, 'Server=x;Password=******;Database=y');
  assert.equal(securityGuard.maskSensitiveData('hash fa585d89c851dd338a70dcf535aa2a92fee7836dd6aff1226583e88e0996293f'), 'hash [REDACTED_SECRET]');
});

test('structured chat sanitization removes matching columns and aligned cell values', () => {
  const value = securityGuard.sanitizeStructuredData({
    toolResult: { columns: ['CustomerID', 'PassWord', 'Name'], rows: [[4, 'secret-hash', 'An Phát']] }
  });
  assert.deepEqual(value.toolResult, { columns: ['CustomerID', 'Name'], rows: [[4, 'An Phát']] });
});
