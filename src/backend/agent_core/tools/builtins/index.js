/**
 * Built-in Tools — Đạt Parity 100% với intelligent_core/tool_registry.js
 * 
 * 1. get_current_datetime
 * 2. export_data
 * 3. execute_sql_query
 * 4. render_chart
 * 5. calculate_stats
 * 6. calculate_expression
 * 7. search_schema
 * 8. get_glossary_term
 * 9. search_knowledge_base
 */

const BaseTool = require('../base_tool');
const sqlConnector = require('../../../services/sql_connector');
const dictionaryService = require('../../../services/dictionary_service');
const libraryService = require('../../../knowledge_core/services/library_service');
const retrievalService = require('../../../knowledge_core/services/retrieval_service');
const securityGuard = require('../../../intelligent_core/security_guard');
const fs = require('fs');
const path = require('path');
const { getExportsDirectory } = require('../../../utils/export_paths');

// ─── 1. Get Current DateTime ────────────────────────────────────────────────
class GetDateTimeTool extends BaseTool {
  constructor() {
    super({
      name: 'get_current_datetime',
      description: 'Lấy ngày giờ hiện tại của hệ thống theo múi giờ Việt Nam. Dùng khi người dùng hỏi "hôm nay" (kể cả viết tắt "h nay", "hnay"), "bây giờ", "hôm nay thứ mấy", "ngày hiện tại", "tháng này", "năm nay" hoặc cần mốc thời gian hiện tại.',
      parameters: {
        type: 'object',
        properties: {
          timezone: { type: 'string', description: 'Múi giờ IANA, mặc định Asia/Ho_Chi_Minh' }
        }
      },
      timeoutMs: 5000
    });
  }

  async run(args, context = {}) {
    const tz = args?.timezone || 'Asia/Ho_Chi_Minh';
    const now = new Date();
    const parts = new Intl.DateTimeFormat('vi-VN', {
      timeZone: tz,
      weekday: 'long',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).formatToParts(now);
    const get = type => parts.find(p => p.type === type)?.value || '';
    const weekday = get('weekday');
    const day = get('day');
    const month = get('month');
    const year = get('year');
    const hour = get('hour');
    const minute = get('minute');
    const second = get('second');

    return {
      timezone: tz,
      isoUtc: now.toISOString(),
      weekday,
      day,
      month,
      year,
      time: `${hour}:${minute}:${second}`,
      date: `${year}-${month}-${day}`,
      display: `${weekday}, ngày ${day}/${month}/${year} ${hour}:${minute}:${second}`,
      note: 'Use this value as the current date/time. Do not guess.'
    };
  }
}

// ─── 2. Export Data ──────────────────────────────────────────────────────────
function getAvailableExportBase(exportDir, requestedBase, extensions, fileExists = fs.existsSync) {
  const normalizedExtensions = extensions.map(extension => extension.startsWith('.') ? extension : `.${extension}`);
  const isAvailable = candidate => normalizedExtensions.every(extension =>
    !fileExists(path.join(exportDir, `${candidate}${extension}`))
  );
  if (isAvailable(requestedBase)) return requestedBase;

  const now = new Date();
  const timestamp = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'), String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'), String(now.getSeconds()).padStart(2, '0'),
    String(now.getMilliseconds()).padStart(3, '0')].join('');
  let candidate = `${requestedBase}_${timestamp}`;
  let suffix = 2;
  while (!isAvailable(candidate)) candidate = `${requestedBase}_${timestamp}_${suffix++}`;
  return candidate;
}

