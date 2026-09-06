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

class SqlConnector {
  constructor() {
    this.dbSources = StorageHelper.loadJson('db_sources.json', []);
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
        id: `db-src-${Date.now()}`,
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
      instanceName = parts[1].trim();
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
      id: currentSource?.id || `db-src-${Date.now()}`,
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
    this.schemas.push(...liveTables);
    this.persist();

    return liveTables;
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
          SELECT 
            t.TABLE_NAME, 
            c.COLUMN_NAME, 
            c.DATA_TYPE, 
            c.IS_NULLABLE,
            CASE WHEN k.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS IS_PRIMARY_KEY
          FROM INFORMATION_SCHEMA.TABLES t
          INNER JOIN INFORMATION_SCHEMA.COLUMNS c 
            ON t.TABLE_NAME = c.TABLE_NAME AND t.TABLE_SCHEMA = c.TABLE_SCHEMA
          LEFT JOIN (
            SELECT ku.TABLE_SCHEMA, ku.TABLE_NAME, ku.COLUMN_NAME
            FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
            JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
              ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
            WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
          ) k ON c.TABLE_SCHEMA = k.TABLE_SCHEMA AND c.TABLE_NAME = k.TABLE_NAME AND c.COLUMN_NAME = k.COLUMN_NAME
          WHERE t.TABLE_TYPE = 'BASE TABLE'
          ORDER BY t.TABLE_NAME, c.ORDINAL_POSITION;
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

          const result = Object.keys(tablesMap).map(tableName => ({
            tableName: tableName,
            dbName: opts.dbName,
            columnCount: tablesMap[tableName].length,
            columns: tablesMap[tableName]
          }));

          resolve(result);
        });

        request.on('row', (columns) => {
          const row = {};
          columns.forEach(col => {
            row[col.metadata.colName] = col.value;
          });

          const tableName = row.TABLE_NAME;
          if (!tablesMap[tableName]) {
            tablesMap[tableName] = [];
          }

          tablesMap[tableName].push({
            columnName: row.COLUMN_NAME,
            dataType: row.DATA_TYPE ? row.DATA_TYPE.toUpperCase() : 'NVARCHAR',
            isPrimaryKey: row.IS_PRIMARY_KEY === 1,
            description: `Cột ${row.COLUMN_NAME} trong bảng SQL Server ${tableName}`
          });
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
  executeSqlQuery(sqlString, dbSourceId = null) {
    return new Promise((resolve, reject) => {
      const liveSource = (dbSourceId && this.dbSources.find(s => s.id === dbSourceId && (s.mode === 'live' || s.type === 'Direct Live Connection')))
        || this.dbSources.find(s => s.isDefault && (s.mode === 'live' || s.type === 'Direct Live Connection'))
        || this.dbSources.find(s => s.mode === 'live' || s.type === 'Direct Live Connection');
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
      connection.on('connect', (err) => {
        if (err) return reject(err);

        const rows = [];
        const request = new Request(sqlString, (reqErr) => {
          connection.close();
          if (reqErr) return reject(reqErr);
          resolve(rows);
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
        reject(err);
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
