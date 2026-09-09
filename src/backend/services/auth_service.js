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
    this.accounts = StorageHelper.loadJson(ACCOUNT_FILE, null);
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
    this.sessions = StorageHelper.loadJson(SESSION_FILE, {});
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
      role: account.role || 'user',
      createdAt: account.createdAt || null,
      lastLoginAt: account.lastLoginAt || null
    };
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
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_MS,
      persistedAt: Date.now()
    };
    this.persistAccounts();
    this.persistSessions();
    return { token, account: this.publicAccount(account), maxAge: Math.floor(SESSION_TTL_MS / 1000) };
  }

  logout(token) {
    if (token && this.sessions[token]) {
      delete this.sessions[token];
      this.persistSessions();
    }
  }

  getAccountBySession(token) {
    if (!token || !this.sessions[token]) return null;
    const session = this.sessions[token];
    if (session.expiresAt <= Date.now()) {
      delete this.sessions[token];
      this.persistSessions();
      return null;
    }
    const now = Date.now();
    session.expiresAt = now + SESSION_TTL_MS;
    if (!session.persistedAt || now - session.persistedAt >= SESSION_TOUCH_INTERVAL_MS) {
      session.persistedAt = now;
      this.persistSessions();
    }
    const account = this.accounts.find(acc => acc.id === session.accountId && acc.isActive !== false);
    return this.publicAccount(account);
  }
}

function expectedSafeEqual(actual, expected) {
  const left = Buffer.from(String(actual || ''));
  const right = Buffer.from(String(expected || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

module.exports = new AuthService();