class ExportDataTool extends BaseTool {
  constructor() {
    super({
      name: 'export_data',
      description: 'Xuất dữ liệu bảng hoặc kết quả truy vấn thành file định dạng Excel (XLSX), CSV hoặc PDF để người dùng tải về. CHÚ Ý: Sau khi gọi tool thành công, bạn BẮT BUỘC phải cung cấp đường dẫn tải file thực sự từ trường "downloadUrl" (có dạng /api/exports/filename.xlsx), tuyệt đối KHÔNG tự bịa ra đường dẫn "sandbox:/mnt/data/".',
      parameters: {
        type: 'object',
        properties: {
          data: { type: 'array', items: { type: 'object' }, description: 'Mảng các đối tượng dữ liệu cần xuất file (VD: kết quả rows từ execute_sql_query)' },
          format: { type: 'string', enum: ['xlsx', 'csv', 'pdf'], description: 'Định dạng file cần xuất: xlsx (Excel), csv hoặc pdf' },
          filename: { type: 'string', description: 'Tên file không kèm đuôi mở rộng (VD: "Bao_cao_Doanh_thu_Q1")' }
        },
        required: ['data', 'format']
      },
      timeoutMs: 30000
    });
  }

  async run(args) {
    const { data, format = 'csv', filename } = args;
    if (!data || !Array.isArray(data) || data.length === 0) {
      throw new Error('Không có dữ liệu để xuất file.');
    }

    const fmt = (format || 'csv').toLowerCase();
    const cleanFilename = (filename || `Export_Data_${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '_');
    const exportDir = getExportsDirectory();

    if (!fs.existsSync(exportDir)) {
      fs.mkdirSync(exportDir, { recursive: true });
    }

    const extensions = fmt === 'csv' ? ['.csv'] : (fmt === 'pdf' ? ['.html'] : ['.xlsx', '.xls']);
    const availableFilename = getAvailableExportBase(exportDir, cleanFilename, extensions);
    const keys = Object.keys(data[0] || {});
    let fullFileName = '';

    if (fmt === 'csv') {
      fullFileName = `${availableFilename}.csv`;
      const header = keys.join(',') + '\n';
      const rows = data.map(row => keys.map(k => `"${String(row[k] !== undefined ? row[k] : '').replace(/"/g, '""')}"`).join(',')).join('\n');
      const fileContent = '\uFEFF' + header + rows;
      fs.writeFileSync(path.join(exportDir, fullFileName), fileContent, 'utf8');

    } else if (fmt === 'xlsx' || fmt === 'excel') {
      const XLSX = require('xlsx');
      fullFileName = `${availableFilename}.xlsx`;
      const worksheet = XLSX.utils.json_to_sheet(data);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'DataExport');
      
      const filePath = path.join(exportDir, fullFileName);
      XLSX.writeFile(workbook, filePath);

      const xlsFilePath = path.join(exportDir, `${availableFilename}.xls`);
      XLSX.writeFile(workbook, xlsFilePath, { bookType: 'biff8' });

    } else if (fmt === 'pdf') {
      fullFileName = `${availableFilename}.html`;
      const ths = keys.map(k => `<th style="background:#4f46e5;color:#fff;padding:8px 12px;text-align:left;">${k}</th>`).join('');
      const trs = data.map(row => `<tr>${keys.map(k => `<td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${row[k] !== undefined ? row[k] : ''}</td>`).join('')}</tr>`).join('');
      const fileContent = `
        <!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"><title>${availableFilename}</title></head>
        <body style="font-family:Arial,sans-serif;padding:20px;">
          <h2 style="color:#4f46e5;">Báo cáo Xuất Dữ liệu: ${availableFilename}</h2>
          <p style="font-size:12px;color:#64748b;">Thời gian khởi tạo: ${new Date().toLocaleString('vi-VN')} | Tong so ban ghi: ${data.length}</p>
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead><tr>${ths}</tr></thead>
            <tbody>${trs}</tbody>
          </table>
          <script>window.onload = function() { window.print(); };</script>
        </body>
        </html>
      `;
      fs.writeFileSync(path.join(exportDir, fullFileName), fileContent, 'utf8');
    }

    const downloadUrl = `/api/exports/${encodeURIComponent(fullFileName)}`;
    return {
      format: fmt.toUpperCase(),
      fileName: fullFileName,
      downloadUrl,
      recordCount: data.length,
      message: `🎉 Đã xuất thành công file ${fmt.toUpperCase()} (${data.length} bản ghi). Người dùng có thể bấm tải về tại: ${downloadUrl}`
    };
  }
}

