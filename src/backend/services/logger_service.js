/**
 * System Logger & AI Audit History Service
 * Stores system error logs, SQL Connector logs, and AI Chat & Text-to-SQL execution logs
 */

const StorageHelper = require('../utils/storage_helper');

class LoggerService {
  constructor() {
    const nowStr = new Date().toLocaleString('vi-VN');
    const past1 = new Date(Date.now() - 60000).toLocaleString('vi-VN');
    const past2 = new Date(Date.now() - 120000).toLocaleString('vi-VN');
    const past3 = new Date(Date.now() - 300000).toLocaleString('vi-VN');

    const defaultLogs = [
      //   {
      //     id: `log-${Date.now()}-1`,
      //     timestamp: nowStr,
      //     level: "INFO",
      //     module: "System",
      //     message: "Hệ thống KnowledgeHub AI Engine khởi chạy hoàn tất trên Cổng 3000.",
      //     details: null
      //   },
      //   {
      //     id: `log-${Date.now()}-2`,
      //     timestamp: past1,
      //     level: "SUCCESS",
      //     module: "Qdrant Vector DB",
      //     message: "Kết nối thành công Qdrant Vector Database (http://127.0.0.1:6333). Đã sẵn sàng nhúng BGE-M3 Schema Embeddings.",
      //     details: null
      //   },
      //   {
      //     id: `log-${Date.now()}-3`,
      //     timestamp: past2,
      //     level: "INFO",
      //     module: "AI Router",
      //     message: "Đã kích hoạt AI Provider mặc định: Ollama Local (Model: qwen2.5-coder).",
      //     details: null
      //   },
      //   {
      //     id: `log-${Date.now()}-4`,
      //     timestamp: past3,
      //     level: "WARN",
      //     module: "SQL Connector",
      //     message: "Kết nối SQL Server từ xa thử nghiệm (TCP 1433 / Named Instance SQLEXPRESS).",
      //     details: "Host: 103.226.248.147, Port: 1433, Driver: Tedious v16.7.0"
      //   }
      // ];

      // const defaultChatHistory = [
      //   {
      //     id: `chat-${Date.now()}-1`,
      //     timestamp: past1,
      //     question: "Liệt kê danh sách các bảng dữ liệu có trong hệ thống",
      //     replyText: "Dưới đây là danh sách các Bảng dữ liệu hiện tại trong Data Dictionary đã được kích hoạt:",
      //     sqlQuery: "SELECT TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE';",
      //     providerName: "Ollama Local",
      //     modelName: "qwen2.5-coder",
      //     latencyMs: 145,
      //     status: "SUCCESS",
      //     errorReason: null
      //   },
      //   {
      //     id: `chat-${Date.now()}-2`,
      //     timestamp: past2,
      //     question: "Cho tôi xem 5 hợp đồng mới nhất",
      //     replyText: "Tôi đã sinh câu lệnh SQL an toàn (SELECT ONLY) để lấy 5 hợp đồng mới nhất:",
      //     sqlQuery: "SELECT TOP 5 ContractID, CustomerID, TotalValue, CreatedDate FROM Contracts ORDER BY CreatedDate DESC;",
      //     providerName: "Ollama Local",
      //     modelName: "qwen2.5-coder",
      //     latencyMs: 182,
      //     status: "SUCCESS",
      //     errorReason: null
      //   }
    ];

    this.systemLogs = StorageHelper.loadJson('logs.json', defaultLogs);
    this.chatHistory = StorageHelper.loadJson('chat_history.json', []);
    this.chatFeedback = StorageHelper.loadJson('chat_feedback.json', []);
    this.maxChatHistory = Math.max(200, Number.parseInt(process.env.MAX_CHAT_HISTORY || '5000', 10) || 5000);
  }

  persist() {
    StorageHelper.saveJson('logs.json', this.systemLogs);
    StorageHelper.saveJson('chat_history.json', this.chatHistory);
    StorageHelper.saveJson('chat_feedback.json', this.chatFeedback);
  }

