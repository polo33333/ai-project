/**
 * Data Dictionary & Business Glossary Service (Persistent Storage Enabled)
 * Grouped Table Architecture with Table Active/Inactive Toggle & Auto-Sync to Qdrant Vector DB
 */

const StorageHelper = require('../utils/storage_helper');
const crypto = require('node:crypto');
const { withIdentity, sameTable } = require('./schema_identity');

// Lifecycle and evidence are owned by the server, never by metadata forms.
const relationshipFields = ['sourceTableId', 'targetTableId', 'sourceTable', 'targetTable',
  'columnPairs', 'sourceColumn', 'targetColumn', 'cardinality', 'relationType',
  'businessRole', 'displayColumn', 'preferred', 'isActive', 'description', 'defaultJoinType'];
const editableRelationship = data => Object.fromEntries(relationshipFields
  .filter(field => Object.hasOwn(data, field)).map(field => [field, data[field]]));
const relationshipStructure = relation => JSON.stringify([relation.sourceTableId, relation.targetTableId,
  relation.columnPairs, relation.cardinality]);

function invalidateRelationship(relation) {
  if (relation.status === 'verified') relation.status = 'stale';
  relation.revision = (relation.revision || 1) + 1;
  relation.verifiedBy = null;
  relation.verifiedAt = null;
  delete relation.evidence?.profile;
  delete relation.evidence?.cardinalityStatus;
}

class DictionaryService {
  constructor() {
    StorageHelper.bind(this, 'tablesStore', 'dictionary.json', [], value => value.map(withIdentity));
    StorageHelper.bind(this, 'tableRelationships', 'table_relationships.json', [], value => Array.isArray(value) ? value.map(item => this.normalizeRelationship(item)) : []);
    StorageHelper.bind(this, 'businessGlossary', 'glossary.json', []);
  }

  persist() {
    StorageHelper.saveJson('dictionary.json', this.tablesStore);
    StorageHelper.saveJson('glossary.json', this.businessGlossary);
    StorageHelper.saveJson('table_relationships.json', this.tableRelationships);
  }

  saveDictionaryItems(tables, { completeSourceId = null } = {}) {
    tables.forEach(t => {
      const identified = withIdentity(t);
      const existing = this.tablesStore.find(tbl => sameTable(tbl, identified));
      const formattedCols = t.columns.map(c => {
        const prior = existing?.columns?.find(column => column.columnName === c.columnName);
        return ({
        columnName: c.columnName,
        dataType: c.dataType,
        isPrimaryKey: c.isPrimaryKey,
        isUnique: c.isUnique,
        isNullable: c.isNullable,
        ordinalPosition: c.ordinalPosition,
        displayName: c.displayName ?? prior?.displayName ?? '',
        isVisible: c.isVisible !== undefined ? c.isVisible !== false : prior?.isVisible !== false,
        description: prior?.description ?? c.description ?? `Cột ${c.columnName} thuộc bảng ${t.tableName}`
      }); });

      if (existing) {
        const priorColumns = existing.columns || [];
        const priorKeys = JSON.stringify(existing.uniqueConstraints);
        Object.assign(existing, withIdentity({ ...existing, ...identified, columns: formattedCols }));
        existing.dbName = t.dbName || existing.dbName;
        if (t.domain !== undefined) existing.domain = this.normalizeDomain(t.domain);
        if (existing.defaultMetric && !formattedCols.some(column => column.columnName === existing.defaultMetric)) delete existing.defaultMetric;
        if (existing.defaultTimeColumn && !formattedCols.some(column => column.columnName === existing.defaultTimeColumn)) delete existing.defaultTimeColumn;
        this.markChangedRelationshipsStale(existing.tableId, priorColumns, formattedCols,
          priorKeys !== JSON.stringify(existing.uniqueConstraints));
        delete existing.schemaMissing;
      } else {
        this.tablesStore.push(withIdentity({
          tableName: t.tableName,
          dbName: t.dbName || "SQLServer_DB",
          dbSourceId: t.dbSourceId || null,
          schemaName: t.schemaName || 'dbo',
          domain: this.normalizeDomain(t.domain),
          isActive: true,
          ...(Array.isArray(t.uniqueConstraints) ? { uniqueConstraints: t.uniqueConstraints } : {}),
          tableDescription: `Bảng dữ liệu ${t.tableName} thuộc CSDL ${t.dbName || ''}`,
          columns: formattedCols
        }));
      }
    });
    // Only a complete live snapshot may declare a table absent. DDL imports are partial.
    if (completeSourceId) {
      const present = new Set(tables.map(table => withIdentity(table).tableId));
      for (const table of this.tablesStore) {
        if (table.dbSourceId !== completeSourceId || present.has(table.tableId) || table.schemaMissing) continue;
        table.schemaMissing = true;
        table.isActive = false;
        for (const relation of this.tableRelationships) {
          if ([relation.sourceTableId, relation.targetTableId].includes(table.tableId)) invalidateRelationship(relation);
        }
      }
    }
    this.importForeignKeyRelationships(tables);
    this.persist();
    return this.tablesStore;
  }

