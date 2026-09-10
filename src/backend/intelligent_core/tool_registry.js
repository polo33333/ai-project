/**
 * Tool Registry — Intelligent Core
 * Định nghĩa, đăng ký và thực thi 7 Enterprise Tools theo chuẩn OpenAI Function Calling / Gemini Tool Use.
 * Tools: execute_sql_query, render_chart, calculate_stats, calculate_expression, search_schema, get_glossary_term, search_knowledge_base
 */

const sqlConnector = require('../services/sql_connector');
const dictionaryService = require('../services/dictionary_service');
const qdrantService = require('../services/qdrant_service');
const libraryService = require('../knowledge_core/services/library_service');
const retrievalService = require('../knowledge_core/services/retrieval_service');
const securityGuard = require('./security_guard');
const fs = require('fs');
const path = require('path');
const { getExportsDirectory } = require('../utils/export_paths');

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

const TOOL_DEFINITIONS = [
  {
    name: 'get_current_datetime',
    description: 'Lấy ngày giờ hiện tại của hệ thống theo múi giờ Việt Nam. Dùng khi người dùng hỏi "hôm nay" (kể cả viết tắt "h nay", "hnay"), "bây giờ", "hôm nay thứ mấy", "ngày hiện tại", "tháng này", "năm nay" hoặc cần mốc thời gian hiện tại.',
    parameters: {
      type: 'object',
      properties: {
        timezone: { type: 'string', description: 'Múi giờ IANA, mặc định Asia/Ho_Chi_Minh' }
      }
    }
  },
  {
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
    }
  },
  // {
  //   name: 'resolve_date_range',
  //   description: 'Chuyển đổi biểu thức thời gian tự nhiên (như "quý trước", "tháng này", "30 ngày gần đây", "hôm qua", "năm ngoái") thành mốc ngày bắt đầu/kết thúc cụ thể (YYYY-MM-DD) và câu lệnh SQL WHERE condition chuẩn.',
  //   parameters: {
  //     type: 'object',
  //     properties: {
  //       time_expression: { type: 'string', description: 'Cụm từ thời gian tiếng Việt (VD: "quý trước", "tháng này", "10 tháng gần nhất", "tuần này", "năm ngoái")' },
  //       date_column_name: { type: 'string', description: 'Tên cột ngày tháng trong bảng SQL (VD: "ElectricityOutputDate", "CreatedDate")' },
  //       table_name: { type: 'string', description: 'Tên bảng SQL chứa dữ liệu (VD: "T_ElectricityOutput"). Dùng để tự động quét mốc ngày MAX thực tế trong DB.' }
  //     },
  //     required: ['time_expression']
  //   }
  // },
  // {
  //   name: 'validate_sql',
  //   description: 'Kiểm tra cú pháp T-SQL, đảm bảo an toàn Read-Only (SELECT/WITH) và định dạng câu lệnh SQL trước khi chạy. Không thực thi câu lệnh.',
  //   parameters: {
  //     type: 'object',
  //     properties: {
  //       sql: { type: 'string', description: 'Câu lệnh SQL cần kiểm tra' }
  //     },
  //     required: ['sql']
  //   }
  // },
  // {
  //   name: 'repair_sql',
  //   description: 'Tự động sửa câu lệnh SQL bị lỗi (VD: Invalid column name, Invalid object name) bằng cách phân tích lỗi SQL Server và tìm cột/bảng đúng trong Data Dictionary.',
  //   parameters: {
  //     type: 'object',
  //     properties: {
  //       sql: { type: 'string', description: 'Câu lệnh SQL đang bị lỗi' },
  //       error: { type: 'string', description: 'Thông báo lỗi trả về từ SQL Server' }
  //     },
  //     required: ['sql', 'error']
  //   }
  // },
  {
    name: 'execute_sql_query',
    description: 'Thực thi câu lệnh SQL SELECT trên SQL Server và trả về kết quả dữ liệu thực tế. Chỉ dùng khi cần truy vấn dữ liệu từ database.',
    parameters: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'Câu lệnh SQL SELECT hợp lệ (T-SQL, SQL Server chuẩn). Chỉ SELECT, không INSERT/UPDATE/DELETE.' }
      },
      required: ['sql']
    }
  },
  {
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
    }
  },
  {
    name: 'calculate_stats',
    description: 'Tính toán thống kê: min, max, avg (trung bình), sum (tổng), count (đếm) từ mảng số liệu.',
    parameters: {
      type: 'object',
      properties: {
        data: { type: 'array', items: { type: 'number' }, description: 'Mảng các số cần tính toán' },
        operation: { type: 'string', enum: ['min', 'max', 'avg', 'sum', 'count', 'all'], description: 'Phép tính. "all" tính tất cả cùng lúc.' }
      },
      required: ['data', 'operation']
    }
  },
  {
    name: 'calculate_expression',
    description: 'Tính toán biểu thức số học. Hỗ trợ +, -, *, /, %, **, Math.sqrt, Math.abs, Math.round, Math.floor, Math.ceil.',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'Biểu thức toán học (VD: "100 * 1.1", "(200 + 300) / 2", "Math.sqrt(144)")' }
      },
      required: ['expression']
    }
  },
  {
    name: 'search_schema',
    description: 'Tìm kiếm bảng và cột trong Data Dictionary (schema SQL Server đã nạp vào hệ thống).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Từ khóa tìm kiếm tên bảng hoặc cột' }
      },
      required: ['query']
    }
  },
  {
    name: 'get_glossary_term',
    description: 'Tra cứu thuật ngữ nghiệp vụ trong Business Glossary (VD: NV = Nhân viên, HD = Hóa đơn).',
    parameters: {
      type: 'object',
      properties: {
        term: { type: 'string', description: 'Thuật ngữ cần tra cứu' }
      },
      required: ['term']
    }
  },
  {
    name: 'search_knowledge_base',
    description: 'Tìm kiếm tri thức Semantic Vector Search trong Qdrant Vector DB (Tài liệu, PDF, quy trình, mô tả dữ liệu bóc tách).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Câu hỏi hoặc từ khóa ngữ nghĩa cần tìm kiếm trong Vector DB' },
        limit: { type: 'number', description: 'Số lượng kết quả liên quan nhất (mặc định 5)' }
      },
      required: ['query']
    }
  }
];