// ─── 3. Execute SQL Query ───────────────────────────────────────────────────
class ExecuteSqlTool extends BaseTool {
  constructor() {
    super({
      name: 'execute_sql_query',
      description: 'Thực thi câu lệnh SQL SELECT trên SQL Server và trả về kết quả dữ liệu thực tế. Chỉ dùng khi cần truy vấn dữ liệu từ database.',
      parameters: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'Câu lệnh SQL SELECT hợp lệ (T-SQL, SQL Server chuẩn). Chỉ SELECT, không INSERT/UPDATE/DELETE.' }
        },
        required: ['sql']
      },
      requiredPermissions: ['sql:read'],
      timeoutMs: 45000,
      isDangerous: true
    });
  }

  async run(args, context = {}) {
    const { sql } = args;
    const check = securityGuard.validateSqlQuery(sql);
    if (!check.safe) {
      throw new Error(check.error || 'Câu lệnh SQL không an toàn.');
    }

    const rawRows = await sqlConnector.executeSqlQuery(check.cleanedSql, context.dbSourceId || null, context.signal || null);
    const rows = securityGuard.sanitizeTabularRows(rawRows);
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    return {
      rows,
      columns,
      rowCount: rows.length,
      sql: check.cleanedSql
    };
  }
}

// ─── 4. Render Chart ────────────────────────────────────────────────────────
class RenderChartTool extends BaseTool {
  constructor() {
    super({
      name: 'render_chart',
      description: 'Vẽ biểu đồ trực quan từ dữ liệu. Dùng khi người dùng muốn xem biểu đồ, đồ thị, chart hoặc visualization.',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['bar', 'line', 'pie', 'doughnut', 'scatter'], description: 'Loại biểu đồ' },
          title: { type: 'string', description: 'Tiêu đề biểu đồ' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Nhãn trục X hoặc các phần' },
          datasets: {
            type: 'array',
            description: 'Mảng dataset, mỗi dataset có label và data array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                data: { type: 'array', items: { type: 'number' } }
              }
            }
          }
        },
        required: ['type', 'labels', 'datasets']
      },
      timeoutMs: 10000
    });
  }

  async run(args) {
    const { type, title, labels, datasets } = args;
    if (!type || !labels || !datasets) {
      throw new Error('Thiếu type, labels hoặc datasets.');
    }

    const PALETTE = [
      'rgba(99,102,241,0.85)', 'rgba(16,185,129,0.85)', 'rgba(245,158,11,0.85)',
      'rgba(239,68,68,0.85)', 'rgba(59,130,246,0.85)', 'rgba(168,85,247,0.85)',
      'rgba(20,184,166,0.85)', 'rgba(249,115,22,0.85)'
    ];

    const enrichedDatasets = datasets.map((ds, i) => ({
      label: ds.label || `Series ${i + 1}`,
      data: ds.data || [],
      backgroundColor: type === 'line'
        ? PALETTE[i % PALETTE.length].replace('0.85', '0.15')
        : PALETTE.slice(0, (ds.data || []).length).map((_, j) => PALETTE[(i + j) % PALETTE.length]),
      borderColor: PALETTE[i % PALETTE.length],
      borderWidth: type === 'line' ? 2.5 : 1,
      tension: 0.4,
      fill: type === 'line'
    }));

    const chartSpec = {
      type,
      data: { labels, datasets: enrichedDatasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { font: { family: 'Inter', size: 12 } } },
          title: title ? { display: true, text: title, font: { family: 'Inter', size: 14, weight: '700' } } : { display: false }
        },
        scales: ['pie', 'doughnut'].includes(type) ? {} : {
          x: { grid: { display: false } },
          y: { grid: { color: '#f1f5f9' } }
        }
      }
    };

    return {
      chartSpec,
      title: title || 'Biểu đồ'
    };
  }
}

