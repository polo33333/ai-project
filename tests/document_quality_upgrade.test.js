'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const XLSX = require('xlsx');
const library = require('../src/backend/knowledge/services/library_service');
const retrieval = require('../src/backend/knowledge/services/retrieval_service');
const qdrant = require('../src/backend/services/qdrant_service');
const structured = require('../src/backend/knowledge/services/structured_document');
const citations = require('../src/backend/knowledge/services/citation_service');
const conversation = require('../src/backend/memory/document_conversation');
const normalize = require('../src/backend/utils/lexical_normalize');

test('Vietnamese BM25 matches accented/unaccented queries without truncating đ/Đ', () => {
  const texts = ['Điều kiện đăng ký đơn', 'Ang on ieu', 'Đã duyệt hồ sơ'];
  const corpus = texts.map((text, index) => ({ id: String(index), text, payload: { fullText: text } }));
  for (const query of ['Điều kiện đăng ký đơn', 'DIEU KIEN DANG KY DON', 'ĐIỀU KIỆN ĐĂNG KÝ ĐƠN']) {
    assert.equal(retrieval.bm25(query, corpus)[0].id, '0');
  }
  assert.equal(retrieval.bm25('da', corpus)[0].id, '2');
  assert.equal(normalize('Đăng ĐÃ đơn'), 'dang da don');
  assert.deepEqual(corpus.map(item => item.text), texts);
});

test('lexical regression corpus improves Recall@1 and MRR for unaccented Vietnamese', () => {
  const texts = ['đăng', 'đơn', 'điều', 'đã', 'ang', 'on', 'ieu'];
  const queries = ['dang', 'don', 'dieu', 'da'];
  const old = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[a-z0-9_]{2,}/g) || [];
  const corpus = texts.map((text, id) => ({ text, id: String(id), payload: { fullText: text } }));
  const before = queries.map((query, expected) => texts.findIndex(text => old(text).includes(query)) === expected ? 1 : 0);
  const after = queries.map((query, expected) => retrieval.bm25(query, corpus)[0]?.id === String(expected) ? 1 : 0);
  assert.equal(before.reduce((a, b) => a + b, 0), 0);
  assert.equal(after.reduce((a, b) => a + b, 0), 4);
});

test('long spreadsheets retain sheet, exact row ranges and headers in every chunk', async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Mã', 'Điều kiện'], ...Array.from({ length: 80 }, (_, i) => [`HD${i}`, 'Đăng ký '.repeat(15)])
  ]), 'Đăng ký');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Tên'], ['Khác']]), 'Khác');
  const parts = await structured.extract(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), 'XLSX');
  const chunks = structured.chunks(parts, library.chunkText.bind(library), 600);
  const firstSheet = chunks.filter(chunk => chunk.sheet === 'Đăng ký');
  assert.ok(firstSheet.length > 10);
  assert.equal(firstSheet[0].rowStart, 2);
  assert.equal(firstSheet.at(-1).rowEnd, 81);
  for (const chunk of firstSheet) assert.match(chunk.text, /^# Sheet: Đăng ký\nMã \| Điều kiện\nHD/);
  assert.ok(chunks.some(chunk => chunk.sheet === 'Khác' && chunk.rowStart === 2));
});

test('CSV quoted multiline rows remain linked to their header and logical row number', async () => {
  const parts = await structured.extract(Buffer.from('Mã,Mô tả\nHD01,"Dòng 1\nDòng 2"\nHD02,Khác'), 'CSV');
  const chunks = structured.chunks(parts, library.chunkText.bind(library));
  assert.equal(chunks[0].rowStart, 2);
  assert.equal(chunks[0].rowEnd, 3);
  assert.match(chunks[0].text, /HD01 \| Dòng 1\nDòng 2/);
});

