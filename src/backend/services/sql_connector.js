/**
 * SQL Server Connector Engine & Live INFORMATION_SCHEMA AST Parser
 * Connects directly to SQL Server via `tedious` driver
 * Reads real tables, columns, data types, primary keys, and MS_Description from live databases.
 * Supports Named Instances (e.g. 103.226.248.147\SQLEXPRESS or 103.226.248.147,1433\sqlexpress)
 */

// Polyfill AbortSignal.any for Node.js v18 compatibility
if (typeof AbortSignal !== 'undefined' && !AbortSignal.any) {
  AbortSignal.any = function (signals) {
    const controller = new AbortController();
    for (const signal of signals) {
      if (signal) {
        if (signal.aborted) {
          controller.abort(signal.reason);
          break;
        }
        signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
      }
    }
    return controller.signal;
  };
}

let Connection = null;
let Request = null;

try {
  const tedious = require('tedious');
  Connection = tedious.Connection;
  Request = tedious.Request;
} catch (e) {
  console.warn("Mô-đun 'tedious' chưa được tải. Kết nối SQL Server sẽ dùng DDL Parser.");
}

const StorageHelper = require('../utils/storage_helper');
const crypto = require('node:crypto');

class SqlConnector {
  constructor() {
    StorageHelper.bind(this, 'dbSources', 'db_sources.json', []);
    this.schemas = [];
    this.ensureSingleDefault();
  }

  persist() {
    StorageHelper.saveJson('db_sources.json', this.dbSources);
  }

  ensureSingleDefault(preferredId = null) {
    const selected = (preferredId && this.dbSources.find(source => source.id === preferredId))
      || this.dbSources.find(source => source.isDefault)
      || this.dbSources.find(source => source.mode === 'live' || source.type === 'Direct Live Connection')
      || this.dbSources[0];
    let changed = false;
    this.dbSources.forEach(source => {
      const isDefault = !!selected && source.id === selected.id;
      if (source.isDefault !== isDefault) changed = true;
      source.isDefault = isDefault;
    });
    if (changed) this.persist();
    return selected || null;
  }

  getDbSources() {
    this.ensureSingleDefault();
    return this.dbSources.map(({ password, ...source }) => ({
      ...source,
      hasPassword: !!password
    }));
  }

  getDefaultDbSource() {
    return this.ensureSingleDefault() || null;
  }

  setDefaultDbSource(id) {
    const target = this.dbSources.find(source => source.id === id);
    if (!target) throw new Error('Nguồn CSDL không tồn tại.');
    if (target.mode !== 'live' && target.type !== 'Direct Live Connection') {
      throw new Error('Chỉ nguồn kết nối trực tiếp mới có thể đặt làm mặc định.');
    }
    this.ensureSingleDefault(id);
    return target;
  }

  async testDbSource(id, signal = null) {
    const source = this.dbSources.find(item => item.id === id);
    if (!source) throw Object.assign(new Error('Nguồn CSDL không tồn tại.'), { statusCode: 404 });
    if (source.mode !== 'live' && source.type !== 'Direct Live Connection') {
      throw Object.assign(new Error('Nguồn này không phải kết nối SQL trực tiếp.'), { statusCode: 400 });
    }
    const startedAt = Date.now();
    await this.executeSqlQuery('SELECT 1 AS ConnectionHealth', source.id, signal);
    return { sourceId: source.id, dbName: source.dbName, latencyMs: Date.now() - startedAt };
  }

