/**
 * ErrorRecovery — Chiến lược tự sửa lỗi (Self-Correction / Self-Healing) cho Agent
 * Giới hạn retry budget <= 2, lưu fingerprint chống lặp lại câu SQL lỗi và phân loại lỗi rõ ràng.
 */

const securityGuard = require('../../intelligent_core/security_guard');
const dictionaryService = require('../../services/dictionary_service');

class ErrorRecovery {
  constructor() {
    this.maxRetriesPerQuery = 2; // Giới hạn tối đa 2 lần retry cho mỗi lỗi SQL
  }

  /**
   * Phân tích lỗi SQL Server và tạo gợi ý sửa chữa
   * @param {string} failedSql - Câu lệnh SQL bị lỗi
   * @param {string} errorMessage - Thông báo lỗi từ SQL Server
   * @param {Set<string>} [triedFingerprints] - Tập hợp các câu SQL đã thử để chống lặp
   * @returns {{ canRecover: boolean, errorCategory: string, guidance: string, suggestedSql?: string }}
   */
  analyzeSqlError(failedSql, errorMessage = '', triedFingerprints = new Set()) {
    const err = String(errorMessage).toLowerCase();
    let errorCategory = 'UNKNOWN';
    let guidance = '';
    let suggestedSql = null;

    // 1. Lỗi sai tên cột (Invalid column name)
    if (err.includes('invalid column name')) {
      errorCategory = 'INVALID_COLUMN';
      const match = errorMessage.match(/Invalid column name '([^']+)'/i);
      const wrongCol = match ? match[1] : '';

      if (wrongCol) {
        const activeDictionary = dictionaryService.getDictionary() || [];
        const matchedCols = activeDictionary.filter(c =>
          c.columnName?.toLowerCase().includes(wrongCol.toLowerCase()) ||
          wrongCol.toLowerCase().includes(c.columnName?.toLowerCase())
        );

        if (matchedCols.length > 0) {
          const bestMatch = matchedCols[0].columnName;
          suggestedSql = failedSql.replace(new RegExp(`\\b${wrongCol}\\b`, 'g'), bestMatch);
          guidance = `Lỗi SQL: Cột '${wrongCol}' không tồn tại. Đã tìm thấy cột phù hợp '${bestMatch}' trong Data Dictionary. Hãy sử dụng cột '${bestMatch}' và sinh lại câu lệnh SELECT.`;
        } else {
          guidance = `Lỗi SQL: Cột '${wrongCol}' không tồn tại trong bảng. Hãy kiểm tra lại schema đã cung cấp hoặc dùng tool 'search_schema' để lấy đúng tên cột.`;
        }
      } else {
        guidance = `Lỗi SQL: Tên cột không hợp lệ. Hãy kiểm tra lại cấu trúc bảng trong Data Dictionary.`;
      }
    }

    // 2. Lỗi sai tên bảng hoặc View (Invalid object name)
    else if (err.includes('invalid object name')) {
      errorCategory = 'INVALID_OBJECT';
      const match = errorMessage.match(/Invalid object name '([^']+)'/i);
      const wrongTable = match ? match[1] : '';

      if (wrongTable) {
        const groupedTables = dictionaryService.getGroupedTables() || [];
        const matchedTables = groupedTables.filter(t =>
          t.tableName?.toLowerCase().includes(wrongTable.toLowerCase()) ||
          wrongTable.toLowerCase().includes(t.tableName?.toLowerCase())
        );

        if (matchedTables.length > 0) {
          const bestTable = matchedTables[0].tableName;
          suggestedSql = failedSql.replace(new RegExp(`\\b${wrongTable}\\b`, 'g'), bestTable);
          guidance = `Lỗi SQL: Bảng '${wrongTable}' không tồn tại. Đã tìm thấy bảng chuẩn '${bestTable}'. Hãy sử dụng bảng '${bestTable}' và sinh lại câu lệnh.`;
        } else {
          guidance = `Lỗi SQL: Bảng '${wrongTable}' không tồn tại trong database. Vui lòng chỉ sử dụng các bảng có trong schema catalog.`;
        }
      } else {
        guidance = `Lỗi SQL: Bảng hoặc View không hợp lệ.`;
      }
    }

    // 3. Lỗi Group By thiếu cột
    else if (err.includes('is invalid in the select list because it is not contained in either an aggregate function or the group by clause')) {
      errorCategory = 'GROUP_BY_MISSING';
      guidance = `Lỗi SQL: Mọi cột không có hàm tổng hợp (SUM, COUNT, AVG, MIN, MAX) trong SELECT bắt buộc phải có trong mệnh đề GROUP BY. Hãy bổ sung cột vào GROUP BY hoặc dùng hàm tổng hợp thích hợp.`;
    }

    // 4. Lỗi ép kiểu dữ liệu (Conversion failed / Type mismatch)
    else if (err.includes('conversion failed') || err.includes('syntax error converting')) {
      errorCategory = 'TYPE_CONVERSION';
      guidance = `Lỗi SQL: Ép kiểu dữ liệu thất bại. Hãy sử dụng hàm TRY_CAST/TRY_CONVERT hoặc định dạng ngày tháng 'YYYY-MM-DD' chuẩn để tránh lỗi runtime.`;
    }

    // 5. Lỗi cú pháp chung (Syntax error)
    else if (err.includes('incorrect syntax near')) {
      errorCategory = 'SYNTAX_ERROR';
      guidance = `Lỗi SQL: Cú pháp T-SQL gần vị trí được báo lỗi không hợp lệ. Hãy kiểm tra lại dấu ngoặc, dấu phẩy, tên bảng hoặc các từ khóa T-SQL và sửa lại.`;
    }

    else {
      errorCategory = 'UNCLASSIFIED';
      guidance = `Câu lệnh SQL gặp lỗi: "${errorMessage}". Hãy phân tích nguyên nhân, điều chỉnh câu lệnh T-SQL cho đúng chuẩn và thực thi lại.`;
    }

    // Kiểm tra fingerprint của câu gợi ý nếu có
    if (suggestedSql) {
      const cleanCheck = securityGuard.validateSqlQuery(suggestedSql);
      if (!cleanCheck.safe || triedFingerprints.has(this.getFingerprint(suggestedSql))) {
        suggestedSql = null; // Huỷ bỏ gợi ý nếu không an toàn hoặc đã từng thử mà vẫn lỗi
      }
    }

    return {
      canRecover: true,
      errorCategory,
      guidance,
      suggestedSql
    };
  }

  /**
   * Tạo fingerprint chuẩn hóa cho câu SQL để chống chạy lặp
   */
  getFingerprint(sql = '') {
    return String(sql)
      .replace(/\s+/g, ' ')
      .trim()
      .toUpperCase();
  }
}

module.exports = new ErrorRecovery();
