/**
 * Persistent Data Storage Helper (JSON File Persistence Engine)
 * Automatically saves and restores Database Connectors, Data Dictionary,
 * AI Providers, MCP Servers, and API Keys across server restarts.
 */

const fs = require('fs');
const path = require('path');

const storage = require('../storage');
if (process.env.KNOWLEDGEHUB_TEST_ISOLATED !== '1') storage.loadEnvironment();
if (process.env.APP_STORAGE_BACKEND && !['json', 'postgres'].includes(process.env.APP_STORAGE_BACKEND)) throw new Error('Unknown APP_STORAGE_BACKEND.');

const DATA_DIR = path.resolve(process.env.KNOWLEDGEHUB_DATA_DIR || path.join(__dirname, '../../../data'));

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

class StorageHelper {
  static loadJson(filename, defaultValue = []) {
    if (storage.enabled()) return storage.read(filename, defaultValue);
    const filePath = path.join(DATA_DIR, filename);
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
      }
    } catch (err) {
      console.error(`[StorageHelper] Lỗi đọc tệp persistent '${filename}': ${err.message}`);
      throw err;
    }
    return defaultValue;
  }

  static saveJson(filename, data) {
    if (storage.enabled()) return storage.write(filename, data);
    const filePath = path.join(DATA_DIR, filename);
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      const payload = JSON.stringify(data, null, 2);
      const descriptor = fs.openSync(tempPath, 'wx', 0o600);
      try {
        fs.writeFileSync(descriptor, payload, 'utf8');
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(tempPath, filePath);
      return true;
    } catch (err) {
      try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
      console.error(`[StorageHelper] Lỗi lưu tệp persistent '${filename}': ${err.message}`);
      throw err;
    }
  }

  static getDataDirectory() { return DATA_DIR; }

  // Service fields are operation-scoped views, never singleton database copies.
  // Database I/O is awaited by storage.run/flush before sending a response.
  static bind(service, property, filename, fallback, transform) {
    if (storage.enabled()) return storage.bind(service, property, filename, fallback, transform);
    const value = this.loadJson(filename, fallback);
    service[property] = transform ? transform(value) : value;
  }
}

module.exports = StorageHelper;
