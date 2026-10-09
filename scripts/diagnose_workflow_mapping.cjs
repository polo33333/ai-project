'use strict';
// Read-only comparison of persisted workflow mappings with the current dictionary.
const storage = require('../src/backend/storage');
storage.loadEnvironment();
(async () => {
  await storage.bootstrapStorage();
  try {
    await storage.run(async () => {
      const dictionary = require('../src/backend/services/dictionary_service');
      const { mappedColumns } = require('../src/backend/automation/column_mapping');
      const { AutomationRepository } = require('../src/backend/automation/repository');
      const repository = new AutomationRepository();
      const inspect = definition => Object.entries(definition?.bindings || {}).flatMap(([bindingId, binding]) => (binding.resultMapping || []).flatMap(mapping => {
        const table = dictionary.tablesStore.find(t => t.tableId === mapping.tableId && t.dbSourceId === binding.dbSourceId && t.isActive !== false);
        const current = table && mappedColumns(table, dictionary).find(c => c.column.columnName === mapping.columnName);
        if (current && (current.relation?.id || null) === (mapping.relationId || null)) return [];
        const oldRelation = dictionary.tableRelationships.find(r => r.id === mapping.relationId);
        return [{ bindingId, column: mapping.columnName, table: table?.tableName || mapping.tableId,
          reason: !table ? 'table_missing_or_disabled' : !current ? 'column_missing_or_hidden' : 'relation_changed',
          columnExists: Boolean(table?.columns.some(c => c.columnName === mapping.columnName)),
          columnVisible: table?.columns.find(c => c.columnName === mapping.columnName)?.isVisible ?? null,
          sqlStillReferencesColumn: String(binding.sql || '').toLowerCase().includes(mapping.columnName.toLowerCase()),
          storedRelationId: mapping.relationId || null, currentRelationId: current?.relation?.id || null,
          storedRelation: oldRelation ? { active: oldRelation.isActive, status: oldRelation.status, cardinality: oldRelation.cardinality, displayColumn: oldRelation.displayColumn } : null }];
      }));
      const catalog = await repository.list('catalog');
      const published = catalog.flatMap(record => (record.published?.templates || []).map(template => ({ id: `${record.id}/${template.id}`, version: record.published.manifest.version, mismatches: inspect(template) }))).filter(item => item.mismatches.length);
      const drafts = catalog.flatMap(record => (record.draft?.templates || []).map(template => ({ id: `${record.id}/${template.id}`, version: record.draft.manifest.version, mismatches: inspect(template) }))).filter(item => item.mismatches.length);
      const failed = (await repository.list('runs', { statuses: ['FAILED'] })).filter(run => String(run.error).includes('Mapping')).slice(0, 5).map(run => ({ id: run.id, updatedAt: run.updatedAt, templateId: run.templateId, version: run.definition?.packageVersion, error: run.error, mismatches: inspect(run.definition) }));
      console.log(JSON.stringify({ published, drafts, failed }, null, 2));
    });
  } finally { await storage.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
