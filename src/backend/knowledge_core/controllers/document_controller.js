const libraryService = require('../services/library_service');

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=UTF-8' });
  res.end(JSON.stringify(payload));
}

class DocumentController {
  list(req, res) { sendJson(res, 200, libraryService.getDocuments()); }

  async add(req, res, context) {
    try {
      const payload = await context.readJsonBody(req);
      const document = await libraryService.addDocument(payload);
      if (document.duplicate) {
        sendJson(res, 200, { status: 'duplicate', message: 'Tệp có nội dung trùng với tài liệu đã tồn tại.', document, documents: libraryService.getDocuments() });
        return;
      }
      context.logger.addLog(document.status === 'Lỗi xử lý' ? 'ERROR' : 'SUCCESS', 'Library Tri thức', `Đã xử lý tài liệu '${document.title}' (${document.chunksCount} chunks).`);
      sendJson(res, 200, { status: 'success', document: libraryService.getDocuments().find(item => item.id === document.id), documents: libraryService.getDocuments() });
    } catch (error) { sendJson(res, 400, { status: 'error', message: error.message }); }
  }

  async remove(req, res, context) {
    try {
      const { id } = await context.readJsonBody(req);
      if (!id) throw new Error('Thiếu mã tài liệu.');
      if (!await libraryService.deleteDocument(id)) throw new Error('Không tìm thấy tài liệu.');
      sendJson(res, 200, { status: 'success', documents: libraryService.getDocuments() });
    } catch (error) { sendJson(res, 400, { status: 'error', message: error.message }); }
  }

  content(req, res, id) {
    try { sendJson(res, 200, libraryService.getContent(id)); }
    catch (error) { sendJson(res, 404, { status: 'error', message: error.message }); }
  }

  file(req, res, id) {
    try {
      const { document, buffer } = libraryService.getFile(id);
      const mime = { PDF: 'application/pdf', DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', XLS: 'application/vnd.ms-excel', CSV: 'text/csv; charset=UTF-8', TXT: 'text/plain; charset=UTF-8', SQL: 'text/plain; charset=UTF-8', MD: 'text/markdown; charset=UTF-8' }[document.fileType] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': buffer.length, 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(document.title)}` });
      res.end(buffer);
    } catch (error) { sendJson(res, 404, { status: 'error', message: error.message }); }
  }
}

module.exports = new DocumentController();