  markChangedRelationshipsStale(tableId, before = [], after = [], keysChanged = false) {
    const signature = columns => new Map(columns.map(column => [column.columnName, `${column.dataType}|${!!column.isPrimaryKey}|${!!column.isUnique}`]));
    const oldMap = signature(before);
    const newMap = signature(after);
    this.tableRelationships.forEach(relation => {
      if (relation.sourceTableId !== tableId && relation.targetTableId !== tableId) return;
      const pairs = relation.columnPairs || [];
      const names = pairs.flatMap(pair => [
        ...(relation.sourceTableId === tableId ? [pair.sourceColumn] : []),
        ...(relation.targetTableId === tableId ? [pair.targetColumn] : [])]);
      const affected = keysChanged || names.some(name => !newMap.has(name) || oldMap.get(name) !== newMap.get(name));
      if (affected) invalidateRelationship(relation);
    });
  }

  importForeignKeyRelationships(tables = []) {
    for (const rawTable of tables) {
      const source = this.tablesStore.find(table => table.tableId === withIdentity(rawTable).tableId);
      if (!source) continue;
      if (Array.isArray(rawTable.foreignKeys)) {
        const names = new Set(rawTable.foreignKeys.map(fk => fk.constraintName));
        for (const relation of this.tableRelationships) {
          if (relation.origin !== 'foreign_key' || relation.sourceTableId !== source.tableId
            || names.has(relation.constraintName) || relation.evidence?.missing) continue;
          invalidateRelationship(relation);
          relation.evidence = { ...relation.evidence, missing: true };
        }
      }
      for (const fk of rawTable.foreignKeys || []) {
        const target = this.tablesStore.find(table => table.dbName === source.dbName
          && (table.dbSourceId || null) === (source.dbSourceId || null)
          && table.schemaName === (fk.targetSchema || 'dbo') && table.tableName === fk.targetTable);
        if (!target || !(fk.columnPairs || []).length) continue;
        const existing = this.tableRelationships.find(relation => relation.origin === 'foreign_key'
          && relation.sourceTableId === source.tableId && relation.constraintName === fk.constraintName);
        const pairs = fk.columnPairs.map(({ sourceColumn, targetColumn }) => ({ sourceColumn, targetColumn }));
        const discoveredStatus = fk.isDisabled || fk.isNotTrusted ? 'suggested' : 'verified';
        const status = ['rejected', 'stale'].includes(existing?.status) ? existing.status : discoveredStatus;
        const unchanged = existing && existing.targetTableId === target.tableId
          && JSON.stringify(existing.columnPairs) === JSON.stringify(pairs)
          && !!existing.evidence?.disabled === !!fk.isDisabled && !!existing.evidence?.untrusted === !!fk.isNotTrusted
          && !existing.evidence?.missing && existing.status === status;
        if (unchanged) continue;
        const next = this.normalizeRelationship({ ...(existing || {}), id: existing?.id || crypto.randomUUID(),
          sourceTableId: source.tableId, targetTableId: target.tableId, sourceTable: source.tableName, targetTable: target.tableName,
          columnPairs: pairs,
          cardinality: 'many-to-one', origin: 'foreign_key', source: 'foreign_key', constraintName: fk.constraintName,
          status, evidence: { foreignKey: true, disabled: !!fk.isDisabled, untrusted: !!fk.isNotTrusted },
          verifiedBy: status === 'verified' ? 'system' : null, verifiedAt: status === 'verified' ? new Date().toISOString() : null,
          revision: existing ? existing.revision + 1 : 1 });
        if (existing) Object.assign(existing, next); else this.tableRelationships.push(next);
      }
    }
  }

  getGroupedTables() {
    const governance=require('../governance/context'), scope=governance.current();
    if(!scope?.principal?.permissions||scope.principal.role==='admin') return this.tablesStore;
    const sources=require('./sql_connector').dbSources.filter(source=>governance.canRead(source,'sql'));
    // Table packages: only tables in the actor's scope, with columns its level exposes.
    const scopes=require('../governance/scope'), actor=governance.principal();
    return sources.flatMap(source=>scopes.maskTables(this.tablesStore.filter(table=>table.dbSourceId===source.id),source,actor));
  }

  getWorkspaceForSource(source, sources = []) {
    if (!source) return { source: null, tables: [], relationships: [] };
    const available = this.getGroupedTables();
    const legacyUnambiguous = sources.filter(item => String(item.dbName || '').toLowerCase() === String(source.dbName || '').toLowerCase()).length === 1;
    const tables = available.filter(table => table.dbSourceId === source.id || (!table.dbSourceId && legacyUnambiguous && table.dbName && String(table.dbName).toLowerCase() === String(source.dbName || '').toLowerCase()));
    const ids = new Set(tables.map(table => table.tableId).filter(Boolean));
    const relationships = this.getTableRelationships().filter(relation => {
      if (relation.dbSourceId && relation.dbSourceId !== source.id) return false;
      return ['source', 'target'].every(side => {
        if (relation[side + 'TableId']) return ids.has(relation[side + 'TableId']);
        const candidates = available.filter(table => table.tableName === relation[side + 'Table'] && (!relation.dbSourceId || table.dbSourceId === relation.dbSourceId));
        return candidates.length === 1 && tables.includes(candidates[0]);
      });
    });
    return { source: { id: source.id, dbName: source.dbName }, tables, relationships };
  }

  normalizeDomain(value) {
    const normalized = String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
    return normalized.replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || null;
  }

  getTableRelationships() {
    const governance=require('../governance/context'), scope=governance.current();
    if(!scope?.principal?.permissions||scope.principal.role==='admin') return this.tableRelationships;
    const tables=this.getGroupedTables();
    return this.tableRelationships.filter(relation=>['source','target'].every(side=>tables.some(table=>
      relation[side+'TableId']?table.tableId===relation[side+'TableId']:table.tableName===relation[side+'Table']&&(!relation.dbSourceId||relation.dbSourceId===table.dbSourceId))));
  }

