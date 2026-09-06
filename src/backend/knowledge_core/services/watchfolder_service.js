const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const StorageHelper = require('../../utils/storage_helper');
const libraryService = require('./library_service');

class WatchFolderService {
  constructor() {
    this.folders = StorageHelper.loadJson('watchfolders.json', []);
    this.logs = StorageHelper.loadJson('watchfolder_logs.json', []);
    this.watchers = new Map();
    this.processing = new Set();
    this.debounceTimers = new Map();
  }

  persist() { StorageHelper.saveJson('watchfolders.json', this.folders); StorageHelper.saveJson('watchfolder_logs.json', this.logs); }
  getFolders() { return this.folders; }
  getLogs() { return this.logs; }

  validateDirectory(folderPath) {
    const resolved = path.resolve(String(folderPath || '').trim());
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error('Thư mục không tồn tại hoặc backend không có quyền đọc.');
    return resolved;
  }

  matchingFiles(folder) {
    try {
      const filters = new Set((folder.filters || []).map(value => String(value).toLowerCase()));
      return fs.readdirSync(folder.path, { withFileTypes: true }).filter(entry => entry.isFile() && filters.has(path.extname(entry.name).toLowerCase())).map(entry => path.join(folder.path, entry.name));
    } catch (_) { return []; }
  }

  updateStats(folder) {
    folder.scannedFiles = this.matchingFiles(folder).length;
    folder.lastScan = new Date().toLocaleString('vi-VN');
    this.persist();
  }

  addLog(folder, filePath, event, vectorsIndexed = 0, error = null) {
    this.logs.unshift({ id: `wfl-${Date.now()}-${Math.floor(Math.random() * 1000)}`, fileName: path.basename(filePath), folderPath: folder.path, event, vectorsIndexed, error, timestamp: new Date().toLocaleString('vi-VN') });
    if (this.logs.length > 500) this.logs.length = 500;
    this.persist();
  }

  async processFile(folder, filePath, event = 'Phát hiện tệp mới') {
    const resolved = path.resolve(filePath);
    if (this.processing.has(resolved) || !fs.existsSync(resolved)) return;
    const ext = path.extname(resolved).toLowerCase();
    if (!(folder.filters || []).map(x => x.toLowerCase()).includes(ext)) return;
    this.processing.add(resolved);
    try {
      const before = fs.statSync(resolved);
      await new Promise(resolve => setTimeout(resolve, 350));
      const after = fs.statSync(resolved);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) return this.scheduleFile(folder, resolved, event);
      const buffer = fs.readFileSync(resolved);
      const fingerprint = crypto.createHash('sha256').update(buffer).digest('hex');
      const existing = libraryService.findBySourcePath(resolved) || libraryService.claimLegacyWatchDocument(resolved, path.basename(resolved));
      if (existing?.sourceFingerprint === fingerprint && existing.status === 'Đã lập chỉ mục') {
        this.updateStats(folder);
        return;
      }
      const document = await libraryService.addDocument({
        title: path.basename(resolved),
        fileType: ext.slice(1).toUpperCase(),
        size: this.formatBytes(after.size),
        category: 'Watch Folder',
        contentBase64: buffer.toString('base64'),
        sourcePath: resolved,
        sourceFingerprint: fingerprint,
        sourceModifiedAt: after.mtimeMs
      });
      if (document.duplicate) {
        this.addLog(folder, resolved, 'Bỏ qua tệp trùng', document.chunksCount || 0, null);
        this.updateStats(folder);
        return;
      }
      this.addLog(folder, resolved, document.status === 'Lỗi xử lý' ? 'Lỗi xử lý' : event, document.chunksCount || 0, document.error || null);
      this.updateStats(folder);
    } catch (error) {
      this.addLog(folder, resolved, 'Lỗi nạp tệp', 0, error.message);
    } finally { this.processing.delete(resolved); }
  }

  scheduleFile(folder, filePath, event) {
    const key = path.resolve(filePath);
    clearTimeout(this.debounceTimers.get(key));
    this.debounceTimers.set(key, setTimeout(() => { this.debounceTimers.delete(key); this.processFile(folder, key, event); }, 800));
  }

  formatBytes(bytes) {
    if (!bytes) return '0 B'; const units = ['B', 'KB', 'MB', 'GB']; const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3); return `${(bytes / (1024 ** index)).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
  }

  async startFolder(folder, importExisting = false) {
    this.stopFolder(folder.id);
    try {
      folder.path = this.validateDirectory(folder.path);
      folder.runtimeStatus = 'Watching';
      folder.error = null;
      const existing = this.matchingFiles(folder);
      folder.scannedFiles = existing.length;
      folder.lastScan = new Date().toLocaleString('vi-VN');
      this.watchers.set(folder.id, fs.watch(folder.path, { persistent: false }, (eventType, filename) => {
        if (!filename || folder.status !== 'Active') return;
        const filePath = path.join(folder.path, String(filename));
        if (eventType === 'rename' || eventType === 'change') this.scheduleFile(folder, filePath, eventType === 'rename' ? 'Tệp mới' : 'Tệp cập nhật');
      }));
      this.watchers.get(folder.id).on('error', error => { folder.runtimeStatus = 'Error'; folder.error = error.message; this.persist(); });
      this.persist();
      if (importExisting) for (const filePath of existing) await this.processFile(folder, filePath, 'Quét ban đầu');
    } catch (error) { folder.runtimeStatus = 'Error'; folder.error = error.message; this.persist(); }
    return folder;
  }

  stopFolder(id) { const watcher = this.watchers.get(id); if (watcher) watcher.close(); this.watchers.delete(id); }
  async start() { for (const folder of this.folders.filter(item => item.status === 'Active')) await this.startFolder(folder, true); }
  async stop() { for (const id of [...this.watchers.keys()]) this.stopFolder(id); for (const timer of this.debounceTimers.values()) clearTimeout(timer); }

  async addFolder(folderPath, filters) {
    const normalizedPath = this.validateDirectory(folderPath);
    if (this.folders.some(folder => path.resolve(folder.path).toLowerCase() === normalizedPath.toLowerCase())) throw new Error('Thư mục này đã được cấu hình giám sát.');
    const folder = { id: `wf-${Date.now()}`, path: normalizedPath, filters: Array.isArray(filters) && filters.length ? filters : ['.sql', '.pdf', '.docx'], scannedFiles: 0, status: 'Active', runtimeStatus: 'Starting', lastScan: 'Chưa quét', error: null };
    this.folders.unshift(folder); this.persist(); await this.startFolder(folder, true); return folder;
  }

  deleteFolder(id) { this.stopFolder(id); const before = this.folders.length; this.folders = this.folders.filter(item => item.id !== id); this.persist(); return this.folders.length < before; }
  async toggleFolderStatus(id) { const folder = this.folders.find(item => item.id === id); if (!folder) return null; if (folder.status === 'Active') { folder.status = 'Paused'; folder.runtimeStatus = 'Paused'; this.stopFolder(id); } else { folder.status = 'Active'; await this.startFolder(folder, false); } this.persist(); return folder; }
}

module.exports = new WatchFolderService();
