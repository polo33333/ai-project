/**
 * Persistent Data Storage Helper (JSON File Persistence Engine)
 * Automatically saves and restores Database Connectors, Data Dictionary,
 * AI Providers, MCP Servers, and API Keys across server restarts.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../../data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

class StorageHelper {
  static loadJson(filename, defaultValue = []) {
    const filePath = path.join(DATA_DIR, filename);
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
      }
    } catch (err) {
      console.warn(`[StorageHelper] Lỗi đọc tệp persistent '${filename}': ${err.message}`);
    }
    return defaultValue;
  }

  static saveJson(filename, data) {
    const filePath = path.join(DATA_DIR, filename);
    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.error(`[StorageHelper] Lỗi lưu tệp persistent '${filename}': ${err.message}`);
    }
  }
}

module.exports = StorageHelper;