  findTable(tableId, tableName) {
    if (tableId) return this.tablesStore.find(table => table.tableId === tableId) || null;
    const matches = this.tablesStore.filter(table => table.tableName === tableName);
    if (matches.length > 1) throw Object.assign(new Error(`Tên bảng '${tableName}' không duy nhất; hãy dùng tableId.`), { statusCode: 400 });
    return matches[0] || null;
  }

  normalizeRelationship(data = {}) {
    const resolveForMigration = (tableId, tableName) => {
      if (tableId) return this.tablesStore.find(table => table.tableId === tableId) || null;
      const matches = this.tablesStore.filter(table => table.tableName === tableName);
      return matches.length === 1 ? matches[0] : null;
    };
    const sourceTable = resolveForMigration(data.sourceTableId, data.sourceTable);
    const targetTable = resolveForMigration(data.targetTableId, data.targetTable);
    const pairs = Array.isArray(data.columnPairs) && data.columnPairs.length
      ? data.columnPairs
      : (data.sourceColumn && data.targetColumn ? [{ sourceColumn: data.sourceColumn, targetColumn: data.targetColumn }] : []);
    return {
      ...data,
      id: data.id || crypto.randomUUID(),
      sourceTableId: data.sourceTableId || sourceTable?.tableId || null,
      targetTableId: data.targetTableId || targetTable?.tableId || null,
      sourceTable: data.sourceTable || sourceTable?.tableName || '',
      targetTable: data.targetTable || targetTable?.tableName || '',
      columnPairs: pairs.map(pair => ({ sourceColumn: String(pair.sourceColumn || ''), targetColumn: String(pair.targetColumn || '') })),
      sourceColumn: pairs[0]?.sourceColumn || data.sourceColumn || '',
      targetColumn: pairs[0]?.targetColumn || data.targetColumn || '',
      relationType: data.relationType || data.cardinality || 'many-to-one',
      cardinality: data.cardinality || data.relationType || 'many-to-one',
      businessRole: String(data.businessRole || ''),
      displayColumn: String(data.displayColumn || ''),
      preferred: data.preferred === true,
      origin: data.origin || data.source || 'manual',
      source: data.source || data.origin || 'manual',
      status: data.status || 'suggested',
      revision: Math.max(1, Number(data.revision) || 1),
      isActive: data.isActive !== false
    };
  }

  validateRelationship(data = {}, currentId = null) {
    const sourceTable = this.findTable(data.sourceTableId, data.sourceTable);
    const targetTable = this.findTable(data.targetTableId, data.targetTable);
    if (!sourceTable || !targetTable) throw Object.assign(new Error('Bảng nguồn hoặc bảng đích không tồn tại.'), { statusCode: 400 });
    if ((sourceTable.dbSourceId || null) !== (targetTable.dbSourceId || null) || sourceTable.dbName !== targetTable.dbName) {
      throw Object.assign(new Error('Quan hệ chỉ được phép trong cùng nguồn và database.'), { statusCode: 400 });
    }
    const pairs = Array.isArray(data.columnPairs) && data.columnPairs.length
      ? data.columnPairs
      : [{ sourceColumn: data.sourceColumn, targetColumn: data.targetColumn }];
    if (!pairs.length || pairs.some(pair => !pair.sourceColumn || !pair.targetColumn)) throw Object.assign(new Error('Quan hệ phải có ít nhất một cặp cột hợp lệ.'), { statusCode: 400 });
    const seen = new Set();
    for (const pair of pairs) {
      const sourceColumn = sourceTable.columns.find(column => column.columnName === pair.sourceColumn);
      const targetColumn = targetTable.columns.find(column => column.columnName === pair.targetColumn);
      if (!sourceColumn) throw Object.assign(new Error(`Cột nguồn '${pair.sourceColumn}' không tồn tại.`), { statusCode: 400 });
      if (!targetColumn) throw Object.assign(new Error(`Cột đích '${pair.targetColumn}' không tồn tại.`), { statusCode: 400 });
      if (sourceColumn.isVisible === false || targetColumn.isVisible === false) throw Object.assign(new Error('Quan hệ chỉ được dùng các cột đang bật hiển thị cho AI.'), { statusCode: 400 });
      const key = `${pair.sourceColumn}\u0000${pair.targetColumn}`;
      if (seen.has(key)) throw Object.assign(new Error('Cặp cột trong quan hệ bị trùng.'), { statusCode: 400 });
      seen.add(key);
    }
    if (data.displayColumn && !targetTable.columns.some(column => column.columnName === data.displayColumn)) {
      throw Object.assign(new Error(`Cột hiển thị '${data.displayColumn}' không tồn tại trong bảng đích.`), { statusCode: 400 });
    }
    if (data.displayColumn && targetTable.columns.find(column => column.columnName === data.displayColumn)?.isVisible === false) {
      throw Object.assign(new Error(`Cột hiển thị '${data.displayColumn}' đang bị tắt cho AI.`), { statusCode: 400 });
    }
    const cardinality = data.cardinality || data.relationType || 'many-to-one';
    if (!['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many', 'unknown'].includes(cardinality)) {
      throw Object.assign(new Error('Loại quan hệ không hợp lệ.'), { statusCode: 400 });
    }
    if (cardinality === 'many-to-many') throw Object.assign(new Error('Quan hệ N:N phải được cấu hình qua bảng trung gian thành hai quan hệ.'), { statusCode: 400 });
    if (data.defaultJoinType && !['LEFT', 'INNER', 'LEFT OUTER'].includes(data.defaultJoinType)) {
      throw Object.assign(new Error('Kiểu JOIN chỉ hỗ trợ LEFT hoặc INNER.'), { statusCode: 400 });
    }
    const duplicate = this.tableRelationships.some(relation => relation.id !== currentId
      && relation.sourceTableId === sourceTable.tableId && relation.targetTableId === targetTable.tableId
      && JSON.stringify(relation.columnPairs) === JSON.stringify(pairs));
    if (duplicate) throw Object.assign(new Error('Quan hệ này đã tồn tại.'), { statusCode: 409 });
    return { sourceTable, targetTable, pairs, cardinality };
  }

