'use strict';

// Unset preserves existing installations. Disabled mode never manufactures vectors.
function enabled() { return process.env.EMBEDDING_ENABLED !== 'false'; }
function assertEnabled() {
  if (!enabled()) throw Object.assign(new Error('Embedding is disabled; use lexical retrieval.'), { code: 'EMBEDDING_DISABLED' });
}
module.exports = { enabled, assertEnabled };
