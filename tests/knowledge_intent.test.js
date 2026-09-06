const test = require('node:test');
const assert = require('node:assert/strict');
const { needsKnowledgeSearch } = require('../src/backend/intelligent_core/knowledge_intent');

const documents = [
  { id: 'smartca', title: 'Kịch bản tích hợp SmartCA v4.1.pdf' },
  { id: 'ipms', title: 'TPSOFT HDSD IPMS APP v1.0.docx' }
];

test('ordinary questions and calculations do not trigger knowledge retrieval', () => {
  assert.equal(needsKnowledgeSearch('43 + 343', { documents }).needed, false);
  assert.equal(needsKnowledgeSearch('hôm nay thứ mấy', { documents }).needed, false);
  assert.equal(needsKnowledgeSearch('bạn có khỏe không', { documents }).needed, false);
});

test('explicit enterprise knowledge questions trigger retrieval', () => {
  assert.equal(needsKnowledgeSearch('Quy trình phê duyệt hồ sơ thế nào?', { documents }).needed, true);
  assert.equal(needsKnowledgeSearch('Tìm trong tài liệu hướng dẫn sử dụng', { documents }).needed, true);
});

test('document title terms and selected sources trigger retrieval', () => {
  assert.deepEqual(
    needsKnowledgeSearch('SmartCA tích hợp như thế nào?', { documents }),
    { needed: true, reason: 'document_title_match' }
  );
  assert.deepEqual(
    needsKnowledgeSearch('nội dung này là gì?', { sourceIds: ['ipms'], documents }),
    { needed: true, reason: 'selected_sources' }
  );
});
