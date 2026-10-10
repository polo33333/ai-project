'use strict';

// Incremental UTF-8 decoding handles chunks split inside a character or SSE frame.
async function readJsonStream(response, onValue, sse = false) {
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines = [];
  const dispatch = value => {
    if (!value || value === '[DONE]') return;
    const parsed = JSON.parse(value);
    if (parsed.error) throw new Error(parsed.error.message || String(parsed.error));
    onValue(parsed);
  };
  const line = value => {
    value = value.replace(/\r$/, '');
    if (!sse) { dispatch(value.trim()); return; }
    if (!value) { dispatch(dataLines.join('\n')); dataLines = []; }
    else if (value.startsWith('data:')) dataLines.push(value.slice(5).trimStart());
  };
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      line(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
    }
    if (buffer.length > 4 * 1024 * 1024) throw new Error('Provider stream frame too large');
  }
  buffer += decoder.decode();
  if (buffer) line(buffer);
  if (sse) dispatch(dataLines.join('\n'));
}

function reasoningEmitter(callback) {
  let remaining = 32000;
  return value => {
    if (typeof callback !== 'function' || typeof value !== 'string' || !remaining) return;
    const text = value.slice(0, remaining);
    remaining -= text.length;
    // Keep each event below the progress transport limit.
    for (let i = 0; i < text.length; i += 8000) callback(text.slice(i, i + 8000));
  };
}

module.exports = { readJsonStream, reasoningEmitter };