  tableColumnsAreUnique(table, columnNames = []) {
    const names = new Set(columnNames);
    // Legacy isUnique flags included composite and INCLUDE columns.
    if (Array.isArray(table?.uniqueConstraints)) return table.uniqueConstraints.some(constraint => {
      const columns = constraint.columnNames || constraint.columns || [];
      return !constraint.isDisabled && !constraint.hasFilter && !constraint.filterDefinition
        && columns.length > 0 && columns.every(name => names.has(name));
    });
    const primaryKeyColumns = (table?.columns || []).filter(column => column.isPrimaryKey).map(column => column.columnName);
    if (primaryKeyColumns.length && primaryKeyColumns.every(name => names.has(name))) return true;
    return false;
  }

  profileSignature(relationship) {
    return crypto.createHash('sha256').update(JSON.stringify({
      structure: relationshipStructure(relationship),
      tables: [relationship.sourceTableId, relationship.targetTableId].map(id => {
        const table = this.findTable(id);
        return table && [id, table.columns.map(c => [c.columnName, c.dataType, c.isPrimaryKey]), table.uniqueConstraints];
      })
    })).digest('hex');
  }

  assertCardinalityEvidence(relationship) {
    this.validateRelationship(relationship, relationship.id);
    if (relationship.cardinality === 'unknown') throw Object.assign(new Error('Cần chọn cardinality trước khi xác minh quan hệ.'), {
      statusCode: 409, code: 'JOIN_CARDINALITY_UNCONFIRMED'
    });
    if (relationship.origin === 'foreign_key' && relationship.evidence?.foreignKey
      && !relationship.evidence.disabled && !relationship.evidence.untrusted && !relationship.evidence.missing
      && relationship.cardinality === 'many-to-one') return;
    if (relationship.origin === 'foreign_key') throw Object.assign(new Error('Khóa ngoại đã mất hoặc chưa được tin cậy; hãy đồng bộ lại nguồn.'), {
      statusCode: 409, code: 'JOIN_FOREIGN_KEY_UNTRUSTED'
    });
    const source = this.findTable(relationship.sourceTableId, relationship.sourceTable);
    const target = this.findTable(relationship.targetTableId, relationship.targetTable);
    const pairs = relationship.columnPairs || [];
    const storedProfile = relationship.evidence?.profile;
    const age = Date.now() - Date.parse(storedProfile?.checkedAt);
    const profile = storedProfile?.signature === this.profileSignature(relationship)
      && age >= 0 && age <= 24 * 60 * 60 * 1000 ? storedProfile : {};
    const cardinality = relationship.cardinality || relationship.relationType;
    const mismatch = (['many-to-one', 'one-to-one'].includes(cardinality) && profile.duplicateTargetKeys > 0)
      || (['one-to-many', 'one-to-one'].includes(cardinality) && profile.duplicateSourceKeys > 0);
    if (mismatch) {
      throw Object.assign(new Error('Dữ liệu profiling mâu thuẫn với cardinality đã chọn; hãy sửa chiều/loại quan hệ trước khi xác minh.'), {
        statusCode: 409, code: 'JOIN_CARDINALITY_MISMATCH', details: { cardinality }
      });
    }
    const sourceUnique = this.tableColumnsAreUnique(source, pairs.map(pair => pair.sourceColumn))
      || profile.duplicateSourceKeys === 0;
    const targetUnique = this.tableColumnsAreUnique(target, pairs.map(pair => pair.targetColumn))
      || profile.duplicateTargetKeys === 0;
    const sourceRequired = ['one-to-many', 'one-to-one'].includes(cardinality);
    const targetRequired = ['many-to-one', 'one-to-one'].includes(cardinality);
    if ((sourceRequired && !sourceUnique) || (targetRequired && !targetUnique)) {
      const error = Object.assign(new Error('Chưa có bằng chứng UNIQUE phù hợp với cardinality đã chọn; hãy sửa chiều quan hệ hoặc chạy profiling trước khi xác minh.'), {
        statusCode: 409, code: 'JOIN_CARDINALITY_UNCONFIRMED',
        details: { sourceUnique, targetUnique, cardinality }
      });
      throw error;
    }
  }

  async addTableRelationship(data, options = {}) {
    const { sourceTable, targetTable, pairs, cardinality } = this.validateRelationship(data);
    const relationship = this.normalizeRelationship({ ...editableRelationship(data), id: crypto.randomUUID(), sourceTableId: sourceTable.tableId,
      targetTableId: targetTable.tableId, sourceTable: sourceTable.tableName, targetTable: targetTable.tableName,
      columnPairs: pairs, cardinality, relationType: cardinality, origin: 'manual', source: 'manual', status: 'suggested', revision: 1 });
    this.tableRelationships.push(relationship);
    if (!options.deferPersistence) this.persist();
    return relationship;
  }