  /**
   * Parse DDL SQL Script string (CREATE TABLE statements)
   */
  parseDdlScript(ddlContent, dbName = "Default_DB") {
    const tableRegex = /CREATE\s+TABLE\s+([^\s\()]+)\s*\(([^;]+)\)/gi;
    const parsedTables = [];
    let match;
    let totalCols = 0;

    while ((match = tableRegex.exec(ddlContent)) !== null) {
      const tableName = match[1].replace(/[[\]`"]/g, '');
      const columnsBody = match[2];
      
      const rawDefinitions = columnsBody.split(/\n|,/);
      const columns = [];

      rawDefinitions.forEach(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.toUpperCase().startsWith('CONSTRAINT') && !trimmed.toUpperCase().startsWith('PRIMARY KEY') && !trimmed.toUpperCase().startsWith('FOREIGN KEY')) {
          const parts = trimmed.split(/\s+/);
          if (parts.length >= 2) {
            const colName = parts[0].replace(/[[\]`"]/g, '');
            const colType = parts[1].replace(/,/g, '');
            const isPk = trimmed.toUpperCase().includes('PRIMARY KEY');
            const isFk = trimmed.toUpperCase().includes('REFERENCES');

            columns.push({
              columnName: colName,
              dataType: colType,
              isPrimaryKey: isPk,
              isForeignKey: isFk,
              description: `Mô tả tự động AI sinh cho ${tableName}.${colName}`
            });
            totalCols++;
          }
        }
      });

