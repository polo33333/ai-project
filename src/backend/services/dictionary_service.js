/**
 * Data Dictionary & Business Glossary Service (Persistent Storage Enabled)
 * Grouped Table Architecture with Table Active/Inactive Toggle & Auto-Sync to Qdrant Vector DB
 */

const StorageHelper = require('../utils/storage_helper');

class DictionaryService {
  constructor() {
    this.tablesStore = StorageHelper.loadJson('dictionary.json', []);
    this.tableRelationships = StorageHelper.loadJson('table_relationships.json', []);
    this.businessGlossary = StorageHelper.loadJson('glossary.json', []);
  }

  persist() {
    StorageHelper.saveJson('dictionary.json', this.tablesStore);
    StorageHelper.saveJson('glossary.json', this.businessGlossary);
    StorageHelper.saveJson('table_relationships.json', this.tableRelationships);
  }

  saveDictionaryItems(tables) {
    tables.forEach(t => {
      const existing = this.tablesStore.find(tbl => tbl.tableName === t.tableName);
      const formattedCols = t.columns.map(c => ({
        columnName: c.columnName,
        dataType: c.dataType,
        isPrimaryKey: c.isPrimaryKey,
        description: c.description || `Cột ${c.columnName} thuộc bảng ${t.tableName}`
      }));

      if (existing) {
        existing.columns = formattedCols;
        existing.dbName = t.dbName || existing.dbName;
        if (t.domain !== undefined) existing.domain = this.normalizeDomain(t.domain);
      } else {
        this.tablesStore.push({
          tableName: t.tableName,
          dbName: t.dbName || "SQLServer_DB",
          domain: this.normalizeDomain(t.domain),
          isActive: true,
          tableDescription: `Bảng dữ liệu ${t.tableName} thuộc CSDL ${t.dbName || ''}`,
          columns: formattedCols
        });
      }
    });
    this.persist();
    return this.tablesStore;
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

  async addTableRelationship(data) {
    const sourceTable = this.tablesStore.find(table => table.tableName === data.sourceTable);
    const targetTable = this.tablesStore.find(table => table.tableName === data.targetTable);
    if (!sourceTable || !targetTable) throw new Error('Bảng nguồn hoặc bảng đích không tồn tại.');
    if (!sourceTable.columns.some(column => column.columnName === data.sourceColumn)) throw new Error('Cột nguồn không tồn tại.');
    if (!targetTable.columns.some(column => column.columnName === data.targetColumn)) throw new Error('Cột đích không tồn tại.');
    const duplicate = this.tableRelationships.some(relation =>
      relation.sourceTable === data.sourceTable && relation.sourceColumn === data.sourceColumn &&
      relation.targetTable === data.targetTable && relation.targetColumn === data.targetColumn
    );
    if (duplicate) throw new Error('Quan hệ này đã tồn tại.');
    const relationship = {
      id: `rel-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      sourceTable: data.sourceTable,
      sourceColumn: data.sourceColumn,
      targetTable: data.targetTable,
      targetColumn: data.targetColumn,
      relationType: data.relationType || 'many-to-one',
      description: data.description || '',
      source: 'manual',
      isActive: true
    };
    this.tableRelationships.push(relationship);
    this.persist();
    await this.syncToQdrant();
    return relationship;
  }

  async deleteTableRelationship(id) {
    const initialLength = this.tableRelationships.length;
    this.tableRelationships = this.tableRelationships.filter(relation => relation.id !== id);
    this.persist();
    const deleted = this.tableRelationships.length < initialLength;
    if (deleted) await this.syncToQdrant();
    return deleted;
  }

  async updateTableRelationship(id, data) {
    const relationship = this.tableRelationships.find(relation => relation.id === id);
    if (!relationship) return null;
    const sourceTable = this.tablesStore.find(table => table.tableName === data.sourceTable);
    const targetTable = this.tablesStore.find(table => table.tableName === data.targetTable);
    if (!sourceTable || !targetTable) throw new Error('Bảng nguồn hoặc bảng đích không tồn tại.');
    if (!sourceTable.columns.some(column => column.columnName === data.sourceColumn)) throw new Error('Cột nguồn không tồn tại.');
    if (!targetTable.columns.some(column => column.columnName === data.targetColumn)) throw new Error('Cột đích không tồn tại.');
    Object.assign(relationship, {
      sourceTable: data.sourceTable,
      sourceColumn: data.sourceColumn,
      targetTable: data.targetTable,
      targetColumn: data.targetColumn,
      relationType: data.relationType || relationship.relationType,
      description: data.description || ''
    });
    this.persist();
    await this.syncToQdrant();
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

  async updateColumnDescription(tableName, columnName, newDesc) {
    const table = this.tablesStore.find(t => t.tableName === tableName);
    if (table) {
      const col = table.columns.find(c => c.columnName === columnName);
      if (col) {
        col.description = newDesc;
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

  async syncToQdrant() {
    const qdrantService = require('./qdrant_service');
    const domainAliasService = require('../intelligent_core/domain_alias_service');
    try {
      const activeRelationships = this.tableRelationships.filter(relation => relation.isActive !== false);
      const result = await qdrantService.syncTablesToQdrant(
        this.tablesStore,
        this.businessGlossary,
        activeRelationships,
        domainAliasService.getDomainAliases()
      );
      if (result && result.success) {
        console.log(`[Qdrant] Đồng bộ thành công ${result.indexedTables || 0} bảng active & ${result.indexedGlossary || 0} thuật ngữ (${result.totalPoints || 0} vector points) vào Qdrant DB.`);
      }
      return result;
    } catch (err) {
      console.error(`[Qdrant] Lỗi đồng bộ Qdrant:`, err.message);
      return { success: false, error: err.message };
    }
  }
}

module.exports = new DictionaryService();
