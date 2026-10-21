'use strict';

// Server-owned policy. Neither tool arguments nor an admin role can override it.
function enabled() { return process.env.GOVERNED_READ_ONLY !== 'false'; }
// External connectors follow their configured operation; SQL keeps its own SELECT-only guard.
function externalReadOnly() { return process.env.GOVERNED_EXTERNAL_READ_ONLY === 'true'; }
function assertSourceAllowed(binding) {
  if (!externalReadOnly() || binding?.type !== 'api') return;
  const method = binding.method || 'GET';
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) || binding.effects !== 'read') {
    throw Object.assign(new Error('Nguồn API chưa được duyệt là chỉ đọc; hệ thống đang ở chế độ read-only.'),
      { code: 'READ_ONLY_POLICY_DENIED', statusCode: 403 });
  }
}
module.exports = { enabled, externalReadOnly, assertSourceAllowed };