  async addManyToManyRelationship(data = {}, options = {}) {
    const firstInput = { sourceTableId: data.sourceTableId, targetTableId: data.bridgeTableId,
      columnPairs: data.sourceToBridgePairs, cardinality: 'one-to-many', businessRole: `${data.businessRole || 'many_to_many'}_bridge_source` };
    const secondInput = { sourceTableId: data.bridgeTableId, targetTableId: data.targetTableId,
      columnPairs: data.bridgeToTargetPairs, cardinality: 'many-to-one', businessRole: `${data.businessRole || 'many_to_many'}_bridge_target` };
    const first = this.validateRelationship(firstInput);
    const second = this.validateRelationship(secondInput);
    const build = (input, checked) => this.normalizeRelationship({ ...input, id: crypto.randomUUID(),
      sourceTableId: checked.sourceTable.tableId, targetTableId: checked.targetTable.tableId,
      sourceTable: checked.sourceTable.tableName, targetTable: checked.targetTable.tableName,
      columnPairs: checked.pairs, cardinality: checked.cardinality, relationType: checked.cardinality,
      origin: 'manual', source: 'manual', status: 'suggested', revision: 1, manyToManyGroupId: data.groupId || crypto.randomUUID() });
    const groupId = data.groupId || crypto.randomUUID();
    const relationships = [build({ ...firstInput, manyToManyGroupId: groupId }, first), build({ ...secondInput, manyToManyGroupId: groupId }, second)];
    relationships.forEach(relation => { relation.manyToManyGroupId = groupId; this.tableRelationships.push(relation); });
    if (!options.deferPersistence) this.persist();
    return relationships;
  }

  async deleteTableRelationship(id) {
    const deletedRelationship = this.tableRelationships.find(relation => relation.id === id);
    const initialLength = this.tableRelationships.length;
    this.tableRelationships = this.tableRelationships.filter(relation => relation.id !== id);
    this.persist();
    const deleted = this.tableRelationships.length < initialLength;
    if (deleted && deletedRelationship?.status === 'verified') await this.syncToQdrant();
    return deleted;
  }

  async updateTableRelationship(id, data, options = {}) {
    const relationship = this.tableRelationships.find(relation => relation.id === id);
    if (!relationship) return null;
    const wasVerified = relationship.status === 'verified';
    if (data.expectedRevision !== undefined && Number(data.expectedRevision) !== relationship.revision) {
      throw Object.assign(new Error('Quan hệ đã được thay đổi bởi phiên làm việc khác.'), { statusCode: 409 });
    }
    const beforeStructure = relationshipStructure(relationship);
    const updates = editableRelationship(data);
    if (updates.relationType && !updates.cardinality) updates.cardinality = updates.relationType;
    if (!updates.columnPairs && (updates.sourceColumn || updates.targetColumn)) updates.columnPairs = [{
      sourceColumn: updates.sourceColumn || relationship.sourceColumn,
      targetColumn: updates.targetColumn || relationship.targetColumn
    }];
    const merged = { ...relationship, ...updates };
    const { sourceTable, targetTable, pairs, cardinality } = this.validateRelationship(merged, id);
    Object.assign(relationship, this.normalizeRelationship({ ...merged, sourceTableId: sourceTable.tableId,
      targetTableId: targetTable.tableId, sourceTable: sourceTable.tableName, targetTable: targetTable.tableName,
      columnPairs: pairs, cardinality, relationType: cardinality, revision: relationship.revision + 1 }));
    const afterStructure = relationshipStructure(relationship);
    if (beforeStructure !== afterStructure) {
      if (wasVerified) relationship.status = 'stale';
      relationship.verifiedBy = null;
      relationship.verifiedAt = null;
      relationship.evidence = {};
      relationship.origin = 'manual';
      relationship.source = 'manual';
      delete relationship.constraintName;
    }
    if (!options.deferPersistence) {
      this.persist();
      if (wasVerified || relationship.status === 'verified') await this.syncToQdrant();
    }
    return relationship;
  }

  async setTableRelationshipStatus(id, status, expectedRevision, actorId = null) {
    if (!['verified', 'rejected'].includes(status)) throw Object.assign(new Error('Trạng thái quan hệ không hợp lệ.'), { statusCode: 400 });
    const relationship = this.tableRelationships.find(relation => relation.id === id);
    if (!relationship) return null;
    const wasVerified = relationship.status === 'verified';
    if (expectedRevision !== undefined && Number(expectedRevision) !== relationship.revision) {
      throw Object.assign(new Error('Quan hệ đã được thay đổi bởi phiên làm việc khác.'), { statusCode: 409 });
    }
    if (status === 'verified') this.assertCardinalityEvidence(relationship);
    relationship.status = status;
    relationship.revision += 1;
    relationship.verifiedBy = status === 'verified' ? (actorId || 'system') : null;
    relationship.verifiedAt = status === 'verified' ? new Date().toISOString() : null;
    this.persist();
    if (wasVerified || status === 'verified') await this.syncToQdrant();
    return relationship;
  }

