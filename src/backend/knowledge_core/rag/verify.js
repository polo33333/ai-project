'use strict';

// RAG step 6, verification: a cited sentence must not state a number, date,
// code or link that its cited passages do not contain. Checks only facts a
// machine can compare exactly; wording and paraphrase are left to the model.
const normalize = require('../../utils/lexical_normalize');

const key = value => normalize(value).replace(/[^a-z0-9]/g, '');
const MARKER = /\[(\d+)\](?!\s*\()/g;
// Links, identifiers such as SP_CREDENTIAL_INVALID, and any token that carries a digit.
const FACT = /https?:\/\/[^\s)\]>]+|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|[\p{L}\p{N}]*\p{N}[\p{L}\p{N}.,:/–-]*/gu;

function sentences(reply) {
  return String(reply || '').split(/\n+|(?<=[.!?])\s+(?=\S)/u).map(text => text.trim()).filter(Boolean);
}

function facts(sentence) {
  const text = sentence.replace(MARKER, ' ').replace(/^\s*(?:[-*+]|\d{1,2}[.)])\s+/, '');
  return [...new Set((text.match(FACT) || []).map(fact => fact.replace(/[.,:/–-]+$/, '')).filter(fact => key(fact).length >= 2))];
}

function verifyClaims(reply, evidence = [], question = '') {
  const byIndex = new Map(evidence.map(item => [Number(item.citationIndex), key(item.payload?.fullText || item.text || '')]));
  const asked = key(question);
  const unsupported = [];
  let checked = 0;
  for (const sentence of sentences(reply)) {
    const markers = [...new Set([...sentence.matchAll(MARKER)].map(match => Number(match[1])))].filter(marker => byIndex.has(marker));
    if (!markers.length) continue;
    const cited = markers.map(marker => byIndex.get(marker)).join(' ');
    const claimed = facts(sentence).filter(fact => !asked.includes(key(fact)));
    checked += claimed.length;
    const missing = claimed.filter(fact => !cited.includes(key(fact)));
    if (missing.length) unsupported.push({ markers, facts: missing.slice(0, 5), sentence: sentence.slice(0, 200) });
  }
  return { checkedFacts: checked, unsupported };
}

module.exports = { verifyClaims, facts, sentences };