// ─── 5. Calculate Stats ─────────────────────────────────────────────────────
class CalculateStatsTool extends BaseTool {
  constructor() {
    super({
      name: 'calculate_stats',
      description: 'Tính toán thống kê: min, max, avg (trung bình), sum (tổng), count (đếm) từ mảng số liệu.',
      parameters: {
        type: 'object',
        properties: {
          data: { type: 'array', items: { type: 'number' }, description: 'Mảng các số cần tính toán' },
          operation: { type: 'string', enum: ['min', 'max', 'avg', 'sum', 'count', 'all'], description: 'Phép tính. "all" tính tất cả cùng lúc.' }
        },
        required: ['data', 'operation']
      },
      timeoutMs: 10000
    });
  }

  async run(args) {
    const { data, operation } = args;
    if (!data || !Array.isArray(data) || data.length === 0) {
      throw new Error('Mảng dữ liệu rỗng hoặc không hợp lệ.');
    }

    const nums = data.map(Number).filter(n => !isNaN(n));
    if (nums.length === 0) throw new Error('Không có số hợp lệ trong mảng.');

    const sorted = [...nums].sort((a, b) => a - b);
    const sum = nums.reduce((acc, n) => acc + n, 0);
    const avg = sum / nums.length;
    const median = nums.length % 2 === 0
      ? (sorted[nums.length / 2 - 1] + sorted[nums.length / 2]) / 2
      : sorted[Math.floor(nums.length / 2)];

    const all = {
      min: sorted[0],
      max: sorted[sorted.length - 1],
      sum: Math.round(sum * 1000) / 1000,
      avg: Math.round(avg * 1000) / 1000,
      count: nums.length,
      median: Math.round(median * 1000) / 1000
    };

    let result;
    switch (operation) {
      case 'min': result = { min: all.min }; break;
      case 'max': result = { max: all.max }; break;
      case 'sum': result = { sum: all.sum }; break;
      case 'avg': result = { avg: all.avg }; break;
      case 'count': result = { count: all.count }; break;
      default: result = all;
    }

    return result;
  }
}

// ─── 6. Calculate Expression ────────────────────────────────────────────────
class CalculateExpressionTool extends BaseTool {
  constructor() {
    super({
      name: 'calculate_expression',
      description: 'Tính toán biểu thức số học. Hỗ trợ +, -, *, /, %, **, Math.sqrt, Math.abs, Math.round, Math.floor, Math.ceil.',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'Biểu thức toán học (VD: "100 * 1.1", "(200 + 300) / 2", "Math.sqrt(144)")' }
        },
        required: ['expression']
      },
      timeoutMs: 5000
    });
  }

  async run(args) {
    const { expression } = args;
    const check = securityGuard.validateExpression(expression);
    if (!check.safe) {
      throw new Error(check.error || 'Biểu thức không an toàn.');
    }

    const result = Function('"use strict"; const Math = globalThis.Math; return (' + expression + ')')();
    if (typeof result !== 'number' || !isFinite(result)) {
      throw new Error('Kết quả không phải số hữu hạn.');
    }
    return {
      expression,
      value: Math.round(result * 1000000) / 1000000
    };
  }
}

// ─── 7. Search Schema ───────────────────────────────────────────────────────
class SearchSchemaTool extends BaseTool {
  constructor() {
    super({
      name: 'search_schema',
      description: 'Tìm kiếm bảng và cột trong Data Dictionary (schema SQL Server đã nạp vào hệ thống).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Từ khóa tìm kiếm tên bảng hoặc cột' }
        },
        required: ['query']
      },
      timeoutMs: 10000
    });
  }

  async run(args) {
    const { query } = args;
    if (!query) throw new Error('Thiếu từ khóa tìm kiếm.');
    const q = query.toLowerCase();
    const allTables = dictionaryService.getGroupedTables();

    const matched = allTables.filter(t =>
      t.tableName.toLowerCase().includes(q) ||
      (t.tableDescription || '').toLowerCase().includes(q) ||
      t.columns.some(c =>
        c.columnName.toLowerCase().includes(q) ||
        (c.description || '').toLowerCase().includes(q)
      )
    );

    return {
      query,
      totalMatched: matched.length,
      tables: matched.map(t => ({
        tableName: t.tableName,
        dbName: t.dbName,
        isActive: t.isActive,
        columnCount: t.columns.length,
        columns: t.tableName.toLowerCase() === q || t.tableName.toLowerCase().includes(q)
          ? t.columns.map(c => ({ name: c.columnName, type: c.dataType, isPK: c.isPrimaryKey }))
          : undefined,
        matchedColumns: t.columns
          .filter(c => c.columnName.toLowerCase().includes(q))
          .map(c => ({ name: c.columnName, type: c.dataType, isPK: c.isPrimaryKey }))
      }))
    };
  }
}

