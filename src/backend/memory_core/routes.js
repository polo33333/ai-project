'use strict';
async function handle(req, res, pathname, account, readBody) {
  if (pathname !== '/api/memory' && pathname !== '/api/memory/events') return false;
  const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  try {
    if (!account) { send(401, { message: 'Vui lòng đăng nhập.' }); return true; }
    const { memory, enabled } = require('./durable_memory');
    const events = pathname.endsWith('/events');
    if (req.method === 'GET') {
      const params = new URL(req.url, 'http://localhost').searchParams;
      send(200, { status: 'success', enabled: enabled(), canApprove: account.role === 'admin',
        ...memory.list({ scope: params.get('scope') || undefined, query: params.get('q') || '',
          limit: Number(params.get('limit')) || 50, offset: Number(params.get('offset')) || 0, events }) });
    } else if (req.method === 'POST' && !events) {
      send(200, { status: 'success', item: memory.save(await readBody(req)) });
    } else if (req.method === 'DELETE') {
      const body = await readBody(req);
      send(200, { status: 'success', ...memory.remove(body.id, body.revision, events) });
    } else send(405, { message: 'Phương thức không được hỗ trợ.' });
  } catch (error) { send(error.statusCode || 400, { status: 'error', message: error.message }); }
  return true;
}
module.exports = { handle };
