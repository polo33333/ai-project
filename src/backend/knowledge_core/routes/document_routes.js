const controller = require('../controllers/document_controller');

async function handle(req, res, pathname, context) {
  const contentMatch = pathname.match(/^\/api\/library\/([^/]+)\/content$/);
  if (contentMatch && req.method === 'GET') {
    controller.content(req, res, decodeURIComponent(contentMatch[1]));
    return true;
  }
  const fileMatch = pathname.match(/^\/api\/library\/([^/]+)\/file$/);
  if (fileMatch && req.method === 'GET') {
    controller.file(req, res, decodeURIComponent(fileMatch[1]));
    return true;
  }
  if (pathname === '/api/library' && req.method === 'GET') {
    controller.list(req, res);
    return true;
  }
  if (pathname === '/api/library/add' && req.method === 'POST') {
    await controller.add(req, res, context);
    return true;
  }
  if (pathname === '/api/library/delete' && req.method === 'POST') {
    await controller.remove(req, res, context);
    return true;
  }
  return false;
}

module.exports = { handle };