// ─── 8. Get Glossary Term ───────────────────────────────────────────────────
class GetGlossaryTermTool extends BaseTool {
  constructor() {
    super({
      name: 'get_glossary_term',
      description: 'Tra cứu thuật ngữ nghiệp vụ trong Business Glossary (VD: NV = Nhân viên, HD = Hóa đơn).',
      parameters: {
        type: 'object',
        properties: {
          term: { type: 'string', description: 'Thuật ngữ cần tra cứu' }
        },
        required: ['term']
      },
      timeoutMs: 5000
    });
  }

  async run(args) {
    const { term } = args;
    if (!term) throw new Error('Thiếu thuật ngữ.');
    const glossary = dictionaryService.getGlossary();
    const found = glossary.find(g => g.term.toLowerCase() === term.toLowerCase());

    if (found) {
      return {
        term: found.term,
        meaning: found.fullMeaning,
        category: found.category
      };
    }

    const partials = glossary.filter(g =>
      g.term.toLowerCase().includes(term.toLowerCase()) ||
      g.fullMeaning.toLowerCase().includes(term.toLowerCase())
    );
    return {
      term,
      found: false,
      suggestions: partials.slice(0, 5)
    };
  }
}

// ─── 9. Search Knowledge Base ───────────────────────────────────────────────
class SearchKnowledgeTool extends BaseTool {
  constructor() {
    super({
      name: 'search_knowledge_base',
      description: 'Tìm kiếm tri thức Semantic Vector Search trong Qdrant Vector DB (Tài liệu, PDF, quy trình, mô tả dữ liệu bóc tách).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Câu hỏi hoặc từ khóa ngữ nghĩa cần tìm kiếm trong Vector DB' },
          limit: { type: 'number', description: 'Số lượng kết quả liên quan nhất (mặc định 5)' }
        },
        required: ['query']
      },
      timeoutMs: 30000
    });
  }

  async run(args) {
    const { query, limit = 5 } = args;
    if (!query) throw new Error('Thiếu từ khóa/câu hỏi tra cứu Vector DB.');
    
    const safeLimit = Math.max(1, Math.min(10, Number(limit) || 5));
    const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const queryText = normalize(query);
    const directMatches = libraryService.getDocuments()
      .filter(item => queryText.includes(normalize(item.title)) || normalize(item.title).includes(queryText))
      .slice(0, safeLimit)
      .map(item => {
        const content = libraryService.getContent(item.id).content;
        return { score: 1, payload: { fullText: content.slice(0, 12000), title: item.title, documentId: item.id, chunkIndex: 0 } };
      });
    const retrieval = await retrievalService.search(query, { limit: safeLimit });
    const vectorResults = retrieval.results || [];
    const seen = new Set(directMatches.map(item => item.payload.documentId));
    const results = [...directMatches, ...vectorResults.filter(item => !seen.has(item.payload?.documentId))].slice(0, safeLimit);

    return {
      query,
      totalResults: results.length,
      documents: results.map(r => ({
        score: Math.round((r.score || 0) * 100) / 100,
        text: r.payload?.fullText || r.payload?.text || r.payload?.content || '',
        source: r.payload?.title || r.payload?.source || 'Knowledge Base',
        documentId: r.payload?.documentId || null,
        chunkIndex: Number(r.payload?.chunkIndex || 0)
      }))
    };
  }
}

module.exports = {
  GetDateTimeTool,
  ExportDataTool,
  ExecuteSqlTool,
  RenderChartTool,
  CalculateStatsTool,
  CalculateExpressionTool,
  SearchSchemaTool,
  GetGlossaryTermTool,
  SearchKnowledgeTool,
  getAvailableExportBase
};
