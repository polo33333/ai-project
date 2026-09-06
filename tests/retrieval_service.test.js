const test = require('node:test');
const assert = require('node:assert/strict');
const retrievalService = require('../src/backend/knowledge_core/services/retrieval_service');
const libraryService = require('../src/backend/knowledge_core/services/library_service');

const corpus = [
  { id: 'a:0', text: 'Qdrant lưu vector embedding cho tài liệu', payload: { documentId: 'a', chunkIndex: 0, fullText: 'Qdrant lưu vector embedding cho tài liệu' } },
  { id: 'b:0', text: 'SQL Server lưu dữ liệu giao dịch', payload: { documentId: 'b', chunkIndex: 0, fullText: 'SQL Server lưu dữ liệu giao dịch' } }
];

test('BM25 ranks the matching chunk first', () => {
  const results = retrievalService.bm25('vector Qdrant', corpus, 2);
  assert.equal(results[0].id, 'a:0');
  assert.ok(results[0].score > 0);
});

test('RRF rewards a chunk returned by multiple retrievers', () => {
  const fused = retrievalService.fuse([
    [{ id: 'a:0', payload: corpus[0].payload, source: 'dense' }, { id: 'b:0', payload: corpus[1].payload, source: 'dense' }],
    [{ id: 'a:0', payload: corpus[0].payload, source: 'bm25' }]
  ], 2);
  assert.equal(fused[0].id, 'a:0');
  assert.deepEqual(fused[0].retrievalSources, ['dense', 'bm25']);
});

test('GraphRAG router only activates for relationship questions', () => {
  assert.equal(retrievalService.graphRoute('Mối quan hệ giữa Qdrant và tài liệu là gì?'), true);
  assert.equal(retrievalService.graphRoute('Qdrant là gì?'), false);
});

test('watch-folder source lookup uses sourcePath instead of managed copy path', () => {
  const original = libraryService.documents;
  libraryService.documents = [{ id: 'watch-1', sourcePath: 'E:\\watched\\document.docx', storagePath: 'E:\\managed\\copy.docx' }];
  try {
    assert.equal(libraryService.findBySourcePath('e:\\WATCHED\\document.docx')?.id, 'watch-1');
    assert.equal(libraryService.isManagedFile('E:\\watched\\document.docx'), true);
    assert.equal(libraryService.findBySourcePath('E:\\watched\\other.docx'), undefined);
  } finally {
    libraryService.documents = original;
  }
});
