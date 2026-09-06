const watchfolderService = require('../services/watchfolder_service');

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=UTF-8' });
  res.end(JSON.stringify(payload));
}

class WatchFolderController {
  list(req, res) {
    sendJson(res, 200, watchfolderService.getFolders());
  }

  listLogs(req, res) {
    sendJson(res, 200, watchfolderService.getLogs());
  }

  async add(req, res, context) {
    try {
      const { path: folderPath, filters } = await context.readJsonBody(req);
      await watchfolderService.addFolder(folderPath, filters);
      context.logger.addLog('SUCCESS', 'Watch Folder', `Đã thêm thư mục giám sát mới: '${folderPath}'`);
      sendJson(res, 200, { status: 'success', folders: watchfolderService.getFolders() });
    } catch (error) {
      sendJson(res, 400, { status: 'error', message: error.message });
    }
  }

  async remove(req, res, context) {
    try {
      const { id } = await context.readJsonBody(req);
      if (!id) throw new Error('Thiếu mã thư mục giám sát.');
      if (!watchfolderService.deleteFolder(id)) throw new Error('Không tìm thấy thư mục giám sát.');
      sendJson(res, 200, { status: 'success', folders: watchfolderService.getFolders() });
    } catch (error) {
      sendJson(res, 400, { status: 'error', message: error.message });
    }
  }

  async toggle(req, res, context) {
    try {
      const { id } = await context.readJsonBody(req);
      if (!id) throw new Error('Thiếu mã thư mục giám sát.');
      const folder = await watchfolderService.toggleFolderStatus(id);
      if (!folder) throw new Error('Không tìm thấy thư mục giám sát.');
      context.logger.addLog('INFO', 'Watch Folder', `Đã chuyển '${folder.path}' sang trạng thái ${folder.status}.`);
      sendJson(res, 200, {
        status: 'success',
        folder,
        folders: watchfolderService.getFolders()
      });
    } catch (error) {
      sendJson(res, 400, { status: 'error', message: error.message });
    }
  }
}

module.exports = new WatchFolderController();
