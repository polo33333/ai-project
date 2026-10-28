/**
 * Lightweight JSON-backed authentication service.
 */

const crypto = require('crypto');
const StorageHelper = require('../utils/storage_helper');

const ACCOUNT_FILE = 'accounts.json';
const SESSION_FILE = 'sessions.json';
const SESSION_TTL_MS = 1000 * 60 * 60 * 8;
const SESSION_TOUCH_INTERVAL_MS = Math.max(60_000, Number(process.env.SESSION_TOUCH_INTERVAL_MS || 300_000));
const SCRYPT_KEY_LENGTH = 64;

class AuthService {
  constructor() {
    StorageHelper.bind(this, 'accounts', ACCOUNT_FILE, null);
    if (!Array.isArray(this.accounts) || this.accounts.length === 0) {
      const bootstrapPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;
      if (!bootstrapPassword) {
        throw new Error('Chưa có tài khoản. Hãy đặt BOOTSTRAP_ADMIN_PASSWORD để khởi tạo admin lần đầu.');
      }
      this.accounts = [{
        id: 'admin',
        username: 'admin',
        displayName: 'Admin AI',
        role: 'admin',
        passwordHash: this.hashPassword(bootstrapPassword),
        createdAt: new Date().toISOString(),
        lastLoginAt: null,
        isActive: true
      }];
      this.persistAccounts();
    }
    StorageHelper.bind(this, 'sessions', SESSION_FILE, {});
    if (!this.sessions || Array.isArray(this.sessions) || typeof this.sessions !== 'object') this.sessions = {};
    this.cleanupSessions();
  }

  hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(password || ''), salt, SCRYPT_KEY_LENGTH).toString('hex');
    return `scrypt$${salt}$${hash}`;
  }

  verifyPassword(password, encoded) {
    if (String(encoded || '').startsWith('scrypt$')) {
      const [, salt, expected] = String(encoded).split('$');
      const actual = crypto.scryptSync(String(password || ''), salt, SCRYPT_KEY_LENGTH);
      const expectedBuffer = Buffer.from(expected || '', 'hex');
      return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
    }
    const legacy = crypto.createHash('sha256').update(String(password || ''), 'utf8').digest('hex');
    return expectedSafeEqual(legacy, encoded);
  }

  persistAccounts() {
    StorageHelper.saveJson(ACCOUNT_FILE, this.accounts);
  }

  persistSessions() {
    StorageHelper.saveJson(SESSION_FILE, this.sessions);
  }

  cleanupSessions() {
    const now = Date.now();
    Object.keys(this.sessions).forEach(token => {
      if (!this.sessions[token] || this.sessions[token].expiresAt <= now) delete this.sessions[token];
    });
    this.persistSessions();
  }

  publicAccount(account) {
    if (!account) return null;
    return {
      id: account.id,
      username: account.username,
      displayName: account.displayName || account.username,
      email: account.email || '',
      role: account.role || 'user',
      clientAccess: this.clientAccess(account),
      ...require('./account_roles').effective(account),
      ...(account.tenantId ? { tenantId: account.tenantId } : {}),
      createdAt: account.createdAt || null,
      lastLoginAt: account.lastLoginAt || null
    };
  }

  // Which client an account may sign in to: 'chat' (/chat only), 'admin' (the management app
  // only) or 'both'. Accounts saved before this setting existed keep 'both'.
  clientAccess(account) {
    return ['chat', 'admin'].includes(account?.clientAccess) ? account.clientAccess : 'both';
  }

  canUseClient(account, client) {
    const access = this.clientAccess(account);
    return client === 'chat' ? access !== 'admin' : access !== 'chat';
  }

  requireAccountAdmin(actorId) {
    if (!this.accounts.some(account => account.id === actorId && account.isActive !== false && account.role === 'admin'))
      throw Object.assign(new Error('Chỉ quản trị viên được quản lý tài khoản.'), { statusCode: 403 });
  }

  managedAccount(account) {
    return { ...this.publicAccount(account), permissionOverrides:account.permissions??null, dataOverrides:account.dataAccess??null, extraFunctionGroups:account.extraFunctionGroups||[],
      isActive: account.isActive !== false, revision: account.managementRevision || 0 };
  }

  listAccounts(actorId) {
    this.requireAccountAdmin(actorId);
    return this.accounts.map(account => this.managedAccount(account));
  }

  validateAccountFields(input) {
    const fail = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };
    if (typeof input.displayName !== 'string' || !input.displayName.trim() || input.displayName.trim().length > 100) fail('Tên hiển thị phải có từ 1 đến 100 ký tự.');
    if (typeof input.email !== 'string' || input.email.length > 254 || (input.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim()))) fail('Email không hợp lệ.');
    const roles=require('./account_roles');
    if (!roles.get(input.role) || typeof input.isActive !== 'boolean') fail('Vai trò hoặc trạng thái không hợp lệ.');
    if (input.clientAccess !== undefined && !['chat', 'admin', 'both'].includes(input.clientAccess)) fail('Phạm vi sử dụng không hợp lệ.');
    return { displayName: input.displayName.trim(), email: input.email.trim(), role: input.role, isActive: input.isActive,
      ...(input.clientAccess !== undefined ? { clientAccess: input.clientAccess } : {}),
      ...(input.permissions!==undefined?{permissions:input.permissions===null?null:roles.validatePermissions(input.permissions)}:{}),
      ...(input.dataAccess!==undefined?{dataAccess:roles.validateDataAccess(input.dataAccess)}:{}),
      ...(input.extraFunctionGroups!==undefined?{extraFunctionGroups:roles.validateFunctionGroups(input.extraFunctionGroups||[])}:{}) };
  }

  validateNewPassword(password) {
    if (typeof password !== 'string' || password.length < 8 || password.length > 128)
      throw Object.assign(new Error('Mật khẩu phải có từ 8 đến 128 ký tự.'), { statusCode: 400 });
  }

  createAccount(actorId, input) {
    this.requireAccountAdmin(actorId);
    const fields = this.validateAccountFields(input);
    if (typeof input.username !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/.test(input.username.trim()))
      throw Object.assign(new Error('Tên đăng nhập gồm 3–64 ký tự: chữ, số, dấu chấm, gạch dưới hoặc gạch ngang.'), { statusCode: 400 });
    const username = input.username.trim();
    if (this.accounts.some(account => account.username.toLowerCase() === username.toLowerCase()))
      throw Object.assign(new Error('Tên đăng nhập đã tồn tại.'), { statusCode: 409 });
    this.validateNewPassword(input.password);
    const account = { id: crypto.randomUUID(), username, ...fields, passwordHash: this.hashPassword(input.password),
      createdAt: new Date().toISOString(), lastLoginAt: null, managementRevision: 1 };
    this.accounts.push(account); this.persistAccounts();
    return this.managedAccount(account);
  }

  updateAccount(actorId, id, input) {
    this.requireAccountAdmin(actorId);
    const account = this.accounts.find(item => item.id === id);
    if (!account) throw Object.assign(new Error('Không tìm thấy tài khoản.'), { statusCode: 404 });
    if (!Number.isInteger(input.revision) || input.revision !== (account.managementRevision || 0))
      throw Object.assign(new Error('Tài khoản đã thay đổi. Hãy tải lại trước khi lưu.'), { statusCode: 409 });
    const fields = this.validateAccountFields(input);
    if (actorId === id && (!fields.isActive || fields.role !== 'admin' || fields.clientAccess === 'chat'))
      throw Object.assign(new Error('Không thể tự khóa, hạ quyền hoặc bỏ quyền vào trang quản lý của tài khoản đang đăng nhập.'), { statusCode: 400 });
    // A manager is an active admin who may open the management app.
    const manages = item => item.role === 'admin' && item.isActive !== false && this.clientAccess(item) !== 'chat';
    if (manages(account) && !manages({ ...account, ...fields })
      && !this.accounts.some(item => item.id !== id && manages(item)))
      throw Object.assign(new Error('Phải giữ ít nhất một quản trị viên đang hoạt động được vào trang quản lý.'), { statusCode: 409 });
    const revoke = (account.role || 'user') !== fields.role || (account.isActive !== false) !== fields.isActive
      || (fields.permissions!==undefined&&JSON.stringify(fields.permissions)!==JSON.stringify(account.permissions??null))
      || (fields.dataAccess!==undefined&&JSON.stringify(fields.dataAccess)!==JSON.stringify(account.dataAccess??null))
      || (fields.extraFunctionGroups!==undefined&&JSON.stringify(fields.extraFunctionGroups)!==JSON.stringify(account.extraFunctionGroups||[]));
    Object.assign(account, fields, { managementRevision: (account.managementRevision || 0) + 1 });
    if (revoke) account.securityVersion = (account.securityVersion || 0) + 1;
    this.persistAccounts();
    if (revoke) this.revokeAccountSessions(id);
    return this.managedAccount(account);
  }

  revokeAccountSessions(id) {
    for (const [token, session] of Object.entries(this.sessions)) if (session.accountId === id) delete this.sessions[token];
    this.persistSessions();
  }

  resetAccountPassword(actorId, id, input) {
    this.requireAccountAdmin(actorId);
    const account = this.accounts.find(item => item.id === id);
    if (!account) throw Object.assign(new Error('Không tìm thấy tài khoản.'), { statusCode: 404 });
    if (!Number.isInteger(input.revision) || input.revision !== (account.managementRevision || 0))
      throw Object.assign(new Error('Tài khoản đã thay đổi. Hãy tải lại trước khi đặt mật khẩu.'), { statusCode: 409 });
    this.validateNewPassword(input.password);
    account.passwordHash = this.hashPassword(input.password);
    account.securityVersion = (account.securityVersion || 0) + 1;
    account.managementRevision = (account.managementRevision || 0) + 1;
    this.persistAccounts(); this.revokeAccountSessions(id);
    return this.managedAccount(account);
  }

  login(username, password) {
    const account = this.accounts.find(acc =>
      acc.isActive !== false && String(acc.username).toLowerCase() === String(username || '').toLowerCase()
    );
    if (!account || !this.verifyPassword(password, account.passwordHash)) return null;
    if (!String(account.passwordHash).startsWith('scrypt$')) {
      account.passwordHash = this.hashPassword(password);
      for (const [existingToken, session] of Object.entries(this.sessions)) {
        if (session.accountId === account.id) delete this.sessions[existingToken];
      }
    }
    const token = crypto.randomBytes(32).toString('hex');
    account.lastLoginAt = new Date().toISOString();
    this.sessions[token] = {
      accountId: account.id,
      securityVersion: account.securityVersion || 0,
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_MS,
      persistedAt: Date.now()
    };
    this.persistAccounts();
    this.persistSessions();
    return { token, account: this.publicAccount(account), maxAge: Math.floor(SESSION_TTL_MS / 1000) };
  }

  updateProfile(accountId,{displayName,email}={}) {
    if(typeof displayName!=='string'||!displayName.trim()||displayName.trim().length>100||typeof email!=='string'||email.length>254||(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw Object.assign(new Error('Tên hoặc email không hợp lệ.'),{statusCode:400});
    const account=this.accounts.find(item=>item.id===accountId&&item.isActive!==false);
    if(!account) throw Object.assign(new Error('Tài khoản không tồn tại.'),{statusCode:404});
    account.displayName=displayName.trim();account.email=email.trim();this.persistAccounts();
    return this.publicAccount(account);
  }

  changePassword(accountId, currentPassword, newPassword) {
    const fail=(message,statusCode=400)=>{throw Object.assign(new Error(message),{statusCode});};
    if(typeof currentPassword!=='string'||currentPassword.length>1024||typeof newPassword!=='string'||newPassword.length<8||newPassword.length>128) fail('Mật khẩu mới phải có từ 8 đến 128 ký tự.');
    const account=this.accounts.find(item=>item.id===accountId&&item.isActive!==false);
    if(!account||!this.verifyPassword(currentPassword,account.passwordHash)) fail('Mật khẩu hiện tại không đúng.',400);
    if(this.verifyPassword(newPassword,account.passwordHash)) fail('Mật khẩu mới phải khác mật khẩu hiện tại.');
    account.passwordHash=this.hashPassword(newPassword);
    account.securityVersion=(account.securityVersion||0)+1;
    account.managementRevision=(account.managementRevision||0)+1;
    for(const [token,session] of Object.entries(this.sessions)) if(session.accountId===accountId) delete this.sessions[token];
    this.persistAccounts();this.persistSessions();
    return true;
  }

  logout(token) {
    if (token && this.sessions[token]) {
      delete this.sessions[token];
      this.persistSessions();
    }
  }

  getAccountBySession(token, { touch = true } = {}) {
    if (!token || !this.sessions[token]) return null;
    const session = this.sessions[token];
    if (session.expiresAt <= Date.now()) {
      if (touch) { delete this.sessions[token]; this.persistSessions(); }
      return null;
    }
    const now = Date.now();
    if (touch) session.expiresAt = now + SESSION_TTL_MS;
    if (touch && (!session.persistedAt || now - session.persistedAt >= SESSION_TOUCH_INTERVAL_MS)) {
      session.persistedAt = now;
      this.persistSessions();
    }
    const account = this.accounts.find(acc => acc.id === session.accountId && acc.isActive !== false);
    if (account && (session.securityVersion || 0) !== (account.securityVersion || 0)) return null;
    return this.publicAccount(account);
  }

  getSessionMaxAge() {
    return Math.floor(SESSION_TTL_MS / 1000);
  }
}

function expectedSafeEqual(actual, expected) {
  const left = Buffer.from(String(actual || ''));
  const right = Buffer.from(String(expected || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

module.exports = new AuthService();