test('real DOCX headings and tables retain section and column headers', async () => {
  const archive = XLSX.CFB.utils.cfb_new();
  const add = (name, xml) => XLSX.CFB.utils.cfb_add(archive, name, Buffer.from(xml));
  add('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>');
  add('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  add('word/styles.xml', '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>');
  add('docProps/app.xml', '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Pages>12</Pages></Properties>');
  add('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Điều kiện</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Mã</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Yêu cầu</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>HD001</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Bản gốc</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>');
  const buffer = XLSX.CFB.write(archive, { type: 'buffer', fileType: 'zip' });
  assert.deepEqual(structured.wordPageInfo(buffer), { pageCount: 12, pageCountSource: 'word_saved_metadata' });
  const parts = await structured.extract(buffer, 'DOCX');
  const table = parts.find(part => part.rows);
  assert.equal(table.section, 'Điều kiện');
  const chunks = structured.chunks(parts, library.chunkText.bind(library));
  assert.match(chunks.find(chunk => chunk.tableHeader).text, /Điều kiện\nMã \| Yêu cầu\nHD001 \| Bản gốc/);
});

test('real multipage PDF produces page locators from PDF pages', async () => {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...['Page one registration', 'Page two cancellation'].map(text => {
      const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET\n`;
      return `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`;
    })
  ];
  let pdf = `%PDF-1.4\n%${'fixture'.repeat(180)}\n`;
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const parts = await structured.extract(Buffer.from(pdf), 'PDF');
  assert.deepEqual(parts.map(part => part.page), [1, 2]);
  assert.match(parts[1].text, /Page two cancellation/);
});

test('section parent context is retained across long chunks without crossing sections', async () => {
  const parts = await structured.extract(Buffer.from(`# Đăng ký\n${'Điều kiện đăng ký. '.repeat(100)}\n# Hủy\nKhông hoàn phí.`), 'MD');
  const chunks = structured.chunks(parts, library.chunkText.bind(library), 500);
  assert.ok(chunks.length > 2);
  assert.ok(chunks.filter(chunk => chunk.section === 'Đăng ký').every(chunk => chunk.text.startsWith('Đăng ký\n') || chunk.text.startsWith('# Đăng ký')));
  assert.equal(chunks.at(-1).section, 'Hủy');
});

test('ingest publishes checksummed revision chunks used unchanged by lexical, dense and citations', async t => {
  let indexed;
  t.mock.method(qdrant, 'indexDocumentChunks', async (_document, chunks) => { indexed = chunks; return { success: true }; });
  const document = await library.addDocument({ title: 'quality-manifest.md', fileType: 'MD',
    contentBase64: Buffer.from('# Điều kiện\nKhông đăng ký nếu thiếu HD009.').toString('base64') });
  t.after(async () => { t.mock.method(qdrant, 'deleteDocumentChunks', async () => true); await library.deleteDocument(document.id); });
  assert.equal(document.status, 'Đã lập chỉ mục');
  assert.ok(document.revision);
  const originalSplit = library.chunkText;
  t.mock.method(library, 'chunkText', () => { throw new Error('No query-time rechunk'); });
  const corpus = retrieval.buildCorpus([document.id]);
  assert.equal(corpus.length, indexed.length);
  assert.equal(corpus[0].payload.chunkId, indexed[0].chunkId);
  assert.equal(corpus[0].payload.section, 'Điều kiện');
  const packed = retrieval.packContext([{ payload: { ...corpus[0].payload, page: 3 } }]);
  const citation = citations.buildVerifiedCitations('Không đăng ký [1].', packed.selected).citations[0];
  assert.equal(citation.page, 3);
  assert.equal(citation.revision, document.revision);
  assert.match(citation.sourceUrl, /#page=3$/);
  library.chunkText = originalSplit;
  await library.processQueuedDocument(document.id, { fingerprint: document.sourceFingerprint });
  assert.equal(library.getChunks(document.id)[0].chunkId, indexed[0].chunkId);
  const reindexed = await library.reindexAll();
  assert.ok(reindexed.indexed >= 1);
  library.chunkCache.clear();
  fs.appendFileSync(document.manifestPath, ' ');
  assert.throws(() => library.getChunks(document.id), /CHECKSUM/);
  library.chunkText = originalSplit;
});

test('Qdrant structured payload embeds text and retains locators and source revision', async t => {
  t.mock.method(qdrant, 'ensureDocumentCollection', async () => 'documents');
  t.mock.method(qdrant, 'deleteDocumentChunks', async () => true);
  let inputs, points;
  t.mock.method(qdrant, 'embedTexts', async texts => { inputs = texts; return [[0.1, 0.2]]; });
  t.mock.method(qdrant, 'request', async (_path, _method, body) => { if (body?.points) points = body.points; return {}; });
  const result = await qdrant.indexDocumentChunks({ id: 'doc', title: 'Policy' }, [{ text: 'Điều kiện', page: 2, section: 'Đăng ký', revision: 'r1', chunkId: 'doc:r1:0' }]);
  assert.equal(result.success, true);
  assert.deepEqual(inputs, ['Policy\nĐiều kiện']);
  assert.equal(points[0].payload.page, 2);
  assert.equal(points[0].payload.fullText, 'Điều kiện');
  assert.equal(points[0].payload.revision, 'r1');
});

const scope = { mode: 'selected', documentIds: ['a'] };
const documents = [{ id: 'a', revision: 'r1' }];
const evidence = [{ citationIndex: 1, payload: { documentId: 'a', chunkIndex: 0, chunkId: 'a:r1:0', revision: 'r1' } }];
function state(reply = '1. Giấy tờ HD001 [1]\n2. Giấy tờ HD002 [1]') {
  return conversation.createState({ question: 'Đăng ký cần giấy tờ gì?', reply, evidence, scope, accountId: 'owner' });
}
function resolve(question, value = state(), overrides = {}) {
  return conversation.resolve(question, { state: value, scope, documents, accountId: 'owner', ...overrides });
}

test('ordinal resolves displayed order and preserves IDs, dates, numbers and negation', () => {
  const question = 'Cái thứ hai không có HD003 vào 11/10/2026 thì sao?';
  const result = resolve(question);
  assert.equal(result.resolutionMethod, 'deterministic');
  assert.ok(result.resolvedQuery.startsWith(question));
  assert.match(result.resolvedQuery, /HD002/);
  assert.doesNotMatch(result.resolvedQuery, /HD001/);
  assert.deepEqual(result.referencedEvidenceIds, ['a:r1:0']);
});

test('ambiguous pronouns, multiple lists and unsupported ordinals request clarification', () => {
  for (const [question, value] of [
    ['Giấy tờ đó thiếu thì sao?', state()],
    ['Cái thứ hai thì sao?', state('1. A [1]\n2. B [1]\nNhóm khác:\n1. C [1]\n2. D [1]')],
    ['Cái thứ ba thì sao?', state()],
    ['Cái thứ hai thì sao?', state('1. A\n2. B')]
  ]) assert.equal(resolve(question, value).resolutionMethod, 'clarify');
});

test('document references reject stale TTL, owner, scope and revision; independent topics stay original', () => {
  const value = state();
  for (const overrides of [
    { accountId: 'other' }, { scope: { mode: 'selected', documentIds: ['b'] } },
    { documents: [] }, { documents: [{ id: 'a', revision: 'r2' }] },
    { now: Date.now() + 24 * 60 * 60 * 1000 }
  ]) assert.equal(resolve('Cái thứ hai thì sao?', value, overrides).resolutionMethod, 'clarify');
  assert.equal(resolve('Hướng dẫn hủy đăng ký', value).resolutionMethod, 'original');
  assert.equal(resolve('Điều 5 quy định gì?', null).resolutionMethod, 'original');
  assert.equal(resolve('Còn lệ phí?', value).resolutionMethod, 'deterministic');
  assert.equal(resolve('Giấy tờ đó thiếu thì sao?', state('1. HD001 [1]')).resolutionMethod, 'deterministic');
});

test('document pronouns use cited sources rather than answer lists or unused retrieval candidates', () => {
  const extra = { citationIndex: 2, payload: { documentId: 'b', revision: 'r2', title: 'Unrelated', chunkIndex: 0 } };
  const currentScope = { mode: 'all_authorized', documentIds: ['a', 'b'] };
  const value = conversation.createState({ question: 'Cách tải app?',
    reply: '1. Android:\n- Cài từ Google Play [1]\n2. iOS:\n- Cài từ App Store [1]',
    evidence: [...evidence, extra], scope: currentScope, accountId: 'owner' });
  assert.deepEqual(value.sources.map(item => item.documentId), ['a']);
  const result = conversation.resolve('tài liệu trên có mấy trang', { state: value, scope: currentScope,
    documents: [...documents, { id: 'b', revision: 'r2' }], accountId: 'owner' });
  assert.equal(result.resolutionMethod, 'deterministic');
  assert.deepEqual(result.referencedDocumentIds, ['a']);
  const multiple = conversation.createState({ question: 'Các tài liệu?', reply: 'A [1], B [2]', evidence: [...evidence, extra], scope: currentScope, accountId: 'owner' });
  const ambiguous = conversation.resolve('tài liệu trên có mấy trang', { state: multiple, scope: currentScope, documents: [...documents, { id: 'b', revision: 'r2' }], accountId: 'owner' });
  assert.equal(ambiguous.resolutionMethod, 'clarify');
  assert.deepEqual(ambiguous.ambiguities, ['ambiguous_document']);
  const ordered = conversation.createState({ question: 'Các tài liệu?', reply: 'B [2], A [1]', evidence: [...evidence, extra], scope: currentScope, accountId: 'owner' });
  const second = conversation.resolve('tài liệu thứ hai có gì?', { state: ordered, scope: currentScope, documents: [...documents, { id: 'b', revision: 'r2' }], accountId: 'owner' });
  assert.deepEqual(second.referencedDocumentIds, ['a']);
});

test('six page-count follow-up variants resolve a source, while prepositional trên stays independent', () => {
  const value = state('Android dùng Google Play; iOS dùng App Store [1].');
  for (const question of ['tl trên có mấy trang?', 'tài liệu trên có bao nhiêu trang?',
    'file đó bao nhiêu trang?', 'tl tren co may trang?', 'nó có mấy trang?', 'bao nhiêu trang?']) {
    assert.equal(conversation.isDocumentFollowup(question), true, question);
    const result = resolve(question, value);
    assert.equal(result.resolutionMethod, 'deterministic', question);
    assert.deepEqual(result.referencedDocumentIds, ['a']);
  }
  for (const question of ['Dựa trên kho tri thức, hướng dẫn tải IPMS theo tài liệu hướng dẫn.',
    'Cách cài IPMS trên Android theo tài liệu hướng dẫn?']) {
    assert.equal(conversation.isDocumentFollowup(question), false, question);
    assert.equal(resolve(question, null).resolutionMethod, 'original', question);
  }
});