// ============================================================================
// TOOL EXECUTOR
// ============================================================================

class ToolRegistry {
  listTools(toolNames = null) {
    if (!Array.isArray(toolNames)) return TOOL_DEFINITIONS;
    const allowed = new Set(toolNames);
    return TOOL_DEFINITIONS.filter(tool => allowed.has(tool.name));
  }

  getOpenAiToolsFormat(toolNames = null) {
    return this.listTools(toolNames).map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters }
    }));
  }

  getGeminiToolsFormat(toolNames = null) {
    return [{
      functionDeclarations: this.listTools(toolNames).map(t => ({
        name: t.name, description: t.description, parameters: t.parameters
      }))
    }];
  }

  async executeTool(toolName, args) {
    try {
      switch (toolName) {
        case 'get_current_datetime': return this._getCurrentDateTime(args);
        case 'export_data': return await this._exportData(args);
        // case 'resolve_date_range':     return await this._resolveDateRange(args);
        case 'validate_sql': return this._validateSql(args);
        case 'repair_sql': return this._repairSql(args);
        case 'execute_sql_query': return await this._executeSqlQuery(args);
        case 'render_chart': return this._renderChart(args);
        case 'calculate_stats': return this._calculateStats(args);
        case 'calculate_expression': return this._calculateExpression(args);
        case 'search_schema': return this._searchSchema(args);
        case 'get_glossary_term': return this._getGlossaryTerm(args);
        case 'search_knowledge_base': return await this._searchKnowledgeBase(args);
        default: return { success: false, error: `Tool "${toolName}" không tồn tại.` };
      }
    } catch (err) {
      return { success: false, error: `Lỗi thực thi tool "${toolName}": ${err.message}` };
    }
  }

  // ─── Tool Implementations ────────────────────────────────────────────────

  _getCurrentDateTime({ timezone = 'Asia/Ho_Chi_Minh' } = {}) {
    const tz = timezone || 'Asia/Ho_Chi_Minh';
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
      success: true,
      result: {
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
      }
    };
  }

  async _exportData({ data, format = 'csv', filename }) {
    if (!data || !Array.isArray(data) || data.length === 0) {
      return { success: false, error: 'Không có dữ liệu để xuất file.' };
    }

    const fmt = (format || 'csv').toLowerCase();
    const cleanFilename = (filename || `Export_Data_${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '_');
    const exportDir = getExportsDirectory();

    if (!fs.existsSync(exportDir)) {
      fs.mkdirSync(exportDir, { recursive: true });
    }

    const keys = Object.keys(data[0] || {});
    let fullFileName = '';
    let fileContent = '';

    if (fmt === 'csv') {
      fullFileName = `${cleanFilename}.csv`;
      const header = keys.join(',') + '\n';
      const rows = data.map(row => keys.map(k => `"${String(row[k] !== undefined ? row[k] : '').replace(/"/g, '""')}"`).join(',')).join('\n');
      fileContent = '\uFEFF' + header + rows; // UTF-8 BOM cho Excel Việt Nam
      fs.writeFileSync(path.join(exportDir, fullFileName), fileContent, 'utf8');

    } else if (fmt === 'xlsx' || fmt === 'excel') {
      const XLSX = require('xlsx');
      fullFileName = `${cleanFilename}.xlsx`;
      const worksheet = XLSX.utils.json_to_sheet(data);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'DataExport');
      
      const filePath = path.join(exportDir, fullFileName);
      XLSX.writeFile(workbook, filePath);

      // Tạo thêm bản sao .xls phụ để đảm bảo cả 2 đuôi file đều tồn tại 100%
      const xlsFilePath = path.join(exportDir, `${cleanFilename}.xls`);
      XLSX.writeFile(workbook, xlsFilePath, { bookType: 'biff8' });

    } else if (fmt === 'pdf') {
      fullFileName = `${cleanFilename}.html`;
      const ths = keys.map(k => `<th style="background:#4f46e5;color:#fff;padding:8px 12px;text-align:left;">${k}</th>`).join('');
      const trs = data.map(row => `<tr>${keys.map(k => `<td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${row[k] !== undefined ? row[k] : ''}</td>`).join('')}</tr>`).join('');
      fileContent = `
        <!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"><title>${cleanFilename}</title></head>
        <body style="font-family:Arial,sans-serif;padding:20px;">
          <h2 style="color:#4f46e5;">Báo cáo Xuất Dữ liệu: ${cleanFilename}</h2>
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
      success: true,
      format: fmt.toUpperCase(),
      fileName: fullFileName,
      downloadUrl,
      recordCount: data.length,
      message: `🎉 Đã xuất thành công file ${fmt.toUpperCase()} (${data.length} bản ghi). Người dùng có thể bấm tải về tại: ${downloadUrl}`
    };
  }

  async _resolveDateRange({ time_expression, date_column_name = 'CreatedDate', table_name = null }) {
    if (!time_expression) return { success: false, error: 'Thiếu cụm từ thời gian.' };

    const expr = time_expression.trim().toLowerCase();
    let anchorDate = new Date(); // Mặc định ngày hệ thống

    // Tự động quét mốc ngày MAX thực tế trong database nếu có tên bảng
    if (table_name && date_column_name) {
      try {
        const checkSql = `SELECT MAX(${date_column_name}) AS MaxDate FROM ${table_name}`;
        const maxRes = await sqlConnector.executeSqlQuery(checkSql);
        if (maxRes && maxRes.length > 0 && maxRes[0].MaxDate) {
          const maxD = new Date(maxRes[0].MaxDate);
          if (!isNaN(maxD.getTime())) {
            anchorDate = maxD; // Dùng ngày mới nhất thực tế trong DB làm mốc!
          }
        }
      } catch (_) { }
    }

    const currentYear = anchorDate.getFullYear();
    const currentMonth = anchorDate.getMonth(); // 0 - 11
    const currentDate = anchorDate.getDate();

    let startDate = new Date(anchorDate);
    let endDate = new Date(anchorDate);
    let description = '';

    const formatDate = (d) => d.toISOString().slice(0, 10);

    // 1. Quý (Quý 1, Quý 2, Quý 3, Quý 4, Quý trước, Quý này)
    if (expr.includes('quý trước') || expr.includes('quy truoc')) {
      const currentQuarter = Math.floor(currentMonth / 3) + 1;
      let q = currentQuarter - 1;
      let y = currentYear;
      if (q === 0) { q = 4; y -= 1; }
      startDate = new Date(y, (q - 1) * 3, 1);
      endDate = new Date(y, q * 3, 0); // Ngày cuối của quý
      description = `Quý ${q} năm ${y}`;

    } else if (expr.includes('quý này') || expr.includes('quy nay') || expr.includes('quý hiện tại')) {
      const currentQuarter = Math.floor(currentMonth / 3) + 1;
      startDate = new Date(currentYear, (currentQuarter - 1) * 3, 1);
      endDate = new Date(currentYear, currentQuarter * 3, 0);
      description = `Quý ${currentQuarter} năm ${currentYear}`;

    } else if (/quý\s*([1-4])/i.test(expr)) {
      const q = parseInt(expr.match(/quý\s*([1-4])/i)[1], 10);
      let y = currentYear;
      if (expr.includes('năm ngoái') || expr.includes('nam ngoai')) y -= 1;
      startDate = new Date(y, (q - 1) * 3, 1);
      endDate = new Date(y, q * 3, 0);
      description = `Quý ${q} năm ${y}`;

      // 2. Tháng (Tháng này, Tháng trước, N tháng gần đây / N tháng gần nhất)
    } else if (/(\d+)\s*tháng\s*(gần\s*nhất|gần\s*đây|vừa\s*qua|gần\s*đó)/i.test(expr) || /(\d+)\s*thang\s*(gan\s*nhat|gan\s*day)/i.test(expr)) {
      const months = parseInt(expr.match(/(\d+)\s*th/i)[1], 10);
      startDate = new Date(currentYear, currentMonth - months + 1, 1);
      endDate = new Date(currentYear, currentMonth + 1, 0);
      description = `${months} tháng gần nhất (Từ ${formatDate(startDate)} đến ${formatDate(endDate)})`;

    } else if (expr.includes('tháng này') || expr.includes('thang nay') || expr.includes('tháng hiện tại')) {
      startDate = new Date(currentYear, currentMonth, 1);
      endDate = new Date(currentYear, currentMonth + 1, 0);
      description = `Tháng ${currentMonth + 1} năm ${currentYear}`;

    } else if (expr.includes('tháng trước') || expr.includes('thang truoc')) {
      startDate = new Date(currentYear, currentMonth - 1, 1);
      endDate = new Date(currentYear, currentMonth, 0);
      description = `Tháng ${startDate.getMonth() + 1} năm ${startDate.getFullYear()}`;

    } else if (/(\d+)\s*ngày\s*gần\s*đây/i.test(expr) || /(\d+)\s*ngay\s*gan\s*day/i.test(expr)) {
      const days = parseInt(expr.match(/(\d+)\s*ng/i)[1], 10);
      startDate = new Date(now);
      startDate.setDate(currentDate - days);
      endDate = new Date(now);
      description = `${days} ngày gần đây (Từ ${formatDate(startDate)} đến ${formatDate(endDate)})`;

      // 3. Hôm nay, Hôm qua, Tuần này, Tuần trước
    } else if (expr.includes('hôm nay') || expr.includes('hom nay')) {
      startDate = new Date(now);
      endDate = new Date(now);
      description = `Hôm nay (${formatDate(now)})`;

    } else if (expr.includes('hôm qua') || expr.includes('hom qua')) {
      startDate = new Date(now);
      startDate.setDate(currentDate - 1);
      endDate = new Date(startDate);
      description = `Hôm qua (${formatDate(startDate)})`;

    } else if (expr.includes('tuần này') || expr.includes('tuan nay')) {
      const dayOfWeek = now.getDay() || 7; // 1 (Thứ 2) -> 7 (CN)
      startDate = new Date(now);
      startDate.setDate(currentDate - dayOfWeek + 1);
      endDate = new Date(now);
      description = `Tuần này`;

      // 4. Năm nay, Năm ngoái
    } else if (expr.includes('năm ngoái') || expr.includes('nam ngoai')) {
      startDate = new Date(currentYear - 1, 0, 1);
      endDate = new Date(currentYear - 1, 11, 31);
      description = `Năm ${currentYear - 1}`;

    } else {
      // Mặc định lùi 30 ngày gần đây
      startDate = new Date(now);
      startDate.setDate(currentDate - 30);
      endDate = new Date(now);
      description = `30 ngày gần đây (Default)`;
    }

    const startStr = formatDate(startDate);
    const endStr = formatDate(endDate);

    // T-SQL Condition formatted
    const sqlCondition = `${date_column_name} BETWEEN '${startStr} 00:00:00' AND '${endStr} 23:59:59'`;

    return {
      success: true,
      timeExpression: time_expression,
      description,
      startDate: startStr,
      endDate: endStr,
      formattedSqlCondition: sqlCondition,
      exampleUsageInWhere: `WHERE ${sqlCondition}`
    };
  }

  _validateSql({ sql }) {
    if (!sql) return { success: false, error: 'Thiếu câu lệnh SQL cần kiểm tra.' };
    const check = securityGuard.validateSqlQuery(sql);
    if (!check.safe) {
      return { success: false, isValid: false, error: check.error };
    }
    return {
      success: true,
      isValid: true,
      cleanedSql: check.cleanedSql,
      message: 'Câu lệnh SQL hợp lệ, đảm bảo chuẩn Read-Only SELECT/WITH và an toàn bảo mật.'
    };
  }

  _repairSql({ sql, error }) {
    if (!sql || !error) return { success: false, error: 'Thiếu câu lệnh SQL hoặc thông báo lỗi.' };

    const errStr = String(error);
    const activeDictionary = dictionaryService.getDictionary();
    let suggestions = [];
    let repairedSql = sql;

    // Trường hợp lỗi Invalid column name 'XYZ'
    const colMatch = errStr.match(/Invalid column name '([^']+)'/i);
    if (colMatch) {
      const wrongCol = colMatch[1];
      // Tìm cột có tên tương tự trong Data Dictionary
      const matchedCols = activeDictionary.filter(c =>
        c.columnName.toLowerCase().includes(wrongCol.toLowerCase()) ||
        wrongCol.toLowerCase().includes(c.columnName.toLowerCase())
      );

      if (matchedCols.length > 0) {
        const bestMatch = matchedCols[0].columnName;
        repairedSql = sql.replace(new RegExp(`\\b${wrongCol}\\b`, 'g'), bestMatch);
        suggestions.push(`Đã phát hiện cột sai '${wrongCol}', thay thế bằng cột đúng '${bestMatch}' dựa trên Data Dictionary.`);
      }
    }

    // Trường hợp lỗi Invalid object name 'ABC' (Sai tên bảng)
    const tableMatch = errStr.match(/Invalid object name '([^']+)'/i);
    if (tableMatch) {
      const wrongTable = tableMatch[1];
      const groupedTables = dictionaryService.getGroupedTables();
      const matchedTables = groupedTables.filter(t =>
        t.tableName.toLowerCase().includes(wrongTable.toLowerCase()) ||
        wrongTable.toLowerCase().includes(t.tableName.toLowerCase())
      );

      if (matchedTables.length > 0) {
        const bestTable = matchedTables[0].tableName;
        repairedSql = sql.replace(new RegExp(`\\b${wrongTable}\\b`, 'g'), bestTable);
        suggestions.push(`Đã phát hiện tên bảng sai '${wrongTable}', thay thế bằng bảng đúng '${bestTable}' dựa trên Data Dictionary.`);
      }
    }

    // Re-validate repaired SQL
    const check = securityGuard.validateSqlQuery(repairedSql);

    return {
      success: true,
      originalSql: sql,
      repairedSql: check.cleanedSql || repairedSql,
      suggestions: suggestions.length > 0 ? suggestions : ['Hãy kiểm tra lại danh sách tên bảng và cột trong Data Dictionary.'],
      isValidNow: check.safe
    };
  }

  async _executeSqlQuery({ sql }) {
    const check = securityGuard.validateSqlQuery(sql);
    if (!check.safe) {
      return { success: false, error: check.error };
    }

    try {
      const rows = await sqlConnector.executeSqlQuery(check.cleanedSql);
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      return { success: true, result: { rows, columns, rowCount: rows.length, sql: check.cleanedSql } };
    } catch (err) {
      // Tự động phân tích lỗi SQL Server và đề xuất câu lệnh đã sửa cho Agent Retry Loop ⭐⭐⭐⭐
      const repairInfo = this._repairSql({ sql: check.cleanedSql, error: err.message });
      return {
        success: false,
        error: `Lỗi SQL Server: ${err.message}`,
        autoRepairSuggestion: repairInfo.repairedSql !== check.cleanedSql ? repairInfo.repairedSql : null,
        hint: repairInfo.suggestions.join(' | ') || 'Hãy dùng tool "search_schema" hoặc "repair_sql" để kiểm tra lại tên bảng và cột đúng.'
      };
    }
  }

  _renderChart({ type, title, labels, datasets }) {
    if (!type || !labels || !datasets) {
      return { success: false, error: 'Thiếu type, labels hoặc datasets.' };
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

    return { success: true, result: { chartSpec, title: title || 'Biểu đồ' } };
  }

  _calculateStats({ data, operation }) {
    if (!data || !Array.isArray(data) || data.length === 0) {
      return { success: false, error: 'Mảng dữ liệu rỗng hoặc không hợp lệ.' };
    }

    const nums = data.map(Number).filter(n => !isNaN(n));
    if (nums.length === 0) return { success: false, error: 'Không có số hợp lệ trong mảng.' };

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

    return { success: true, result };
  }

  _calculateExpression({ expression }) {
    const check = securityGuard.validateExpression(expression);
    if (!check.safe) {
      return { success: false, error: check.error };
    }

    try {
      const result = Function('"use strict"; const Math = globalThis.Math; return (' + expression + ')')();
      if (typeof result !== 'number' || !isFinite(result)) {
        return { success: false, error: 'Kết quả không phải số hữu hạn.' };
      }
      return { success: true, result: { expression, value: Math.round(result * 1000000) / 1000000 } };
    } catch (err) {
      return { success: false, error: `Biểu thức không hợp lệ: ${err.message}` };
    }
  }

  _searchSchema({ query }) {
    if (!query) return { success: false, error: 'Thiếu từ khóa tìm kiếm.' };
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
      success: true,
      result: {
        query, totalMatched: matched.length,
        tables: matched.map(t => ({
          tableName: t.tableName, dbName: t.dbName, isActive: t.isActive,
          columnCount: t.columns.length,
          matchedColumns: t.columns
            .filter(c => c.columnName.toLowerCase().includes(q))
            .map(c => ({ name: c.columnName, type: c.dataType, isPK: c.isPrimaryKey }))
        }))
      }
    };
  }

  _getGlossaryTerm({ term }) {
    if (!term) return { success: false, error: 'Thiếu thuật ngữ.' };
    const glossary = dictionaryService.getGlossary();
    const found = glossary.find(g => g.term.toLowerCase() === term.toLowerCase());

    if (found) {
      return { success: true, result: { term: found.term, meaning: found.fullMeaning, category: found.category } };
    }

    const partials = glossary.filter(g =>
      g.term.toLowerCase().includes(term.toLowerCase()) ||
      g.fullMeaning.toLowerCase().includes(term.toLowerCase())
    );
    return { success: true, result: { term, found: false, suggestions: partials.slice(0, 5) } };
  }

  async _searchKnowledgeBase({ query, limit = 5 }) {
    if (!query) return { success: false, error: 'Thiếu từ khóa/câu hỏi tra cứu Vector DB.' };
    try {
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
      const vectorResults = retrieval.results;
      const seen = new Set(directMatches.map(item => item.payload.documentId));
      const results = [...directMatches, ...vectorResults.filter(item => !seen.has(item.payload?.documentId))].slice(0, safeLimit);
      return {
        success: true,
        result: {
          query,
          totalResults: results.length,
          documents: results.map(r => ({
            score: Math.round((r.score || 0) * 100) / 100,
            text: r.payload?.fullText || r.payload?.text || r.payload?.content || '',
            source: r.payload?.title || r.payload?.source || 'Knowledge Base',
            documentId: r.payload?.documentId || null,
            chunkIndex: Number(r.payload?.chunkIndex || 0)
          }))
        }
      };
    } catch (err) {
      return { success: false, error: `Lỗi tra cứu Vector DB: ${err.message}` };
    }
  }
}

module.exports = new ToolRegistry();
