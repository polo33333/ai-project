/**
 * Data Dictionary & Business Glossary Service (Persistent Storage Enabled)
 * Grouped Table Architecture with Table Active/Inactive Toggle & Auto-Sync to Qdrant Vector DB
 */

const StorageHelper = require('../utils/storage_helper');
const crypto = require('node:crypto');
const { withIdentity, sameTable } = require('./schema_identity');

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

  saveDictionaryItems(tables) {
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
        description: c.description || prior?.description || `Cột ${c.columnName} thuộc bảng ${t.tableName}`
      }); });

      if (existing) {
        const priorColumns = existing.columns || [];
        Object.assign(existing, withIdentity({ ...existing, ...identified, columns: formattedCols }));
        existing.dbName = t.dbName || existing.dbName;
        if (t.domain !== undefined) existing.domain = this.normalizeDomain(t.domain);
        if (existing.defaultMetric && !formattedCols.some(column => column.columnName === existing.defaultMetric)) delete existing.defaultMetric;
        if (existing.defaultTimeColumn && !formattedCols.some(column => column.columnName === existing.defaultTimeColumn)) delete existing.defaultTimeColumn;
        this.markChangedRelationshipsStale(existing.tableId, priorColumns, formattedCols);
      } else {
        this.tablesStore.push(withIdentity({
          tableName: t.tableName,
          dbName: t.dbName || "SQLServer_DB",
          dbSourceId: t.dbSourceId || null,
          schemaName: t.schemaName || 'dbo',
          domain: this.normalizeDomain(t.domain),
          isActive: true,
          tableDescription: `Bảng dữ liệu ${t.tableName} thuộc CSDL ${t.dbName || ''}`,
          columns: formattedCols
        }));
      }
    });
    this.importForeignKeyRelationships(tables);
    this.persist();
    return this.tablesStore;
  }

  markChangedRelationshipsStale(tableId, before = [], after = []) {
    const signature = columns => new Map(columns.map(column => [column.columnName, `${column.dataType}|${!!column.isPrimaryKey}|${!!column.isUnique}`]));
    const oldMap = signature(before);
    const newMap = signature(after);
    this.tableRelationships.forEach(relation => {
      if (relation.sourceTableId !== tableId && relation.targetTableId !== tableId) return;
      const pairs = relation.columnPairs || [];
      const affected = pairs.some(pair => {
        const name = relation.sourceTableId === tableId ? pair.sourceColumn : pair.targetColumn;
        return !newMap.has(name) || oldMap.get(name) !== newMap.get(name);
      });
      if (affected && relation.status === 'verified') {
        relation.status = 'stale';
        relation.revision = (relation.revision || 1) + 1;
        relation.verifiedBy = null;
        relation.verifiedAt = null;
      }
    });
  }

  importForeignKeyRelationships(tables = []) {
    for (const rawTable of tables) {
      const source = this.tablesStore.find(table => table.tableId === withIdentity(rawTable).tableId);
      if (!source) continue;
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
          && existing.status === status;
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
    return this.tablesStore;
  }

  normalizeDomain(value) {
    const normalized = String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
    return normalized.replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || null;
  }

  getTableRelationships() {
    return this.tableRelationships;
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
      if (!sourceTable.columns.some(column => column.columnName === pair.sourceColumn)) throw Object.assign(new Error(`Cột nguồn '${pair.sourceColumn}' không tồn tại.`), { statusCode: 400 });
      if (!targetTable.columns.some(column => column.columnName === pair.targetColumn)) throw Object.assign(new Error(`Cột đích '${pair.targetColumn}' không tồn tại.`), { statusCode: 400 });
      const key = `${pair.sourceColumn}\u0000${pair.targetColumn}`;
      if (seen.has(key)) throw Object.assign(new Error('Cặp cột trong quan hệ bị trùng.'), { statusCode: 400 });
      seen.add(key);
    }
    if (data.displayColumn && !targetTable.columns.some(column => column.columnName === data.displayColumn)) {
      throw Object.assign(new Error(`Cột hiển thị '${data.displayColumn}' không tồn tại trong bảng đích.`), { statusCode: 400 });
    }
    const cardinality = data.cardinality || data.relationType || 'many-to-one';
    if (!['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many', 'unknown'].includes(cardinality)) {
      throw Object.assign(new Error('Loại quan hệ không hợp lệ.'), { statusCode: 400 });
    }
    if (cardinality === 'many-to-many') throw Object.assign(new Error('Quan hệ N:N phải được cấu hình qua bảng trung gian thành hai quan hệ.'), { statusCode: 400 });
    const duplicate = this.tableRelationships.some(relation => relation.id !== currentId
      && relation.sourceTableId === sourceTable.tableId && relation.targetTableId === targetTable.tableId
      && JSON.stringify(relation.columnPairs) === JSON.stringify(pairs));
    if (duplicate) throw Object.assign(new Error('Quan hệ này đã tồn tại.'), { statusCode: 409 });
    return { sourceTable, targetTable, pairs, cardinality };
  }

  async addTableRelationship(data) {
    const { sourceTable, targetTable, pairs, cardinality } = this.validateRelationship(data);
    const relationship = this.normalizeRelationship({ ...data, id: crypto.randomUUID(), sourceTableId: sourceTable.tableId,
      targetTableId: targetTable.tableId, sourceTable: sourceTable.tableName, targetTable: targetTable.tableName,
      columnPairs: pairs, cardinality, relationType: cardinality, origin: 'manual', source: 'manual', status: 'suggested', revision: 1 });
    this.tableRelationships.push(relationship);
    this.persist();
    return relationship;
  }

  async addManyToManyRelationship(data = {}) {
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
    this.persist();
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

  async updateTableRelationship(id, data) {
    const relationship = this.tableRelationships.find(relation => relation.id === id);
    if (!relationship) return null;
    const wasVerified = relationship.status === 'verified';
    if (data.expectedRevision !== undefined && Number(data.expectedRevision) !== relationship.revision) {
      throw Object.assign(new Error('Quan hệ đã được thay đổi bởi phiên làm việc khác.'), { statusCode: 409 });
    }
    const merged = { ...relationship, ...data };
    const { sourceTable, targetTable, pairs, cardinality } = this.validateRelationship(merged, id);
    Object.assign(relationship, this.normalizeRelationship({ ...merged, sourceTableId: sourceTable.tableId,
      targetTableId: targetTable.tableId, sourceTable: sourceTable.tableName, targetTable: targetTable.tableName,
      columnPairs: pairs, cardinality, relationType: cardinality, revision: relationship.revision + 1 }));
    this.persist();
    if (wasVerified || relationship.status === 'verified') await this.syncToQdrant();
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
    const quote = value => `[${String(value).replace(/]/g, ']]')}]`;
    const pairs = relationship.columnPairs || [];
    const on = pairs.map(pair => `s.${quote(pair.sourceColumn)} = t.${quote(pair.targetColumn)}`).join(' AND ');
    const sourceNull = pairs.map(pair => `s.${quote(pair.sourceColumn)} IS NULL`).join(' OR ');
    const targetMissing = pairs.map(pair => `t.${quote(pair.targetColumn)} IS NULL`).join(' AND ');
    const targetColumns = pairs.map(pair => quote(pair.targetColumn)).join(', ');
    const sourceName = `${quote(source.schemaName || 'dbo')}.${quote(source.tableName)}`;
    const targetName = `${quote(target.schemaName || 'dbo')}.${quote(target.tableName)}`;
    const sqlConnector = require('./sql_connector');
    const coverageRows = await sqlConnector.executeSqlQuery(`SELECT COUNT_BIG(*) AS totalRows,
      SUM(CASE WHEN ${sourceNull} THEN 1 ELSE 0 END) AS nullKeyRows,
      SUM(CASE WHEN NOT (${sourceNull}) AND ${targetMissing} THEN 1 ELSE 0 END) AS orphanRows
      FROM ${sourceName} s LEFT JOIN ${targetName} t ON ${on}`, source.dbSourceId);
    const duplicateRows = await sqlConnector.executeSqlQuery(`SELECT COUNT_BIG(*) AS duplicateKeys FROM (
      SELECT ${targetColumns} FROM ${targetName} WHERE ${pairs.map(pair => `${quote(pair.targetColumn)} IS NOT NULL`).join(' AND ')}
      GROUP BY ${targetColumns} HAVING COUNT_BIG(*) > 1
    ) duplicate_groups`, source.dbSourceId);
    relationship.evidence ||= {};
    relationship.evidence.profile = { scope: 'full', checkedAt: new Date().toISOString(),
      totalRows: Number(coverageRows[0]?.totalRows || 0), nullKeyRows: Number(coverageRows[0]?.nullKeyRows || 0),
      orphanRows: Number(coverageRows[0]?.orphanRows || 0), duplicateTargetKeys: Number(duplicateRows[0]?.duplicateKeys || 0) };
    relationship.revision += 1;
    this.persist();
    return relationship;
  }

  async toggleTableActive(tableName, isActive) {
    const table = this.tablesStore.find(t => t.tableName === tableName);
    if (table) {
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

  async updateTableMetadata(tableName, updates = {}) {
    const table = this.tablesStore.find(t => t.tableName === tableName);
    if (table) {
      if (updates.description !== undefined) table.tableDescription = String(updates.description || '');
      if (updates.domain !== undefined) table.domain = this.normalizeDomain(updates.domain);
      const column = name => (table.columns || []).find(item => item.columnName === String(name || ''));
      if (updates.defaultMetric !== undefined) {
        const value = String(updates.defaultMetric || '');
        if (value && !column(value)) throw Object.assign(new Error('Cột metric mặc định không tồn tại trong bảng.'), { statusCode: 400 });
        if (value && !/^(?:tinyint|smallint|int|bigint|decimal|numeric|float|real|money|smallmoney)$/i.test(column(value)?.dataType || '')) {
          throw Object.assign(new Error('Metric mặc định phải là cột kiểu số.'), { statusCode: 400 });
        }
        if (value) table.defaultMetric = value; else delete table.defaultMetric;
      }
      if (updates.defaultTimeColumn !== undefined) {
        const value = String(updates.defaultTimeColumn || '');
        if (value && !column(value)) throw Object.assign(new Error('Cột thời gian mặc định không tồn tại trong bảng.'), { statusCode: 400 });
        if (value && !/date|time/i.test(column(value)?.dataType || '')) throw Object.assign(new Error('Cột thời gian mặc định phải có kiểu ngày/giờ.'), { statusCode: 400 });
        if (value) table.defaultTimeColumn = value; else delete table.defaultTimeColumn;
      }
      if (updates.defaultAggregation !== undefined) {
        const value = String(updates.defaultAggregation || '').toUpperCase();
        if (value && !['SUM', 'AVG', 'MIN', 'MAX', 'COUNT'].includes(value)) throw Object.assign(new Error('Phép tổng hợp mặc định không hợp lệ.'), { statusCode: 400 });
        if (value) table.defaultAggregation = value; else delete table.defaultAggregation;
      }
      this.persist();
      await this.syncToQdrant();
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

  async updateColumnDescription(tableName, columnName, newDesc, displayName) {
    const table = this.tablesStore.find(t => t.tableName === tableName);
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

  async deleteTable(tableName) {
    this.tablesStore = this.tablesStore.filter(t => t.tableName !== tableName);
    this.persist();
    await this.syncToQdrant();
    return true;
  }

  // Returns flattened column list for active tables only (used by Text-to-SQL AI)
  getDictionary() {
    const activeColumns = [];
    this.tablesStore.filter(t => t.isActive).forEach(t => {
      t.columns.forEach(c => {
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
    if (defer && storage.enabled() && storage.afterCommit('dictionary-qdrant-sync', () => this.syncToQdrant({ defer: false }))) {
      return { success: true, scheduled: true };
    }
    const qdrantService = require('./qdrant_service');
    const domainAliasService = require('../intelligent_core/domain_alias_service');
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
