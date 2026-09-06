'use strict';

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function isLocalProvider(provider = {}) {
  const explicitClass = normalize(provider.executionClass || provider.harness);
  if (explicitClass === 'local') return true;
  if (explicitClass === 'remote' || explicitClass === 'standard' || explicitClass === 'cloud') return false;

  const format = normalize(provider.apiFormat);
  const type = normalize(provider.type);
  const url = normalize(provider.baseUrl);
  return format === 'ollama'
    || type === 'local'
    || type.includes('ollama')
    || url.includes('127.0.0.1:11434')
    || url.includes('localhost:11434');
}

module.exports = { isLocalProvider };
