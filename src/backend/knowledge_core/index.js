const documentRoutes = require('./routes/document_routes');
const watchfolderRoutes = require('./routes/watchfolder_routes');
const libraryService = require('./services/library_service');
const watchfolderService = require('./services/watchfolder_service');

async function handleRequest(req, res, pathname, context) {
  if (await documentRoutes.handle(req, res, pathname, context)) return true;
  if (await watchfolderRoutes.handle(req, res, pathname, context)) return true;
  return false;
}

async function start() {
  await watchfolderService.start();
  if ((process.env.KNOWLEDGE_REINDEX_ON_START || 'false') === 'true') {
    const summary = await libraryService.reindexAll();
    console.log(`[Knowledge] Reindex completed: ${summary.indexed}/${summary.total}`);
  }
}

async function stop() {
  await watchfolderService.stop();
}

module.exports = {
  handleRequest,
  start,
  stop,
  services: { library: libraryService, watchfolder: watchfolderService }
};