  async discoverRelationshipCandidates({ dbSourceId = null, dbName = null } = {}) {
    if (process.env.SQL_RELATIONSHIP_DISCOVERY_ENABLED !== 'true') throw Object.assign(new Error('Relationship discovery đang tắt bởi feature flag.'), { statusCode: 409 });
    const normalize = value => String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
    const singular = value => normalize(value).replace(/ies$/, 'y').replace(/s$/, '');
    const tables = this.tablesStore.filter(table => (!dbSourceId || table.dbSourceId === dbSourceId) && (!dbName || table.dbName === dbName));
    const created = [];
    for (const source of tables) {
      for (const column of source.columns || []) {
        const columnKey = normalize(column.columnName);
        if (column.isPrimaryKey || !columnKey.endsWith('id') || columnKey === 'id') continue;
        const entity = columnKey.slice(0, -2);
        const targets = tables.filter(target => target.tableId !== source.tableId
          && target.dbName === source.dbName && (target.dbSourceId || null) === (source.dbSourceId || null)
          && [singular(target.tableName), singular(target.tableName).replace(/^m|^t/, '')].includes(entity)
          && (target.columns || []).some(candidate => candidate.isPrimaryKey && ['id', columnKey, `${singular(target.tableName)}id`].includes(normalize(candidate.columnName))));
        if (targets.length !== 1) continue;
        const target = targets[0];
        const targetColumn = target.columns.find(candidate => candidate.isPrimaryKey && ['id', columnKey, `${singular(target.tableName)}id`].includes(normalize(candidate.columnName)));
        const pair = [{ sourceColumn: column.columnName, targetColumn: targetColumn.columnName }];
        if (this.tableRelationships.some(relation => relation.sourceTableId === source.tableId && relation.targetTableId === target.tableId
          && JSON.stringify(relation.columnPairs) === JSON.stringify(pair))) continue;
        const relation = this.normalizeRelationship({ id: crypto.randomUUID(), sourceTableId: source.tableId, targetTableId: target.tableId,
          sourceTable: source.tableName, targetTable: target.tableName, columnPairs: pair, cardinality: 'many-to-one',
          origin: 'inferred', source: 'inferred', status: 'suggested', confidenceScore: 70,
          evidence: { nameMatch: true, typeCompatible: String(column.dataType).toLowerCase() === String(targetColumn.dataType).toLowerCase(), targetPrimaryKey: true }, revision: 1 });
        this.tableRelationships.push(relation);
        created.push(relation);
      }
    }
    if (created.length) this.persist();
    return created;
  }

  async profileTableRelationship(id, expectedRevision) {
    const relationship = this.tableRelationships.find(item => item.id === id);
    if (!relationship) return null;
    if (expectedRevision !== undefined && Number(expectedRevision) !== relationship.revision) throw Object.assign(new Error('Quan hệ đã được thay đổi bởi phiên làm việc khác.'), { statusCode: 409 });
    const source = this.findTable(relationship.sourceTableId, relationship.sourceTable);
    const target = this.findTable(relationship.targetTableId, relationship.targetTable);
    if (!source || !target || !source.dbSourceId) throw Object.assign(new Error('Quan hệ không thuộc nguồn SQL live có thể profiling.'), { statusCode: 400 });
    this.validateRelationship(relationship, id);
    const revision = relationship.revision;
    const signature = this.profileSignature(relationship);
    const quote = value => `[${String(value).replace(/]/g, ']]')}]`;
    const pairs = relationship.columnPairs || [];
    const on = pairs.map(pair => `s.${quote(pair.sourceColumn)} = t.${quote(pair.targetColumn)}`).join(' AND ');
    const sourceNull = pairs.map(pair => `s.${quote(pair.sourceColumn)} IS NULL`).join(' OR ');
    const targetColumns = pairs.map(pair => quote(pair.targetColumn)).join(', ');
    const sourceColumns = pairs.map(pair => quote(pair.sourceColumn)).join(', ');
    const sourceName = `${quote(source.schemaName || 'dbo')}.${quote(source.tableName)}`;
    const targetName = `${quote(target.schemaName || 'dbo')}.${quote(target.tableName)}`;
    const sqlConnector = require('./sql_connector');
    const coverageRows = await sqlConnector.executeSqlQuery(`SELECT COUNT_BIG(*) AS totalRows,
      COALESCE(SUM(CASE WHEN ${sourceNull} THEN CAST(1 AS bigint) ELSE CAST(0 AS bigint) END), 0) AS nullKeyRows,
      (SELECT COUNT_BIG(*) FROM ${sourceName} s WHERE NOT (${sourceNull})
        AND NOT EXISTS (SELECT 1 FROM ${targetName} t WHERE ${on})) AS orphanRows
      FROM ${sourceName} s`, source.dbSourceId);
    const duplicateRows = await sqlConnector.executeSqlQuery(`SELECT COUNT_BIG(*) AS duplicateKeys FROM (
      SELECT ${targetColumns} FROM ${targetName} WHERE ${pairs.map(pair => `${quote(pair.targetColumn)} IS NOT NULL`).join(' AND ')}
      GROUP BY ${targetColumns} HAVING COUNT_BIG(*) > 1
    ) duplicate_groups`, source.dbSourceId);
    const needsSourceUnique = ['one-to-many', 'one-to-one'].includes(relationship.cardinality || relationship.relationType);
    const duplicateSourceRows = needsSourceUnique ? await sqlConnector.executeSqlQuery(`SELECT COUNT_BIG(*) AS duplicateKeys FROM (
      SELECT ${sourceColumns} FROM ${sourceName} WHERE ${pairs.map(pair => `${quote(pair.sourceColumn)} IS NOT NULL`).join(' AND ')}
      GROUP BY ${sourceColumns} HAVING COUNT_BIG(*) > 1
    ) duplicate_groups`, source.dbSourceId) : [{ duplicateKeys: null }];
    if (revision !== relationship.revision || signature !== this.profileSignature(relationship)) {
      throw Object.assign(new Error('Quan hệ đã thay đổi trong lúc profiling; hãy chạy lại.'), { statusCode: 409 });
    }
    const count = (value) => {
      const number = Number(value);
      if (value === null || value === undefined || !Number.isSafeInteger(number) || number < 0) {
        throw Object.assign(new Error('Kết quả profiling thiếu hoặc vượt giới hạn số đếm; chưa thể xác minh.'), {
          statusCode: 409, code: 'JOIN_PROFILE_INCOMPLETE'
        });
      }
      return number;
    };
    const counts = { totalRows: count(coverageRows[0]?.totalRows), nullKeyRows: count(coverageRows[0]?.nullKeyRows),
      orphanRows: count(coverageRows[0]?.orphanRows), duplicateTargetKeys: count(duplicateRows[0]?.duplicateKeys),
      ...(needsSourceUnique ? { duplicateSourceKeys: count(duplicateSourceRows[0]?.duplicateKeys) } : {}) };
    const wasVerified = relationship.status === 'verified';
    relationship.evidence ||= {};
    relationship.evidence.profile = { scope: 'full', checkedAt: new Date().toISOString(),
      signature, ...counts };
    const profile = relationship.evidence.profile;
    const cardinality = relationship.cardinality || relationship.relationType;
    const mismatch = (['many-to-one', 'one-to-one'].includes(cardinality) && profile.duplicateTargetKeys > 0)
      || (['one-to-many', 'one-to-one'].includes(cardinality) && profile.duplicateSourceKeys > 0);
    relationship.evidence.cardinalityStatus = mismatch ? 'mismatch' : 'profiled';
    if (mismatch && relationship.status === 'verified') {
      relationship.status = 'stale';
      relationship.verifiedBy = null;
      relationship.verifiedAt = null;
    }
    relationship.revision += 1;
    this.persist();
    if (wasVerified && relationship.status !== 'verified') await this.syncToQdrant();
    return relationship;
  }

