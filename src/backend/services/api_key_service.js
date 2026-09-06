/**
 * 3rd-Party API Integration & Secret Key Management Service
 * Generates API Keys for external services to access KnowledgeHub AI REST APIs
 * Persistent storage enabled via StorageHelper to ./data/api_keys.json
 */

const StorageHelper = require('../utils/storage_helper');

class ApiKeyService {
  constructor() {
    const defaultKeys = [
      {
        id: "key-1",
        name: "ERP System Integration Key",
        key: "kh_live_8f9a2b7c4d1e6f0a3b5c7d9e1f2a4b6c",
        createdDate: new Date(Date.now() - 86400000 * 5).toLocaleDateString('vi-VN'),
        lastUsed: "Vừa xong",
        status: "active",
        rateLimit: "1,000 req/min"
      },
      {
        id: "key-2",
        name: "Mobile App Backend Key",
        key: "kh_live_3e5f7a9b1c3d5e7f9a1b3c5d7e9f1a3b",
        createdDate: new Date(Date.now() - 86400000 * 2).toLocaleDateString('vi-VN'),
        lastUsed: "2 giờ trước",
        status: "active",
        rateLimit: "500 req/min"
      }
    ];

    this.apiKeys = StorageHelper.loadJson('api_keys.json', defaultKeys);
  }

  persist() {
    StorageHelper.saveJson('api_keys.json', this.apiKeys);
  }

  getKeys() {
    return this.apiKeys;
  }

  validateKey(value) {
    const keyValue = String(value || '').trim();
    const found = this.apiKeys.find(item => item.key === keyValue && item.status === 'active');
    if (!found) return null;
    found.lastUsed = new Date().toLocaleString('vi-VN');
    this.persist();
    return found;
  }

  generateKey(name, rateLimit) {
    const randomHex = Array.from({length: 32}, () => Math.floor(Math.random() * 16).toString(16)).join('');
    const newKey = {
      id: `key-${Date.now()}`,
      name: name || "3rd-Party Client Key",
      key: `kh_live_${randomHex}`,
      createdDate: new Date().toLocaleDateString('vi-VN'),
      lastUsed: "Chưa sử dụng",
      status: "active",
      rateLimit: rateLimit || "500 req/min"
    };

    this.apiKeys.unshift(newKey);
    this.persist();
    return newKey;
  }

  revokeKey(id) {
    this.apiKeys = this.apiKeys.filter(k => k.id !== id);
    this.persist();
    return true;
  }
}

module.exports = new ApiKeyService();
