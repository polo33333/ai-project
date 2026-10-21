const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const StorageHelper = require('../../utils/storage_helper');
const storage = require('../../storage');
const qdrantService = require('../../services/qdrant_service');
const structuredDocument = require('./structured_document');

const DATA_DIR = StorageHelper.getDataDirectory();
const FILES_DIR = path.join(DATA_DIR, 'library_files');
const CONTENT_DIR = path.join(DATA_DIR, 'library_content');
for (const dir of [FILES_DIR, CONTENT_DIR]) fs.mkdirSync(dir, { recursive: true });

class LibraryService {
  constructor() {
    this.chunkCache = new Map();
    StorageHelper.bind(this, 'documents', 'library.json', []);
    this.maxFileBytes = Math.max(1024 * 1024, Number(process.env.LIBRARY_MAX_FILE_MB || 20) * 1024 * 1024);
    if (this.repairManagedPaths()) this.persist();
  }

  repairManagedPaths() {
    let changed = false;
    const managedFiles = fs.readdirSync(FILES_DIR);
    for (const document of this.documents) {
      if (!document?.id) continue;

      if (!document.storagePath || !fs.existsSync(document.storagePath)) {
        const storedName = document.storagePath ? path.basename(document.storagePath) : '';
        const matchingName = (storedName && managedFiles.includes(storedName) ? storedName : null)
          || managedFiles.find(name => name.startsWith(`${document.id}-`));
        if (matchingName) {
          const repairedStoragePath = path.join(FILES_DIR, matchingName);
          if (document.storagePath !== repairedStoragePath) {
            document.storagePath = repairedStoragePath;
            changed = true;
          }
        }
      }

      if (!document.contentPath || !fs.existsSync(document.contentPath)) {
        const repairedContentPath = path.join(CONTENT_DIR, `${document.id}.txt`);
        if (fs.existsSync(repairedContentPath) && document.contentPath !== repairedContentPath) {
          document.contentPath = repairedContentPath;
          changed = true;
        }
      }
    }
    return changed;
  }

  persist() { StorageHelper.saveJson('library.json', this.documents); }
  getDocuments() { return this.documents.filter(document => require('../../governance/context').canRead(document)).map(({ storagePath, contentPath, manifestPath, sourceFingerprint, ...item }) => item); }
  findDocument(id) { return this.documents.find(item => item.id === id); }
  findByFingerprint(fingerprint) {
    return fingerprint ? this.documents.find(item => item.sourceFingerprint === fingerprint) : null;
  }
  findBySourcePath(filePath) {
    const resolved = path.resolve(String(filePath || '')).toLowerCase();
    return this.documents.find(item => item.sourcePath && path.resolve(item.sourcePath).toLowerCase() === resolved);
  }
  claimLegacyWatchDocument(filePath, title) {
    const existing = this.findBySourcePath(filePath);
    if (existing) return existing;
    const legacy = this.documents.find(item => !item.sourcePath && item.category === 'Watch Folder' && item.title === title);
    if (!legacy) return null;
    legacy.sourcePath = path.resolve(filePath);
    this.persist();
    return legacy;
  }
  isManagedFile(filePath) {
    const resolved = path.resolve(String(filePath || '')).toLowerCase();
    return this.documents.some(item =>
      (item.sourcePath && path.resolve(item.sourcePath).toLowerCase() === resolved) ||
      (item.storagePath && path.resolve(item.storagePath).toLowerCase() === resolved)
    );
  }

