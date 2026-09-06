/**
 * Lightweight JSON-backed authentication service.
 */

const crypto = require('crypto');
const StorageHelper = require('../utils/storage_helper');

const ACCOUNT_FILE = 'accounts.json';
const SESSION_FILE = 'sessions.json';
const SESSION_TTL_MS = 1000 * 60 * 60 * 8;

class AuthService {
  constructor() {
    this.accounts = StorageHelper.loadJson(ACCOUNT_FILE, null);
    if (!Array.isArray(this.accounts) || this.accounts.length === 0) {
      this.accounts = [{
        id: 'admin',
        username: 'admin',
        displayName: 'Admin AI',
        role: 'admin',
        passwordHash: this.hashPassword('admin123'),
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
    return crypto.createHash('sha256').update(String(password || ''), 'utf8').digest('hex');
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
    if (!account || account.passwordHash !== this.hashPassword(password)) return null;
    const token = crypto.randomBytes(32).toString('hex');
    account.lastLoginAt = new Date().toISOString();
    this.sessions[token] = {
      accountId: account.id,
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_MS
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
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    this.persistSessions();
    const account = this.accounts.find(acc => acc.id === session.accountId && acc.isActive !== false);
    return this.publicAccount(account);
  }
}

module.exports = new AuthService();
