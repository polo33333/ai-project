const controller = require('../controllers/watchfolder_controller');

async function handle(req, res, pathname, context) {
  if (pathname === '/api/watchfolder' && req.method === 'GET') {
    controller.list(req, res);
    return true;
  }
  if (pathname === '/api/watchfolder/logs' && req.method === 'GET') {
    controller.listLogs(req, res);
    return true;
  }
  if (pathname === '/api/watchfolder/add' && req.method === 'POST') {
    await controller.add(req, res, context);
    return true;
  }
  if (pathname === '/api/watchfolder/delete' && req.method === 'POST') {
    await controller.remove(req, res, context);
    return true;
  }
  if (pathname === '/api/watchfolder/toggle' && req.method === 'POST') {
    await controller.toggle(req, res, context);
    return true;
  }
  return false;
}

module.exports = { handle };
