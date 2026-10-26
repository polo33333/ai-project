'use strict';

// RAG step 1, question understanding: the words that address the library are
// removed, a document named by its file name becomes the scope, and a
// follow-up stays inside the documents of the previous answer. Deterministic.
const normalize = require('../../utils/lexical_normalize');
const documentConversation = require('../../memory_core/document_conversation');

const key = value => normalize(value).replace(/[^a-z0-9]/g, '');
const COMMAND = /^(?:hay |vui long )?(?:(?:tim kiem|tim|tra cuu|hoi|doc|xem) )?(?:(?:trong|o|tu|tren|theo|dua (?:tren|vao)) )?(?:kho tri thuc|kho tai lieu|thu vien(?: tai lieu)?)$/;
const EDGE_PUNCTUATION = /^[\s:,;.\-–—]+|[\s:,;.\-–—]+$/g;

// "kho tri thức: …", "tìm trong kho tri thức …", "Dựa trên kho tài liệu, …".
function stripCommand(question) {
  const text = String(question || '').trim();
  const words = text.split(/\s+/);
  for (let count = Math.min(8, words.length - 1); count > 0; count--) {
    const head = normalize(words.slice(0, count).join(' ')).replace(EDGE_PUNCTUATION, '');
    if (COMMAND.test(head)) return words.slice(count).join(' ').replace(EDGE_PUNCTUATION, '');
  }
  return text;
}

const stem = title => String(title || '').replace(/\.[a-z0-9]{2,5}$/i, '');
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function namedDocuments(question, documents) {
  const text = key(question);
  return documents.filter(document => key(stem(document.title)).length >= 6 && text.includes(key(stem(document.title))));
}

function understand({ question, previous = null, documents = [] }) {
  const original = String(question || '').trim();
  const cleaned = stripCommand(original);
  const stripped = cleaned !== original;
  const named = namedDocuments(cleaned, documents);
  if (named.length) {
    // The file name chooses the document; what is left of the question chooses the passage.
    const rest = named.reduce((text, document) => text.replace(new RegExp(`${escape(document.title)}|${escape(stem(document.title))}`, 'giu'), ' '), cleaned)
      .replace(/\s+/g, ' ').replace(EDGE_PUNCTUATION, '');
    return { searchQuery: key(rest).length >= 4 ? rest : named.map(document => stem(document.title).replace(/[_-]+/g, ' ')).join(' '),
      documentIds: named.map(document => String(document.id)), method: 'file_name', stripped };
  }
  const available = new Set(documents.map(document => String(document.id)));
  const previousIds = [...new Set((previous?.documentIds || []).map(String))].filter(id => available.has(id));
  if (previousIds.length && documentConversation.isContextual(cleaned)) {
    return { searchQuery: cleaned, documentIds: previousIds, method: 'followup_scope', stripped };
  }
  return { searchQuery: cleaned, documentIds: [], method: stripped ? 'command_stripped' : 'original', stripped };
}

module.exports = { understand, stripCommand, namedDocuments };
