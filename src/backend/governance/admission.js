'use strict';
class Admission {
  constructor(limit, maxQueue = 32) { this.limit = Math.max(1, limit); this.maxQueue = maxQueue; this.active = 0; this.queue = []; }
  acquire({ signal, timeoutMs = 10000 } = {}) {
    if (signal?.aborted) return Promise.reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' }));
    if (this.active < this.limit) { this.active++; return Promise.resolve(this.release()); }
    if (this.queue.length >= this.maxQueue) return Promise.reject(Object.assign(new Error('Hệ thống đang đầy tải. Hãy thử lại.'), { code: 'QUEUE_FULL', statusCode: 429 }));
    return new Promise((resolve, reject) => {
      let timer;
      const remove = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); const index = this.queue.indexOf(entry); if (index >= 0) this.queue.splice(index, 1); };
      const abort = () => { remove(); reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' })); };
      const entry = { grant: () => { remove(); this.active++; resolve(this.release()); } };
      timer = setTimeout(() => { remove(); reject(Object.assign(new Error('Hết thời gian chờ tài nguyên.'), { code: 'QUEUE_TIMEOUT', statusCode: 429 })); }, Math.max(1, timeoutMs));
      signal?.addEventListener('abort', abort, { once: true }); this.queue.push(entry);
    });
  }
  release() { let released = false; return () => { if (released) return; released = true; this.active--; this.queue[0]?.grant(); }; }
  async run(operation, options) { const release = await this.acquire(options); try { return await operation(); } finally { release(); } }
}
const positive = (value, fallback) => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
const model = new Admission(positive(process.env.GOVERNED_MODEL_CONCURRENCY, 4));
const sql = new Admission(positive(process.env.GOVERNED_SQL_CONCURRENCY, 8));
module.exports = { Admission, model, sql };