  async toggleTableActive(tableName, isActive, tableId = null) {
    const table = this.findTable(tableId, tableName);
    if (table) {
      if (isActive && table.schemaMissing) throw Object.assign(new Error('Bảng đã mất ở nguồn; hãy đồng bộ lại trước khi bật.'), { statusCode: 409 });
      table.isActive = isActive;
      this.persist();
      await this.syncToQdrant();
      return true;
    }
    return false;
  }

  async updateTableDescription(tableName, newDesc) {
    return this.updateTableMetadata(tableName, { description: newDesc });
  }

  async updateTableMetadata(tableName, updates = {}, tableId = null) {
    const table = this.findTable(tableId, tableName);
    if (table) {
      await this.saveTableConfiguration({ tableId: table.tableId, tableName, table: updates });
      return true;
    }
    return false;
  }

  reassignDomain(oldDomain, newDomain) {
    const oldKey = this.normalizeDomain(oldDomain);
    const newKey = this.normalizeDomain(newDomain);
    if (!oldKey || !newKey || oldKey === newKey) return 0;
    let updatedCount = 0;
    this.tablesStore.forEach(table => {
      if (table.domain === oldKey) {
        table.domain = newKey;
        updatedCount += 1;
      }
    });
    if (updatedCount) this.persist();
    return updatedCount;
  }

  async updateColumnDescription(tableName, columnName, newDesc, displayName, tableId = null) {
    const table = this.findTable(tableId, tableName);
    if (table) {
      const col = table.columns.find(c => c.columnName === columnName);
      if (col) {
        col.description = newDesc;
        if (displayName !== undefined) col.displayName = String(displayName || '').trim();
        this.persist();
        await this.syncToQdrant();
        return true;
      }
    }
    return false;
  }

