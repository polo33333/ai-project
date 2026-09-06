const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const { parse: parseCsv } = require('csv-parse/sync');
const StorageHelper = require('../../utils/storage_helper');
const qdrantService = require('../../services/qdrant_service');

const DATA_DIR = path.join(__dirname, '../../../../data');
const FILES_DIR = path.join(DATA_DIR, 'library_files');
const CONTENT_DIR = path.join(DATA_DIR, 'library_content');
for (const dir of [FILES_DIR, CONTENT_DIR]) fs.mkdirSync(dir, { recursive: true });

class LibraryService {
  constructor() {
    this.documents = StorageHelper.loadJson('library.json', []);
    this.maxFileBytes = Math.max(1024 * 1024, Number(process.env.LIBRARY_MAX_FILE_MB || 20) * 1024 * 1024);
  }

  persist() { StorageHelper.saveJson('library.json', this.documents); }
  getDocuments() { return this.documents.map(({ storagePath, contentPath, sourceFingerprint, ...item }) => item); }
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
    const type = String(fileType || '').toUpperCase();
    if (type === 'PDF') return (await pdfParse(buffer)).text || '';
    if (type === 'DOCX') return (await mammoth.extractRawText({ buffer })).value || '';
    if (['XLSX', 'XLS'].includes(type)) {
      const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
      return workbook.SheetNames.map(name => `# Sheet: ${name}\n${XLSX.utils.sheet_to_csv(workbook.Sheets[name])}`).join('\n\n');
    }
    if (type === 'CSV') {
      const raw = buffer.toString('utf8');
      const rows = parseCsv(raw, { relax_column_count: true, skip_empty_lines: true });
      return rows.map(row => row.join(' | ')).join('\n');
    }
    if (['TXT', 'SQL', 'MD'].includes(type)) return buffer.toString('utf8');
    throw new Error(`Định dạng ${type} chưa được hỗ trợ.`);
  }

  cleanText(value) {
    return String(value || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  chunkText(text, maxChars = 2200, overlap = 250) {
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

  async addDocument({ title, fileType, size, category, contentBase64, sourcePath = null, sourceFingerprint = null, sourceModifiedAt = null }) {
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
      const id = `lib-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
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
    try {
      fs.writeFileSync(document.storagePath, buffer);
      const text = this.cleanText(await this.extractText(buffer, type));
      if (!text) throw new Error(type === 'PDF' ? 'PDF không có lớp văn bản; cần OCR cho file scan.' : 'Không trích xuất được nội dung file.');
      fs.writeFileSync(document.contentPath, text, 'utf8');
      const chunks = this.chunkText(text);
      const result = await qdrantService.indexDocumentChunks(document, chunks);
      document.chunksCount = chunks.length;
      document.preview = text.slice(0, 500);
      document.pageCount = type === 'PDF' ? (text.match(/\f/g)?.length || 0) + 1 : null;
      document.status = result.success ? 'Đã lập chỉ mục' : 'Đã đọc · Qdrant lỗi';
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
    const content = document.contentPath && fs.existsSync(document.contentPath) ? fs.readFileSync(document.contentPath, 'utf8') : '';
    return { document: this.getDocuments().find(item => item.id === id), content };
  }

  getFile(id) {
    const document = this.findDocument(id);
    if (!document || !document.storagePath || !fs.existsSync(document.storagePath)) throw new Error('Không tìm thấy file gốc.');
    return { document, buffer: fs.readFileSync(document.storagePath) };
  }

  async deleteDocument(id) {
    const document = this.findDocument(id);
    if (!document) return false;
    for (const filePath of [document.storagePath, document.contentPath]) {
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    await qdrantService.deleteDocumentChunks(id);
    this.documents = this.documents.filter(item => item.id !== id);
    this.persist();
    return true;
  }

  async reindexAll() {
    const summary = { total: this.documents.length, indexed: 0, failed: [] };
    for (const document of this.documents) {
      try {
        const content = document.contentPath && fs.existsSync(document.contentPath) ? fs.readFileSync(document.contentPath, 'utf8') : '';
        if (!content) throw new Error('Không có nội dung đã trích xuất');
        const chunks = this.chunkText(content);
        const result = await qdrantService.indexDocumentChunks(document, chunks);
        if (!result.success) throw new Error(result.error || 'Qdrant indexing failed');
        document.chunksCount = chunks.length;
        document.status = 'Đã lập chỉ mục';
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
        const quality = item => (item.sourcePath ? 4 : 0) + (item.status === 'Đã lập chỉ mục' ? 2 : 0) + (item.contentPath && fs.existsSync(item.contentPath) ? 1 : 0);
        return quality(b) - quality(a) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
      });
      const keeper = copies[0];
      const sourceCopy = copies.find(item => item.sourcePath);
      if (!keeper.sourcePath && sourceCopy) {
        keeper.sourcePath = sourceCopy.sourcePath;
        keeper.sourceModifiedAt = sourceCopy.sourceModifiedAt || keeper.sourceModifiedAt;
      }
      for (const duplicate of copies.slice(1)) {
        await qdrantService.deleteDocumentChunks(duplicate.id);
        for (const filePath of [duplicate.storagePath, duplicate.contentPath]) {
          if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
        removed.push({ id: duplicate.id, title: duplicate.title, keptId: keeper.id });
      }
    }
    if (removed.length) this.documents = this.documents.filter(item => !removed.some(entry => entry.id === item.id));
    this.persist();
    return { removedCount: removed.length, remainingCount: this.documents.length, removed };
  }
}

module.exports = new LibraryService();