  sanitizeName(value) {
    return path.basename(String(value || 'document')).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-180);
  }

  async extractText(buffer, fileType) {
    const parts = await structuredDocument.extract(buffer, fileType);
    return this.partsText(parts);
  }

  partsText(parts) {
    return parts.map(part => part.rows
      ? `${part.sheet ? `# Sheet: ${part.sheet}\n` : ''}${part.rows.map(row => row.join(' | ')).join('\n')}`
      : part.text).join('\n\n');
  }

  cleanText(value) {
    return String(value || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  chunkText(text, maxChars = 2200, overlap = 250) {
    overlap = Math.max(0, Math.min(overlap, maxChars - 1));
    const paragraphs = text.split(/\n{2,}/).map(x => x.trim()).filter(Boolean);
    const chunks = [];
    let current = '';
    const push = () => {
      if (!current.trim()) return;
      chunks.push(current.trim());
      current = current.slice(Math.max(0, current.length - overlap));
    };
    for (const paragraph of paragraphs) {
      if (paragraph.length > maxChars) {
        if (current) push();
        for (let start = 0; start < paragraph.length; start += maxChars - overlap) chunks.push(paragraph.slice(start, start + maxChars));
        current = '';
      } else if ((current + '\n\n' + paragraph).length > maxChars) {
        push();
        current += `\n\n${paragraph}`;
      } else current += `${current ? '\n\n' : ''}${paragraph}`;
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks;
  }

  async prepareChunks(document, buffer) {
    const parts = await structuredDocument.extract(buffer, document.fileType);
    const text = this.partsText(parts);
    if (!text.trim()) throw new Error(document.fileType === 'PDF' ? 'PDF không có lớp văn bản; cần OCR cho file scan.' : 'DOCUMENT_HAS_NO_TEXT');
    const revision = crypto.createHash('sha256').update(buffer).update('structured-v1').digest('hex');
    const chunks = structuredDocument.chunks(parts, this.chunkText.bind(this))
      .map(chunk => ({ ...chunk, revision, chunkId: `${document.id}:${revision}:${chunk.chunkIndex}` }));
    const manifestPath = path.join(CONTENT_DIR, `${document.id}-${revision}.chunks.json`);
    const manifest = { version: 1, chunkerVersion: 'structured-v1', documentId: document.id, revision, chunks };
    const serialized = JSON.stringify(manifest);
    const checksum = crypto.createHash('sha256').update(serialized).digest('hex');
    const temporary = `${manifestPath}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, serialized, 'utf8');
    fs.renameSync(temporary, manifestPath);
    const pageCount = Math.max(0, ...parts.map(part => part.page || 0)) || null;
    const wordInfo = document.fileType === 'DOCX' ? structuredDocument.wordPageInfo(buffer) : null;
    return { text, chunks, revision, manifestPath, manifestChecksum: checksum,
      pageCount: wordInfo?.pageCount || pageCount,
      pageCountSource: wordInfo?.pageCountSource || (pageCount ? 'pdf_pages' : null) };
  }

  activateChunks(document, prepared) {
    fs.writeFileSync(document.contentPath, prepared.text, 'utf8');
    Object.assign(document, { revision: prepared.revision, manifestPath: prepared.manifestPath,
      manifestChecksum: prepared.manifestChecksum, chunkerVersion: 'structured-v1', pageCount: prepared.pageCount,
      pageCountSource: prepared.pageCountSource });
    this.chunkCache.delete(document.id);
  }

  getChunks(id) {
    const document = this.findDocument(id);
    if (!document) return [];
    require('../../governance/context').read(document, 'document');
    if (!document.manifestPath) {
      // Legacy documents remain readable until an explicit reindex/backfill.
      return this.chunkText(this.getContent(id).content).map((text, chunkIndex) => ({ text, chunkIndex }));
    }
    const key = `${document.revision}:${document.manifestChecksum}`;
    const cached = this.chunkCache.get(id);
    if (cached?.key === key) return cached.chunks;
    const serialized = fs.readFileSync(document.manifestPath, 'utf8');
    if (crypto.createHash('sha256').update(serialized).digest('hex') !== document.manifestChecksum) throw new Error('DOCUMENT_MANIFEST_CHECKSUM_MISMATCH');
    const manifest = JSON.parse(serialized);
    if (manifest.documentId !== id || manifest.revision !== document.revision) throw new Error('DOCUMENT_MANIFEST_REVISION_MISMATCH');
    if (this.chunkCache.size >= 100) this.chunkCache.delete(this.chunkCache.keys().next().value);
    this.chunkCache.set(id, { key, chunks: manifest.chunks });
    return manifest.chunks;
  }

  async getPageInfo(id) {
    const document = this.findDocument(id);
    if (!document) return null;
    if (document.pageCountSource && Number.isInteger(document.pageCount) && document.pageCount > 0) {
      return { pageCount: document.pageCount, pageCountSource: document.pageCountSource };
    }
    if (document.fileType === 'DOCX') return structuredDocument.wordPageInfo(this.getFile(id).buffer);
    if (document.fileType === 'PDF') {
      // Read real pages for documents ingested before page-count provenance existed.
      const parts = await structuredDocument.extract(this.getFile(id).buffer, 'PDF');
      const pageCount = Math.max(0, ...parts.map(part => part.page || 0));
      return pageCount ? { pageCount, pageCountSource: 'pdf_pages' } : null;
    }
    return null;
  }

  async addDocument(payload) {
    if (!storage.enabled()) return this._addDocument(payload);
    const fingerprint = crypto.createHash('sha256').update(Buffer.from(payload.contentBase64 || '', 'base64')).digest('hex');
    const result = await storage.lease(`document-fingerprint:${fingerprint}`, async () => {
      const document = await this._addDocument(payload);
      await storage.flush();
      return document;
    });
    if (result?.skipped) throw Object.assign(new Error('Tệp này đang được xử lý. Hãy thử lại sau.'), { statusCode: 409 });
    return result;
  }

  async _addDocument({ title, fileType, size, category, contentBase64, sourcePath = null, sourceFingerprint = null, sourceModifiedAt = null }) {
    if (!title || !String(title).trim()) throw new Error('Tên tài liệu không được để trống.');
    if (!contentBase64) throw new Error('Chưa có nội dung file để xử lý.');
    const buffer = Buffer.from(contentBase64, 'base64');
    if (!buffer.length) throw new Error('File rỗng hoặc không hợp lệ.');
    if (buffer.length > this.maxFileBytes) throw new Error(`File vượt quá giới hạn ${Math.round(this.maxFileBytes / 1024 / 1024)} MB.`);
    const normalizedTitle = String(title).trim();
    const type = String(fileType || normalizedTitle.split('.').pop()).toUpperCase();
    const resolvedSourcePath = sourcePath ? path.resolve(sourcePath) : null;
    const effectiveFingerprint = sourceFingerprint || crypto.createHash('sha256').update(buffer).digest('hex');
    let document = resolvedSourcePath ? (this.findBySourcePath(resolvedSourcePath) || this.claimLegacyWatchDocument(resolvedSourcePath, normalizedTitle)) : null;
    const identical = this.findByFingerprint(effectiveFingerprint);
    if (!document && identical) {
      if (resolvedSourcePath && !identical.sourcePath) {
        identical.sourcePath = resolvedSourcePath;
        identical.sourceModifiedAt = sourceModifiedAt || identical.sourceModifiedAt || null;
        this.persist();
      }
      return { ...identical, duplicate: true };
    }
    if (!document) {
      const id = crypto.randomUUID();
      document = { id, storagePath: path.join(FILES_DIR, `${id}-${this.sanitizeName(normalizedTitle)}`), contentPath: path.join(CONTENT_DIR, `${id}.txt`) };
      this.documents.unshift(document);
    }
    Object.assign(document, {
      title: normalizedTitle,
      fileType: type,
      size: size || `${buffer.length} B`,
      sizeBytes: buffer.length,
      category: category || 'Tài liệu Nghiệp vụ',
      status: 'Đang xử lý',
      updatedAt: new Date().toISOString(),
      sourcePath: resolvedSourcePath || document.sourcePath || null,
      sourceFingerprint: effectiveFingerprint,
      sourceModifiedAt: sourceModifiedAt || document.sourceModifiedAt || null,
      error: null
    });
    this.persist();
    if (storage.enabled()) {
      // The database job survives a crash/restart and carries the exact source
      // version. File names include that version so a newer upload cannot
      // overwrite bytes still needed by an older job.
      document.storagePath = path.join(FILES_DIR, `${document.id}-${effectiveFingerprint.slice(0, 16)}-${this.sanitizeName(normalizedTitle)}`);
      document.contentPath = path.join(CONTENT_DIR, `${document.id}-${effectiveFingerprint.slice(0, 16)}.txt`);
      fs.writeFileSync(document.storagePath, buffer);
      document.chunksCount = 0;
      this.persist();
      storage.enqueue('document.ingest', document.id, { fingerprint: effectiveFingerprint });
      return document;
    }
    try {
      fs.writeFileSync(document.storagePath, buffer);
      const prepared = await this.prepareChunks(document, buffer);
      const { text, chunks } = prepared;
      const result = await qdrantService.indexDocumentChunks(document, chunks);
      // The manifest also serves the lexical fallback when Qdrant is unavailable.
      this.activateChunks(document, prepared);
      document.chunksCount = chunks.length;
      document.preview = text.slice(0, 500);
      document.status = result.success ? (result.mode === 'lexical' ? 'Sẵn sàng · Tìm kiếm từ khóa' : 'Đã lập chỉ mục') : 'Đã đọc · Qdrant lỗi';
      document.indexMode = result.mode === 'lexical' ? 'lexical' : 'vector';
      document.error = result.success ? null : result.error;
    } catch (error) {
      document.status = 'Lỗi xử lý';
      document.error = error.message;
    }
    this.persist();
    return document;
  }

  getContent(id) {
    const document = this.findDocument(id);
    if (!document) throw new Error('Không tìm thấy tài liệu.');
    require('../../governance/context').read(document, 'document');
    const content = document.contentPath && fs.existsSync(document.contentPath) ? fs.readFileSync(document.contentPath, 'utf8') : '';
    return { document: this.getDocuments().find(item => item.id === id), content };
  }

  getFile(id) {
    const document = this.findDocument(id);
    if (!document || !document.storagePath || !fs.existsSync(document.storagePath)) throw new Error('Không tìm thấy file gốc.');
    require('../../governance/context').read(document, 'document');
    return { document, buffer: fs.readFileSync(document.storagePath) };
  }

  async deleteDocument(id) {
    const document = this.findDocument(id);
    if (!document) return false;
    if (storage.enabled()) {
      storage.enqueue('document.delete', id, { paths: [document.storagePath, document.contentPath, document.manifestPath] });
      this.documents = this.documents.filter(item => item.id !== id);
      this.persist();
      return true;
    }
    for (const filePath of [document.storagePath, document.contentPath, document.manifestPath]) {
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    await qdrantService.deleteDocumentChunks(id);
    this.documents = this.documents.filter(item => item.id !== id);
    this.persist();
    return true;
  }

  async reindexAll() {
    if (storage.enabled()) {
      for (const document of this.documents) {
        document.status = 'Đang xử lý';
        storage.enqueue('document.ingest', document.id, { fingerprint: document.sourceFingerprint || null });
      }
      this.persist();
      return { total: this.documents.length, indexed: 0, queued: this.documents.length, failed: [] };
    }
    const summary = { total: this.documents.length, indexed: 0, failed: [] };
    for (const document of this.documents) {
      try {
        const prepared = await this.prepareChunks(document, fs.readFileSync(document.storagePath));
        const { chunks } = prepared;
        const result = await qdrantService.indexDocumentChunks(document, chunks);
        if (!result.success) throw new Error(result.error || 'Qdrant indexing failed');
        this.activateChunks(document, prepared);
        document.chunksCount = chunks.length;
        document.status = result.mode === 'lexical' ? 'Sẵn sàng · Tìm kiếm từ khóa' : 'Đã lập chỉ mục';
        document.indexMode = result.mode === 'lexical' ? 'lexical' : 'vector';
        document.error = null;
        document.updatedAt = new Date().toISOString();
        summary.indexed++;
      } catch (error) {
        document.status = 'Lỗi tái lập chỉ mục';
        document.error = error.message;
        summary.failed.push({ id: document.id, title: document.title, error: error.message });
      }
      this.persist();
    }
    return summary;
  }

  async deduplicateExactCopies() {
    const groups = new Map();
    for (const document of this.documents) {
      try {
        if (!document.sourceFingerprint && document.storagePath && fs.existsSync(document.storagePath)) {
          document.sourceFingerprint = crypto.createHash('sha256').update(fs.readFileSync(document.storagePath)).digest('hex');
        }
        if (!document.sourceFingerprint) continue;
        if (!groups.has(document.sourceFingerprint)) groups.set(document.sourceFingerprint, []);
        groups.get(document.sourceFingerprint).push(document);
      } catch (_) {}
    }
    const removed = [];
    for (const copies of groups.values()) {
      if (copies.length < 2) continue;
      copies.sort((a, b) => {
        const quality = item => (item.sourcePath ? 4 : 0) + (['Đã lập chỉ mục', 'Sẵn sàng · Tìm kiếm từ khóa'].includes(item.status) ? 2 : 0) + (item.contentPath && fs.existsSync(item.contentPath) ? 1 : 0);
        return quality(b) - quality(a) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
      });
      const keeper = copies[0];
      const sourceCopy = copies.find(item => item.sourcePath);
      if (!keeper.sourcePath && sourceCopy) {
        keeper.sourcePath = sourceCopy.sourcePath;
        keeper.sourceModifiedAt = sourceCopy.sourceModifiedAt || keeper.sourceModifiedAt;
      }
      for (const duplicate of copies.slice(1)) {
        if (storage.enabled()) storage.enqueue('document.delete', duplicate.id, { paths: [duplicate.storagePath, duplicate.contentPath, duplicate.manifestPath] });
        else {
          await qdrantService.deleteDocumentChunks(duplicate.id);
          for (const filePath of [duplicate.storagePath, duplicate.contentPath, duplicate.manifestPath]) if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
        removed.push({ id: duplicate.id, title: duplicate.title, keptId: keeper.id });
      }
    }
    if (removed.length) this.documents = this.documents.filter(item => !removed.some(entry => entry.id === item.id));
    this.persist();
    return { removedCount: removed.length, remainingCount: this.documents.length, removed };
  }

  async processQueuedDocument(id, { fingerprint } = {}) {
    const document = this.findDocument(id);
    if (!document || (fingerprint && document.sourceFingerprint !== fingerprint)) return;
    const buffer = fs.readFileSync(document.storagePath);
    const prepared = await this.prepareChunks(document, buffer);
    const { text, chunks } = prepared;
    const result = await qdrantService.indexDocumentChunks(document, chunks);
    if (!result.success) throw new Error('DOCUMENT_INDEX_FAILED');
    this.activateChunks(document, prepared);
    document.chunksCount = chunks.length;
    document.preview = text.slice(0, 500);
    document.status = result.mode === 'lexical' ? 'Sẵn sàng · Tìm kiếm từ khóa' : 'Đã lập chỉ mục';
    document.indexMode = result.mode === 'lexical' ? 'lexical' : 'vector';
    document.error = null;
    document.updatedAt = new Date().toISOString();
    this.persist();
  }

  async removeQueuedFiles(id, { paths = [] } = {}) {
    if (this.findDocument(id)) throw new Error('DOCUMENT_STILL_EXISTS');
    if (await qdrantService.deleteDocumentChunks(id) === false) throw new Error('DOCUMENT_VECTOR_DELETE_FAILED');
    for (const file of paths) {
      if (!file) continue;
      const resolved = path.resolve(file);
      if (![FILES_DIR, CONTENT_DIR].some(root => resolved.startsWith(path.resolve(root) + path.sep))) throw new Error('UNMANAGED_DOCUMENT_PATH');
      if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
    }
  }
}

module.exports = new LibraryService();