  async saveTableConfiguration(data = {}) {
    const table = this.findTable(data.tableId, data.tableName);
    if (!table) throw Object.assign(new Error('Không tìm thấy bảng cần cập nhật.'), { statusCode: 404 });
    const tablesSnapshot = structuredClone(this.tablesStore);
    const relationshipsSnapshot = structuredClone(this.tableRelationships);
    try {
    const metadata = data.table || {};
    if (metadata.isActive && table.schemaMissing) throw Object.assign(new Error('Bảng đã mất ở nguồn; hãy đồng bộ lại trước khi bật.'), { statusCode: 409 });
    const disabledColumns = (Array.isArray(data.columns) ? data.columns : []).filter(update=>update.isVisible === false).map(update=>update.columnName);
    let configurationAdjustments = [];
    if (metadata.requiredFilters !== undefined) table.requiredFilters = structuredClone(metadata.requiredFilters);
    if (metadata.description !== undefined) table.tableDescription = String(metadata.description || '');
    if (metadata.domain !== undefined) table.domain = this.normalizeDomain(metadata.domain);
    if (metadata.isActive !== undefined) table.isActive = metadata.isActive !== false;
    const column = name => (table.columns || []).find(item => item.columnName === String(name || ''));
    for (const [field, value] of [['defaultMetric', metadata.defaultMetric], ['defaultTimeColumn', metadata.defaultTimeColumn]]) {
      if (value !== undefined) {
        if (value && !column(value)) throw Object.assign(new Error(`Cột ${field} không tồn tại trong bảng.`), { statusCode: 400 });
        if (value) table[field] = value; else delete table[field];
      }
    }
    if (metadata.defaultAggregation !== undefined) {
      const value = String(metadata.defaultAggregation || '').toUpperCase();
      if (value && !['SUM', 'AVG', 'MIN', 'MAX', 'COUNT'].includes(value)) throw Object.assign(new Error('Phép tổng hợp mặc định không hợp lệ.'), { statusCode: 400 });
      if (value) table.defaultAggregation = value; else delete table.defaultAggregation;
    }
    for (const update of Array.isArray(data.columns) ? data.columns : []) {
      const target = column(update.columnName);
      if (!target) throw Object.assign(new Error(`Cột '${update.columnName}' không tồn tại.`), { statusCode: 400 });
      if (update.description !== undefined) target.description = String(update.description || '');
      if (update.displayName !== undefined) target.displayName = String(update.displayName || '').trim();
      if (update.isVisible !== undefined) target.isVisible = update.isVisible !== false;
    }
    if (metadata.semanticModel !== undefined) {
      if (metadata.semanticModel === null) delete table.semanticModel;
      else {
        const semantic = require('./semantic_model');
        const reconciled = semantic.reconcileVisibility(metadata.semanticModel, disabledColumns);
        configurationAdjustments = reconciled.adjustments;
        table.semanticModel = semantic.validateModel(reconciled.model, table);
      }
    } else if (table.semanticModel) {
      const semantic = require('./semantic_model');
      const reconciled = semantic.reconcileVisibility(table.semanticModel, disabledColumns);
      configurationAdjustments = reconciled.adjustments;
      table.semanticModel = semantic.validateModel(reconciled.model, table);
    }
    require('./schema_quality').validateConfiguration(table);
    if (table.requiredFilters !== undefined) require('./required_filters').validate(table.requiredFilters, table);
    for (const change of Array.isArray(data.relationships) ? data.relationships : []) {
      if (change.operation === 'many-to-many') await this.addManyToManyRelationship(change.payload || {}, { deferPersistence: true });
      else if (change.id) await this.updateTableRelationship(change.id, { ...(change.payload || {}), expectedRevision: change.expectedRevision }, { deferPersistence: true });
      else await this.addTableRelationship(change.payload || {}, { deferPersistence: true });
    }
    this.persist();
    const vectorSync = await this.syncToQdrant();
    return { table, tables: this.getGroupedTables(), relationships: this.getTableRelationships(), vectorSync, configurationAdjustments };
    } catch (error) {
      this.tablesStore = tablesSnapshot;
      this.tableRelationships = relationshipsSnapshot;
      throw error;
    }
  }

  async deleteTable(tableName, tableId = null) {
    const table = this.findTable(tableId, tableName);
    if (!table) return false;
    this.tablesStore = this.tablesStore.filter(t => t.tableId !== table.tableId);
    this.tableRelationships = this.tableRelationships.filter(r => r.sourceTableId !== table.tableId && r.targetTableId !== table.tableId);
    this.persist();
    await this.syncToQdrant();
    return true;
  }

  // Returns flattened column list for active tables only (used by Text-to-SQL AI)
  getDictionary() {
    const activeColumns = [];
    this.tablesStore.filter(t => t.isActive).forEach(t => {
      t.columns.filter(c => c.isVisible !== false).forEach(c => {
        activeColumns.push({
          tableName: t.tableName,
          dbName: t.dbName,
          domain: t.domain || null,
          columnName: c.columnName,
          dataType: c.dataType,
          isPrimaryKey: c.isPrimaryKey,
          description: c.description
        });
      });
    });
    return activeColumns;
  }

  getGlossary() {
    return this.businessGlossary;
  }

  async addGlossaryTerm(term, fullMeaning, category) {
    this.businessGlossary.push({ term, fullMeaning, category: category || 'Chung' });
    this.persist();
    await this.syncToQdrant();
    return this.businessGlossary;
  }

  async updateGlossaryTerm(oldTerm, term, fullMeaning, category) {
    const item = this.businessGlossary.find(g => g.term === oldTerm);
    if (item) {
      item.term = term;
      item.fullMeaning = fullMeaning;
      item.category = category || item.category;
      this.persist();
      await this.syncToQdrant();
      return true;
    }
    return false;
  }

  async deleteGlossaryTerm(term) {
    this.businessGlossary = this.businessGlossary.filter(g => g.term !== term);
    this.persist();
    await this.syncToQdrant();
    return true;
  }

  async syncToQdrant({ defer = true } = {}) {
    const storage = require('../storage');
    if (defer && storage.enabled()) {
      storage.enqueue('dictionary.sync', 'dictionary-schema');
      return { success: true, scheduled: true };
    }
    const qdrantService = require('./qdrant_service');
    const domainAliasService = require('../assistant/domain_alias_service');
    try {
      const activeRelationships = this.tableRelationships.filter(relation => relation.isActive !== false && relation.status === 'verified');
      const result = await qdrantService.syncTablesToQdrant(
        this.tablesStore,
        this.businessGlossary,
        activeRelationships,
        domainAliasService.getDomainAliases()
      );
      return result;
    } catch (err) {
      console.error(`[Qdrant] Lỗi đồng bộ Qdrant:`, err.message);
      return { success: false, error: err.message };
    }
  }
}

const dictionaryService = new DictionaryService();
module.exports = dictionaryService;
module.exports.DictionaryService = DictionaryService;
