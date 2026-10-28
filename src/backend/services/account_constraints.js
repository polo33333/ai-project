'use strict';
function validateTransition(previous, next) {
  const fail = message => { throw Object.assign(new Error(message), { statusCode: 409, code: 'ACCOUNT_CONFLICT' }); };
  const names = new Set();
  for (const account of next) {
    const key = String(account.username || '').toLowerCase();
    if (names.has(key)) fail('Tên đăng nhập đã tồn tại.');
    names.add(key);
  }
  // An admin limited to the chat client cannot open the management app.
  const activeAdmin = account => account.role === 'admin' && account.isActive !== false && account.clientAccess !== 'chat';
  if (previous.some(activeAdmin) && !next.some(activeAdmin)) fail('Phải giữ ít nhất một quản trị viên đang hoạt động được vào trang quản lý.');
}
function validateRevisions(baseline, proposed, fresh) {
  for (const account of proposed) {
    const before = baseline.find(item => item.id === account.id), current = fresh.find(item => item.id === account.id);
    if (before && current && (account.managementRevision || 0) !== (before.managementRevision || 0)
      && (current.managementRevision || 0) !== (before.managementRevision || 0))
      throw Object.assign(new Error('Tài khoản đã được cập nhật bởi thao tác khác.'), { statusCode: 409, code: 'ACCOUNT_CONFLICT' });
  }
}
function validateRoles(accounts, roles) {
  const ids=new Set(['admin','user','khach_widget',...roles.map(role=>role.id)]);
  if(accounts.some(account=>!ids.has(account.role||'user'))) throw Object.assign(new Error('Vai trò tài khoản không còn tồn tại.'),{statusCode:409,code:'ACCOUNT_CONFLICT'});
}
module.exports = { validateTransition, validateRevisions, validateRoles };