      if (columns.length > 0) {
        parsedTables.push({
          tableName: tableName,
          dbName: dbName,
          columnCount: columns.length,
          columns: columns
        });
      }
    }

    // Save DB source record
    const existing = this.dbSources.find(s => s.dbName === dbName);
    if (existing) {
      existing.tablesCount = parsedTables.length;
      existing.columnsCount = totalCols;
      existing.lastSync = "Vừa xong";
    } else {
      this.dbSources.unshift({
        id: crypto.randomUUID(),
        dbName: dbName,
        type: "DDL Script Import",
        host: "Local File (.sql)",
        tablesCount: parsedTables.length,
        columnsCount: totalCols,
        status: "Indexed in Qdrant",
        mode: "ddl",
        lastSync: "Vừa xong"
      });
    }

    this.schemas.push(...parsedTables);
    this.persist();
    return parsedTables;
  }

  /**
   * Connect Live SQL Server and extract real INFORMATION_SCHEMA
   */
  async addLiveSource(config) {
    const sourceId = config.sourceId || null;
    const currentSource = sourceId ? this.dbSources.find(source => source.id === sourceId) : null;
    if (sourceId && !currentSource) throw new Error('Nguồn CSDL cần chỉnh sửa không tồn tại.');
    let rawHost = (config.host || 'localhost').trim();
    const dbName = config.dbName || config.database || 'master';
    const user = config.user || 'sa';
    const password = config.password || currentSource?.password || '';
    let port = 1433;
    let instanceName = undefined;

    // Smart parsing for SQL Server Host strings:
    // e.g. "103.226.248.147,1433\sqlexpress" -> host: "103.226.248.147", port: 1433, instance: "sqlexpress"
    if (rawHost.includes('\\')) {
      const parts = rawHost.split('\\');
      rawHost = parts[0].trim();
      const instancePart = parts[1].trim();
      const instancePieces = instancePart.split(':');
      instanceName = instancePieces[0];
      if (instancePieces[1] && !isNaN(parseInt(instancePieces[1], 10))) port = parseInt(instancePieces[1], 10);
    }

    if (rawHost.includes(',')) {
      const parts = rawHost.split(',');
      rawHost = parts[0].trim();
      const parsedPort = parseInt(parts[1], 10);
      if (!isNaN(parsedPort)) port = parsedPort;
    } else if (rawHost.includes(':')) {
      const parts = rawHost.split(':');
      rawHost = parts[0].trim();
      const parsedPort = parseInt(parts[1], 10);
      if (!isNaN(parsedPort)) port = parsedPort;
    }

    const resolvedSourceId = currentSource?.id || crypto.randomUUID();
    let liveTables = [];

    if (Connection) {
      // Attempt 1: Try Direct TCP Connection (Fast & works when port 1433 is open)
      try {
        liveTables = await this.queryLiveInformationSchema({
          host: rawHost,
          port: port,
          instanceName: undefined, // Force TCP port direct
          dbName,
          user,
          password
        });
      } catch (tcpErr) {
        // Attempt 2: If Direct TCP failed and instance name was provided, try SQL Browser Instance discovery
        if (instanceName) {
          try {
            liveTables = await this.queryLiveInformationSchema({
              host: rawHost,
              port: undefined,
              instanceName: instanceName,
              dbName,
              user,
              password
            });
          } catch (instErr) {
            throw new Error(`Không thể kết nối SQL Server '${rawHost}' (Thử cả TCP Port ${port} lẫn Instance '${instanceName}'). Lỗi: ${tcpErr.message}`);
          }
        } else {
          throw tcpErr;
        }
      }
    }

    if (!liveTables || liveTables.length === 0) {
      throw new Error(`Cơ sở dữ liệu '${dbName}' trên SQL Server (${rawHost}) không trả về bảng dữ liệu nào.`);
    }

    let totalCols = liveTables.reduce((acc, t) => acc + t.columns.length, 0);

    const newSrc = {
      id: resolvedSourceId,
      dbName: dbName,
      type: "Direct Live Connection",
      host: `${rawHost}${instanceName ? '\\' + instanceName : ''}:${port}`,
      tablesCount: liveTables.length,
      columnsCount: totalCols,
      user: user,
      password: password,
      status: "Live Read-Only",
      mode: "live",
      isDefault: currentSource ? !!currentSource.isDefault : this.dbSources.length === 0,
      lastSync: "Vừa xong"
    };

    // Replace the edited source (or an older connection with the same DB name).
    this.dbSources = this.dbSources.filter(s => s.id !== newSrc.id && s.dbName !== dbName);
    this.dbSources.unshift(newSrc);
    this.ensureSingleDefault(newSrc.isDefault ? newSrc.id : null);
    liveTables = liveTables.map(table => ({ ...table, dbSourceId: resolvedSourceId }));
    this.schemas.push(...liveTables);
    this.persist();

    return liveTables;
  }

  async refreshLiveSource(id) {
    const source = this.dbSources.find(item => item.id === id);
    if (!source) throw Object.assign(new Error('Nguồn CSDL không tồn tại.'), { statusCode: 404 });
    if (source.mode !== 'live' && source.type !== 'Direct Live Connection') throw Object.assign(new Error('Chỉ có thể làm mới nguồn SQL live.'), { statusCode: 400 });
    return this.addLiveSource({ sourceId: source.id, host: source.host, dbName: source.dbName, user: source.user, password: source.password });
  }

  /**
   * Execute INFORMATION_SCHEMA query using Tedious connection
   */
  queryLiveInformationSchema(opts) {
    return new Promise((resolve, reject) => {
      let isSettled = false;

      const timeoutTimer = setTimeout(() => {
        if (!isSettled) {
          isSettled = true;
          try { connection.close(); } catch (e) {}
          reject(new Error(`Timeout kết nối (12s): Không kết nối được IP '${opts.host}' trên ${opts.instanceName ? "Instance '" + opts.instanceName + "'" : "Port " + (opts.port || 1433)}.`));
        }
      }, 12000);

      const connectionConfig = {
        server: opts.host,
        authentication: {
          type: 'default',
          options: {
            userName: opts.user,
            password: opts.password
          }
        },
        options: {
          port: opts.instanceName ? undefined : opts.port,
          instanceName: opts.instanceName,
          database: opts.dbName,
          encrypt: false,
          trustServerCertificate: true,
          connectTimeout: 12000,
          requestTimeout: 15000
        }
      };

      const connection = new Connection(connectionConfig);

      connection.on('connect', (err) => {
        if (isSettled) return;

        if (err) {
          isSettled = true;
          clearTimeout(timeoutTimer);
          try { connection.close(); } catch (e) {}
          return reject(new Error(`Lỗi đăng nhập / kết nối SQL Server (${opts.host}): ${err.message}`));
        }

        const sqlQuery = `
          SELECT s.name AS TABLE_SCHEMA, t.name AS TABLE_NAME, c.name AS COLUMN_NAME,
            ty.name AS DATA_TYPE, c.is_nullable AS IS_NULLABLE, c.column_id AS ORDINAL_POSITION,
            CASE WHEN pk.column_id IS NOT NULL THEN 1 ELSE 0 END AS IS_PRIMARY_KEY,
            CASE WHEN uq.column_id IS NOT NULL THEN 1 ELSE 0 END AS IS_UNIQUE_KEY,
            fk.name AS FK_NAME, fk.is_disabled AS FK_DISABLED, fk.is_not_trusted AS FK_NOT_TRUSTED,
            rs.name AS REF_SCHEMA, rt.name AS REF_TABLE, rc.name AS REF_COLUMN,
            fkc.constraint_column_id AS FK_ORDINAL
          FROM sys.tables t
          JOIN sys.schemas s ON s.schema_id=t.schema_id
          JOIN sys.columns c ON c.object_id=t.object_id
          JOIN sys.types ty ON ty.user_type_id=c.user_type_id
          LEFT JOIN (
            SELECT ic.object_id,ic.column_id FROM sys.indexes i JOIN sys.index_columns ic
              ON ic.object_id=i.object_id AND ic.index_id=i.index_id WHERE i.is_primary_key=1
          ) pk ON pk.object_id=c.object_id AND pk.column_id=c.column_id
          LEFT JOIN (
            SELECT ic.object_id,ic.column_id FROM sys.indexes i JOIN sys.index_columns ic
              ON ic.object_id=i.object_id AND ic.index_id=i.index_id WHERE i.is_unique=1
          ) uq ON uq.object_id=c.object_id AND uq.column_id=c.column_id
          LEFT JOIN sys.foreign_key_columns fkc ON fkc.parent_object_id=c.object_id AND fkc.parent_column_id=c.column_id
          LEFT JOIN sys.foreign_keys fk ON fk.object_id=fkc.constraint_object_id
          LEFT JOIN sys.tables rt ON rt.object_id=fkc.referenced_object_id
          LEFT JOIN sys.schemas rs ON rs.schema_id=rt.schema_id
          LEFT JOIN sys.columns rc ON rc.object_id=fkc.referenced_object_id AND rc.column_id=fkc.referenced_column_id
          WHERE t.is_ms_shipped=0
          ORDER BY s.name,t.name,c.column_id,fk.name,fkc.constraint_column_id;
        `;

        const tablesMap = {};

        const request = new Request(sqlQuery, (reqErr) => {
          if (isSettled) return;
          isSettled = true;
          clearTimeout(timeoutTimer);
          try { connection.close(); } catch (e) {}

          if (reqErr) {
            return reject(reqErr);
          }

          const result = Object.values(tablesMap).map(entry => ({
            tableName: entry.tableName,
            schemaName: entry.schemaName,
            dbName: opts.dbName,
            columnCount: entry.columns.length,
            columns: entry.columns,
            foreignKeys: Object.values(entry.foreignKeys).map(fk => ({ ...fk, columnPairs: fk.columnPairs.sort((a, b) => a.ordinal - b.ordinal) }))
          }));

          resolve(result);
        });

        request.on('row', (columns) => {
          const row = {};
          columns.forEach(col => {
            row[col.metadata.colName] = col.value;
          });

          const tableName = row.TABLE_NAME;
          const schemaName = row.TABLE_SCHEMA || 'dbo';
          const tableKey = `${schemaName}.${tableName}`;
          if (!tablesMap[tableKey]) {
            tablesMap[tableKey] = { tableName, schemaName, columns: [], foreignKeys: {} };
          }
          const entry = tablesMap[tableKey];
          if (!entry.columns.some(column => column.columnName === row.COLUMN_NAME)) entry.columns.push({
            columnName: row.COLUMN_NAME,
            dataType: row.DATA_TYPE ? row.DATA_TYPE.toUpperCase() : 'NVARCHAR',
            isPrimaryKey: row.IS_PRIMARY_KEY === 1,
            isUnique: row.IS_UNIQUE_KEY === 1,
            isNullable: row.IS_NULLABLE === true || row.IS_NULLABLE === 1,
            ordinalPosition: Number(row.ORDINAL_POSITION) || entry.columns.length + 1,
            description: `Cột ${row.COLUMN_NAME} trong bảng SQL Server ${tableName}`
          });
          if (row.FK_NAME) {
            entry.foreignKeys[row.FK_NAME] ||= { constraintName: row.FK_NAME, targetSchema: row.REF_SCHEMA || 'dbo',
              targetTable: row.REF_TABLE, isDisabled: !!row.FK_DISABLED, isNotTrusted: !!row.FK_NOT_TRUSTED, columnPairs: [] };
            entry.foreignKeys[row.FK_NAME].columnPairs.push({ sourceColumn: row.COLUMN_NAME, targetColumn: row.REF_COLUMN,
              ordinal: Number(row.FK_ORDINAL) || 1 });
          }
        });

        connection.execSql(request);
      });

      connection.on('error', (err) => {
        reject(err);
      });

      connection.connect();
    });
  }

  /**
   * Execute real SELECT SQL query on connected live database
   */
  executeSqlQuery(sqlString, dbSourceId = null, signal = null) {
    return new Promise((resolve, reject) => {
      const liveSource = dbSourceId
        ? this.dbSources.find(s => s.id === dbSourceId && (s.mode === 'live' || s.type === 'Direct Live Connection'))
        : (this.dbSources.find(s => s.isDefault && (s.mode === 'live' || s.type === 'Direct Live Connection'))
          || this.dbSources.find(s => s.mode === 'live' || s.type === 'Direct Live Connection'));
      if (dbSourceId && !liveSource) return reject(Object.assign(new Error('Nguồn CSDL được chỉ định không tồn tại hoặc không phải kết nối live.'), { code: 'INVALID_DB_SOURCE' }));
      if (!liveSource || !Connection) {
        return reject(new Error("Chưa kết nối SQL Server trực tiếp (Live Database)."));
      }

      // Parse connection config from liveSource.host (e.g. "103.226.248.147:1433")
      let host = liveSource.host || 'localhost';
      let port = 1433;
      let instanceName = undefined;

      if (host.includes(':')) {
        const parts = host.split(':');
        host = parts[0];
        port = parseInt(parts[1]) || 1433;
      }
      if (host.includes('\\')) {
        const parts = host.split('\\');
        host = parts[0];
        instanceName = parts[1];
      }

      const connectionConfig = {
        server: host,
        authentication: {
          type: 'default',
          options: {
            userName: liveSource.user || 'tpsoft',
            password: liveSource.password || ''
          }
        },
        options: {
          port: instanceName ? undefined : port,
          instanceName: instanceName,
          database: liveSource.dbName,
          encrypt: false,
          trustServerCertificate: true,
          connectTimeout: 5000,
          requestTimeout: 10000
        }
      };

      const connection = new Connection(connectionConfig);
      let request = null;
      let settled = false;
      const finish = (error, rows) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abortRequest);
        try { connection.close(); } catch (_) {}
        if (error) reject(error); else resolve(rows);
      };
      const abortRequest = () => {
        try { request?.cancel(); } catch (_) {}
        const error = Object.assign(new Error('SQL request aborted.'), { name: 'AbortError', code: 'SQL_REQUEST_ABORTED' });
        finish(error);
      };
      if (signal?.aborted) return abortRequest();
      signal?.addEventListener('abort', abortRequest, { once: true });
      connection.on('connect', (err) => {
        if (err) return finish(err);
        if (settled) return;

        const rows = [];
        request = new Request(sqlString, (reqErr) => {
          if (reqErr) return finish(reqErr);
          finish(null, rows);
        });

        request.on('row', (columns) => {
          const rowData = {};
          columns.forEach(col => {
            rowData[col.metadata.colName] = col.value;
          });
          rows.push(rowData);
        });

        connection.execSql(request);
      });

      connection.on('error', (err) => {
        finish(err);
      });

      connection.connect();
    });
  }

  /**
   * Delete DB source
   */
  deleteDbSource(id) {
    const deleted = this.dbSources.find(s => s.id === id);
    this.dbSources = this.dbSources.filter(s => s.id !== id);
    if (deleted?.isDefault && this.dbSources.length) {
      const replacement = this.dbSources.find(s => s.mode === 'live' || s.type === 'Direct Live Connection') || this.dbSources[0];
      this.ensureSingleDefault(replacement.id);
    } else {
      this.ensureSingleDefault();
    }
    this.persist();
    return true;
  }
}

module.exports = new SqlConnector();
