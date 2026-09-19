const test = require('node:test');
const assert = require('node:assert/strict');
const citationService = require('../src/backend/knowledge_core/services/citation_service');

const evidence = [
  { citationIndex: 1, payload: { documentId: 'doc 1', title: 'Hướng dẫn IPMS', chunkIndex: 2, fullText: 'Nội dung gốc của đoạn ba.' } },
  { citationIndex: 2, payload: { documentId: 'doc-2', title: 'Quy trình', chunkIndex: 0, fullText: 'Nội dung quy trình.' } }
];

test('citation metadata only comes from evidence actually packed into the prompt', () => {
  const result = citationService.buildVerifiedCitations('Thông tin [1], tổng hợp [1][2].', evidence);
  assert.equal(result.citations.length, 2);
  assert.deepEqual(result.citations[0], {
    marker: 1,
    documentId: 'doc 1',
    title: 'Hướng dẫn IPMS',
    chunkIndex: 2,
    excerpt: 'Nội dung gốc của đoạn ba.',
    sourceUrl: '/api/library/doc%201/file'
  });
  assert.equal(result.validation.missingCitation, false);
});

test('invalid citation markers are reported and removed without breaking the answer', () => {
  const result = citationService.buildVerifiedCitations('Đúng [1], bịa [7].', evidence);
  assert.deepEqual(result.validation.invalidCitationIndexes, [7]);
  assert.equal(citationService.removeInvalidMarkers('Đúng [1], bịa [7].', result.validation.invalidCitationIndexes), 'Đúng [1], bịa .');
  assert.equal(result.citations.length, 1);
});

test('missing citation is recorded when document evidence was used', () => {
  const result = citationService.buildVerifiedCitations('Câu trả lời không có marker.', evidence);
  assert.equal(result.validation.missingCitation, true);
  assert.deepEqual(result.citations, []);
  assert.equal(result.supportingEvidence.length, 2);
  assert.equal(result.supportingEvidence[0].chunkIndex, 2);
});

test('citation excerpt is selected near the question instead of always using the chunk prefix', () => {
  const text = `${'Nội dung mở đầu không liên quan. '.repeat(30)}\nThay đổi mật khẩu\nTừ Trang chủ chọn Cài đặt rồi chọn Thay đổi mật khẩu.`;
  const result = citationService.buildVerifiedCitations('Mở Cài đặt để thay đổi mật khẩu [1].', [
    { citationIndex: 1, payload: { documentId: 'doc-1', title: 'Hướng dẫn', chunkIndex: 1, fullText: text } }
  ], 'cách thay đổi mật khẩu');
  assert.match(result.citations[0].excerpt, /Thay đổi mật khẩu/);
  assert.doesNotMatch(result.citations[0].excerpt, /^Nội dung mở đầu/);
});