  addLog(level, moduleName, message, details = null) {
    const logItem = {
      id: `log-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      timestamp: new Date().toLocaleString('vi-VN'),
      level: level.toUpperCase(),
      module: moduleName,
      message: message,
      details: details ? (typeof details === 'object' ? JSON.stringify(details, null, 2) : String(details)) : null
    };

    this.systemLogs.unshift(logItem);
    if (this.systemLogs.length > 500) this.systemLogs.pop();
    this.persist();
    return logItem;
  }

  addChatAudit(question, replyText, sqlQuery, providerInfo, latencyMs, status = 'SUCCESS', errorReason = null, requestPayload = null) {
    const auditItem = {
      id: `chat-${Date.now()}`,
      timestamp: new Date().toLocaleString('vi-VN'),
      question: question,
      replyText: replyText,
      sqlQuery: sqlQuery,
      requestPayload: requestPayload,
      providerName: providerInfo?.name || 'Không xác định',
      modelName: providerInfo?.model || 'Không xác định',
      latencyMs: Number.isFinite(Number(latencyMs)) ? Number(latencyMs) : null,
      status: status,
      errorReason: errorReason
    };

    this.chatHistory.unshift(auditItem);
    if (this.chatHistory.length > this.maxChatHistory) this.chatHistory.length = this.maxChatHistory;

    if (status === 'ERROR') {
      this.addLog('ERROR', 'AI Assistant', `Lỗi khi gọi model [${auditItem.modelName}]`, { errorReason });
    } else if (status === 'PARTIAL') {
      this.addLog('WARN', 'AI Assistant', `Yêu cầu chưa hoàn thành đầy đủ [${auditItem.modelName}] trong ${latencyMs}ms`);
    } else {
      this.addLog('SUCCESS', 'AI Assistant', `Hoàn thành yêu cầu [${auditItem.modelName}] trong ${latencyMs}ms`);
    }

    this.persist();
    return auditItem;
  }

  getLogs() {
    const chatModules = new Set(['AI Chat', 'AI Assistant', 'Embed Chat']);
    return this.systemLogs.map(log => {
      if (!chatModules.has(log.module)) return log;
      const isError = ['ERROR', 'WARN'].includes(String(log.level || '').toUpperCase());
      return {
        ...log,
        message: isError ? 'Không thể xử lý yêu cầu AI.' : 'Đã xử lý yêu cầu AI.',
        details: null
      };
    });
  }

  getChatHistory() {
    return this.chatHistory.map(item => ({
      ...item,
      feedback: this.chatFeedback.find(feedback => feedback.auditId === item.id)?.rating || null
    }));
  }

  addChatFeedback(auditId, rating, metadata = {}) {
    if (!auditId) throw new Error('Thiếu mã lượt chat.');
    if (!['like', 'dislike'].includes(rating)) throw new Error('Đánh giá không hợp lệ.');
    const existing = this.chatFeedback.find(item => item.auditId === auditId);
    const feedback = existing || {
      id: `feedback-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      auditId: auditId || null,
      createdAt: new Date().toISOString()
    };
    feedback.rating = rating;
    feedback.updatedAt = new Date().toISOString();
    feedback.providerId = metadata.providerId || feedback.providerId || null;
    feedback.model = metadata.model || feedback.model || null;
    if (!existing) this.chatFeedback.unshift(feedback);
    if (this.chatFeedback.length > this.maxChatHistory) this.chatFeedback.length = this.maxChatHistory;
    this.persist();
    return feedback;
  }

  getChatFeedback() {
    const audits = new Map(this.chatHistory.map(item => [item.id, item]));
    return this.chatFeedback.map(feedback => ({
      ...feedback,
      audit: audits.get(feedback.auditId) || null
    }));
  }

  reviewChatFeedback(auditId, reviewStatus, reviewNote = '') {
    if (!auditId) throw new Error('Thiếu mã lượt chat.');
    if (!['pending', 'approved', 'needs_review'].includes(reviewStatus)) {
      throw new Error('Trạng thái xem xét không hợp lệ.');
    }
    const feedback = this.chatFeedback.find(item => item.auditId === auditId);
    if (!feedback) throw new Error('Không tìm thấy đánh giá cho lượt chat này.');
    feedback.reviewStatus = reviewStatus;
    feedback.reviewNote = String(reviewNote || '').trim().slice(0, 1000);
    feedback.reviewedAt = reviewStatus === 'pending' ? null : new Date().toISOString();
    this.persist();
    return feedback;
  }

  clearLogs() {
    this.systemLogs = [];
    this.addLog("INFO", "System", "Nhật ký hệ thống đã được xóa bởi Admin.");
    this.persist();
    return true;
  }

  clearChatHistory() {
    this.chatHistory = [];
    this.persist();
    return true;
  }
}

module.exports = new LoggerService();
