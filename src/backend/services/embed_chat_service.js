const StorageHelper = require('../utils/storage_helper');

class EmbedChatService {
  constructor() {
    this.configs = StorageHelper.loadJson('embed_chat_configs.json', []);
    this.rateBuckets = new Map();
  }

  persist() {
    StorageHelper.saveJson('embed_chat_configs.json', this.configs);
  }

  normalizeOrigin(value) {
    try {
      return new URL(String(value || '').trim()).origin.toLowerCase();
    } catch {
      return '';
    }
  }

  getConfigs() {
    return this.configs;
  }

  createConfig(data = {}) {
    const name = String(data.name || '').trim();
    const allowedOrigins = [...new Set((Array.isArray(data.allowedOrigins) ? data.allowedOrigins : String(data.allowedOrigins || '').split(/[\n,]+/))
      .map(value => this.normalizeOrigin(value)).filter(Boolean))];
    if (!name) throw new Error('Tên cấu hình Embed không được để trống.');
    if (allowedOrigins.length === 0) throw new Error('Cần khai báo ít nhất một domain hợp lệ.');
    const config = {
      id: `emb_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      name,
      allowedOrigins,
      rateLimit: Math.min(300, Math.max(1, Number(data.rateLimit) || 30)),
      maxQuestionLength: Math.min(8000, Math.max(100, Number(data.maxQuestionLength) || 2000)),
      maxHistory: Math.min(20, Math.max(0, Number(data.maxHistory) || 10)),
      maxRows: Math.min(100, Math.max(1, Number(data.maxRows) || 20)),
      isActive: true,
      createdAt: new Date().toISOString(),
      lastUsedAt: null
    };
    this.configs.unshift(config);
    this.persist();
    return config;
  }

  toggleConfig(id, isActive) {
    const config = this.configs.find(item => item.id === id);
    if (!config) throw new Error('Không tìm thấy cấu hình Embed.');
    config.isActive = Boolean(isActive);
    this.persist();
    return config;
  }

  updateConfig(id, data = {}) {
    const config = this.configs.find(item => item.id === id);
    if (!config) throw new Error('Không tìm thấy cấu hình Embed.');
    const name = String(data.name || '').trim();
    const allowedOrigins = [...new Set((Array.isArray(data.allowedOrigins) ? data.allowedOrigins : String(data.allowedOrigins || '').split(/[\n,]+/))
      .map(value => this.normalizeOrigin(value)).filter(Boolean))];
    if (!name) throw new Error('Tên cấu hình Embed không được để trống.');
    if (allowedOrigins.length === 0) throw new Error('Cần khai báo ít nhất một domain hợp lệ.');
    Object.assign(config, {
      name,
      allowedOrigins,
      rateLimit: Math.min(300, Math.max(1, Number(data.rateLimit) || 30)),
      maxRows: Math.min(100, Math.max(1, Number(data.maxRows) || 20)),
      updatedAt: new Date().toISOString()
    });
    this.persist();
    return config;
  }

  deleteConfig(id) {
    const before = this.configs.length;
    this.configs = this.configs.filter(item => item.id !== id);
    if (this.configs.length === before) throw new Error('Không tìm thấy cấu hình Embed.');
    this.persist();
  }

  authorize(embedId, origin, ipAddress, options = {}) {
    const config = this.configs.find(item => item.id === String(embedId || '') && item.isActive);
    if (!config) return { ok: false, status: 401, message: 'Embed ID không hợp lệ hoặc đã bị tắt.' };
    const normalizedOrigin = this.normalizeOrigin(origin);
    if (!options.skipOrigin && (!normalizedOrigin || !config.allowedOrigins.includes(normalizedOrigin))) {
      return { ok: false, status: 403, message: 'Domain này không được phép sử dụng Embed Chat.' };
    }
    const minute = Math.floor(Date.now() / 60000);
    const bucketKey = `${config.id}:${ipAddress || 'unknown'}:${minute}`;
    const used = (this.rateBuckets.get(bucketKey) || 0) + 1;
    this.rateBuckets.set(bucketKey, used);
    if (this.rateBuckets.size > 5000) {
      for (const key of this.rateBuckets.keys()) if (!key.endsWith(`:${minute}`)) this.rateBuckets.delete(key);
    }
    if (used > config.rateLimit) return { ok: false, status: 429, message: 'Đã vượt giới hạn yêu cầu. Vui lòng thử lại sau.' };
    config.lastUsedAt = new Date().toISOString();
    this.persist();
    return { ok: true, config, origin: normalizedOrigin };
  }
}

module.exports = new EmbedChatService();
