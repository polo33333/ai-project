'use strict';

let locked = false;
let active = 0;
let waiters = [];
let pauseWorkers = async () => {};
let resumeWorkers = async () => {};

function configure({ pause, resume }) { pauseWorkers = pause; resumeWorkers = resume; }
function enter(req, res) {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const bypass = pathname.startsWith('/api/backups/');
  if (locked && !bypass) {
    res.writeHead(503, { 'Content-Type': 'application/json; charset=UTF-8', 'Retry-After': '5' });
    res.end(JSON.stringify({ message: 'Đang tạo backup, vui lòng thử lại sau.' }));
    return false;
  }
  if (!bypass) {
    active++;
    let counted = true;
    const done = () => { if (!counted) return; counted = false; active--; if (!active) { const pending = waiters; waiters = []; pending.forEach(resolve => resolve()); } };
    res.once('finish', done); res.once('close', done);
  }
  return true;
}
async function withPausedWrites(task) {
  if (locked) throw Object.assign(new Error('Đang có tác vụ backup chạy.'), { statusCode: 409 });
  locked = true;
  let paused = false;
  try {
    if (active) {
      let timeout;
      try { await Promise.race([
        new Promise(resolve => waiters.push(resolve)),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Existing requests did not finish within 30 seconds.')), 30000); })
      ]); } finally { clearTimeout(timeout); }
    }
    paused = true; await pauseWorkers();
    return await task();
  } finally {
    try { if (paused) await resumeWorkers(); }
    finally { locked = false; }
  }
}
module.exports = { configure, enter, withPausedWrites };
