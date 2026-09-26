'use strict';
const fs = require('node:fs');
const automation = require('./index');
const { error, ensure } = require('./contract');
const { requireAdmin } = require('./registry');
const metadata = template => ({ id: template.id, name: template.name, description: template.description, examples: template.examples, inputs: template.inputs, domain: template.domain, tags: template.tags, packageId: template.packageId, packageVersion: template.packageVersion, overlayVersion: template.overlayVersion });
async function handle(req, res, pathname, account, readBody) {
  if (!/^\/api\/(workflow-plugins|question-templates|automation-runs)(\/|$)/.test(pathname)) return false;
  const context = { accountId: account?.id, tenantId: account?.tenantId, permissions: account?.role === 'admin' ? ['admin'] : ['sql:read', 'knowledge:read'] };
  const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  try {
    if (!context.accountId) throw error('Cần đăng nhập.', 401);
    const config = await automation.settings();
    if (pathname === '/api/workflow-plugins/settings') {
      if (req.method === 'GET') send(config);
      else if (req.method === 'PUT') send(await automation.configure(await readBody(req), context));
      else throw error('Phương thức không được hỗ trợ.', 405);
      return true;
    }
    if (pathname === '/api/workflow-plugins/starter' && req.method === 'GET') { send({ bundle: await automation.starter(context) }); return true; }
    if (pathname === '/api/workflow-plugins') {
      requireAdmin(context);
      if (req.method === 'GET') send({ packages: await automation.registry.list(context, { admin: true }), settings: config });
      else if (req.method === 'POST') { const body = await readBody(req); send({ package: await automation.registry.import(body.bundle, context, body.revision ?? null) }, 201); }
      else throw error('Phương thức không được hỗ trợ.', 405);
      return true;
    }
    const plugin = pathname.match(/^\/api\/workflow-plugins\/([^/]+)(?:\/(validate|test|publish|enabled|overlay|rollback|export))?$/);
    if (plugin) {
      requireAdmin(context); const id = decodeURIComponent(plugin[1]), action = plugin[2];
      const record = await automation.repository.get('catalog', id);
      if (!record?.draft) throw error('Không tìm thấy gói.', 404);
      if (req.method === 'GET' && (!action || action === 'export')) { send(action === 'export' ? { bundle: record.published || record.draft } : { package: record }); return true; }
      if (req.method !== 'POST') throw error('Phương thức không được hỗ trợ.', 405);
      const body = await readBody(req);
      if (action === 'validate') send(await automation.registry.validate(id, context));
      else if (action === 'test') send(await automation.registry.test(id, context));
      else if (action === 'publish') send({ package: await automation.registry.publish(id, context, body.revision) });
      else if (action === 'enabled') send({ package: await automation.registry.enable(id, body.enabled, context, body.revision) });
      else if (action === 'overlay') send({ package: await automation.registry.overlay(id, body.scopeId, body.bundle, context, body.revision) });
      else if (action === 'rollback') send({ package: await automation.registry.rollback(id, body.version, context, body.revision) });
      else throw error('Thao tác không được hỗ trợ.', 405);
      return true;
    }
    if (pathname === '/api/question-templates') {
      if (req.method === 'GET') send({ templates: (await automation.registry.list(context)).map(metadata), settings: config });
      else if (req.method === 'POST') {
        requireAdmin(context); const body = await readBody(req);
        send({ package: await automation.registry.import({ manifest: body.manifest, templates: [body.template] }, context, body.revision ?? null) }, 201);
      } else throw error('Phương thức không được hỗ trợ.', 405);
      return true;
    }
    const removeTemplate = pathname.match(/^\/api\/question-templates\/([^/]+)$/);
    if (removeTemplate && req.method === 'DELETE') {
      requireAdmin(context); const [packageId, localId] = decodeURIComponent(removeTemplate[1]).split('/'); const body = await readBody(req);
      const record = await automation.repository.get('catalog', packageId);
      if (!record?.draft.templates.some(item => item.id === localId) || record.deletedTemplates?.[localId]) throw error('Mẫu không tồn tại.', 404);
      if (record.revision !== body.revision) throw error('Mẫu đã thay đổi. Hãy tải lại trước khi xóa.', 409);
      await automation.repository.put('catalog', { ...record, deletedTemplates: { ...record.deletedTemplates, [localId]: { deletedAt: new Date().toISOString(), deletedBy: context.accountId } } }, record.revision);
      send({ deleted: true }); return true;
    }
    const template = pathname.match(/^\/api\/question-templates\/([^/]+)\/(draft|validate|test|publish)$/);
    if (template) {
      requireAdmin(context); const [packageId, localId] = decodeURIComponent(template[1]).split('/');
      const record = await automation.repository.get('catalog', packageId);
      if (!record?.draft.templates.some(item => item.id === localId)) throw error('Template không tồn tại.', 404);
      const body = await readBody(req);
      if (template[2] === 'draft' && req.method === 'PUT') {
        ensure(body.template?.id === localId, 'Không được đổi ID draft.');
        const bundle = structuredClone(record.draft); bundle.templates = bundle.templates.map(item => item.id === localId ? body.template : item);
        if (record.published) bundle.manifest.version = Math.max(bundle.manifest.version, ...record.versions.map(version => version.manifest.version + 1));
        send({ package: await automation.registry.import(bundle, context, body.revision) });
      } else if (req.method === 'POST' && template[2] === 'validate') send(await automation.registry.validate(packageId, context));
      else if (req.method === 'POST' && template[2] === 'test') send(await automation.registry.test(packageId, context));
      else if (req.method === 'POST' && template[2] === 'publish') send({ package: await automation.registry.publish(packageId, context, body.revision) });
      else throw error('Phương thức không được hỗ trợ.', 405);
      return true;
    }
    if (pathname === '/api/automation-runs') {
      if (req.method === 'GET') { const params=new URL(req.url,'http://localhost').searchParams; send({ runs: params.get('summary')==='1' ? await automation.repository.runSummaries(context.accountId,params.get('conversationId')||undefined) : await automation.runtime.list(context,params.get('conversationId')||undefined) }); }
      else if (req.method === 'POST') { const body = await readBody(req); send({ execution: await automation.runtime.create(body.templateId, body.inputs || {}, context, { conversationId: body.conversationId, requestId: req.headers['x-request-id'] || body.requestId }) }, 202); }
      else throw error('Phương thức không được hỗ trợ.', 405);
      return true;
    }
    const run = pathname.match(/^\/api\/automation-runs\/([^/]+)(?:\/(inputs|resume|cancel|events|artifacts)(?:\/([^/]+))?)?$/);
    if (run) {
      const id = decodeURIComponent(run[1]), action = run[2];
      if (req.method === 'GET') {
        const owned = await automation.runtime.owned(id, context);
        if (!action) send({ execution: automation.runtime.view(owned) });
        else if (action === 'events') {
          const after = Number(req.headers['last-event-id'] || new URL(req.url, 'http://localhost').searchParams.get('after') || 0);
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=UTF-8', 'Cache-Control': 'no-store' });
          // Finite replay batch. Reconnect with Last-Event-ID; no held DB snapshot.
          res.end(owned.events.filter(event => event.id > after).map(event => `id: ${event.id}\nevent: execution\ndata: ${JSON.stringify(event)}\n\n`).join(''));
        } else if (action === 'artifacts' && run[3]) {
          const artifact = await automation.runtime.artifact(id, run[3], context);
          const buffer = fs.readFileSync(artifact.path);
          res.writeHead(200, { 'Content-Type': artifact.contentType || (artifact.filename.endsWith('.csv') ? 'text/csv; charset=UTF-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'Content-Disposition': `attachment; filename="${artifact.filename.replace(/[^\x20-\x7e]/g,'_')}"; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`, 'Cache-Control': 'private, no-store', 'Content-Length': buffer.length }); res.end(buffer);
        } else throw error('Không tìm thấy endpoint.', 404);
      } else if (req.method === 'POST') {
        const body = await readBody(req); let execution;
        if (action === 'inputs') execution = await automation.runtime.inputs(id, body.inputs || {}, context, body.revision);
        else if (action === 'resume') execution = await automation.runtime.resume(id, context, body.revision);
        else if (action === 'cancel') execution = await automation.runtime.cancel(id, context, body.revision);
        else throw error('Thao tác không được hỗ trợ ở phase 1.', 405);
        send({ execution });
      } else throw error('Phương thức không được hỗ trợ.', 405);
      return true;
    }
    throw error('Không tìm thấy endpoint.', 404);
  } catch (failure) { send({ status: 'error', message: failure.code === '42P01' ? 'Cần chạy npm run db:migrate để cài schema workflow phase 1.' : failure.statusCode ? failure.message : 'Không thể xử lý tác vụ.', requestId: req.requestId }, failure.code === '42P01' ? 503 : failure.statusCode || 500); }
  return true;
}
module.exports = { handle, metadata };
