/**
 * Smart AI Assistant Engine (General Chat RAG + Text-to-SQL Multi-LLM Agent)
 * Connects to Active LLM Provider (Ollama / OpenAI / Gemini / DeepSeek)
 * Returns explicit executionMode and detailed status/error diagnostics.
 */

const dictionaryService = require('./dictionary_service');
const aiProviderManager = require('./ai_provider_manager');

class Text2SqlAgent {
  validateSqlSafety(sqlString) {
    if (!sqlString) return { safe: true };
    const cleaned = sqlString.trim().toUpperCase();

    if (!cleaned.startsWith('SELECT') && !cleaned.startsWith('WITH')) {
      return { safe: false, reason: "Chỉ cho phép câu lệnh SELECT (Read-Only)." };
    }

    const blacklist = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'EXEC', 'EXECUTE', 'CREATE', 'GRANT', 'REVOKE'];
    for (const word of blacklist) {
      const regex = new RegExp(`\\b${word}\\b`, 'i');
      if (regex.test(sqlString)) {
        return { safe: false, reason: `Cảnh báo an toàn: Phát hiện từ khóa bị cấm "${word}".` };
      }
    }

    return { safe: true };
  }

  removeVietnameseDiacritics(str) {
    return str.normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d").replace(/Đ/g, "D")
      .toLowerCase();
  }

  async callLlmApi(provider, systemPrompt, userQuestion) {
    if (typeof fetch === 'undefined') return { error: "Fetch API không hỗ trợ trong môi trường này." };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);

    try {
      if (provider.baseUrl.includes('11434') || provider.type === 'local' || provider.type === 'Ollama (Local)') {
        // 1. Ollama API Endpoint
        const res = await fetch(`${provider.baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: provider.model || 'qwen2.5-coder',
            prompt: `${systemPrompt}\n\nNgười dùng hỏi: ${userQuestion}\nTrả lời:`,
            stream: false
          }),
          signal: controller.signal
        });
        clearTimeout(timer);
        if (res.ok) {
          const data = await res.json();
          return { text: data.response || data.output, source: 'live_llm' };
        } else {
          return { error: `Ollama trả về HTTP ${res.status}: Hãy kiểm tra Ollama daemon đã khởi động chưa.` };
        }
      } else if (provider.type === 'google' || provider.type === 'Google Gemini API' || provider.baseUrl.includes('googleapis.com')) {
        // 2. Google Gemini Native & OpenAI-Compatible REST API Endpoint
        let validGeminiModel = provider.model || 'gemini-1.5-flash';

        let geminiUrl = `${provider.baseUrl}/v1beta/models/${validGeminiModel}:generateContent?key=${provider.apiKey}`;
        if (provider.baseUrl.includes('/openai')) {
          geminiUrl = provider.baseUrl;
        }
        
        const res = await fetch(geminiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(provider.baseUrl.includes('/openai') ? { 'Authorization': `Bearer ${provider.apiKey}` } : {})
          },
          body: JSON.stringify(provider.baseUrl.includes('/openai') ? {
            model: provider.model || 'gemini-1.5-flash',
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userQuestion }
            ]
          } : {
            contents: [{
              parts: [{ text: `${systemPrompt}\n\nNgười dùng hỏi: ${userQuestion}` }]
            }]
          }),
          signal: controller.signal
        });
        clearTimeout(timer);

        if (res.ok) {
          const data = await res.json();
          let txt = null;
          if (data.choices?.[0]?.message?.content) {
            txt = data.choices[0].message.content;
          } else if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
            txt = data.candidates[0].content.parts[0].text;
          }
          if (txt) return { text: txt, source: 'live_llm' };
        } else {
          const errBody = await res.text();
          let errDetail = `HTTP ${res.status}`;
          try {
            const parsedErr = JSON.parse(errBody);
            errDetail = parsedErr.error?.message || errDetail;
          } catch(e) {}
          return { error: `Gemini API trả về lỗi (${errDetail}). Vui lòng kiểm tra API Key tại trang AI Providers.` };
        }
      } else {
        // 3. OpenAI / DeepSeek / Cloud API Endpoint
        const res = await fetch(`${provider.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${provider.apiKey}`
          },
          body: JSON.stringify({
            model: provider.model || 'gpt-4o-mini',
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userQuestion }
            ]
          }),
          signal: controller.signal
        });
        clearTimeout(timer);
        if (res.ok) {
          const data = await res.json();
          const txt = data.choices?.[0]?.message?.content || null;
          if (txt) return { text: txt, source: 'live_llm' };
        } else {
          return { error: `Provider trả về HTTP ${res.status}: Vui lòng kiểm tra API Key.` };
        }
      }
    } catch (err) {
      clearTimeout(timer);
      return { error: `Không thể kết nối Endpoint ${provider.baseUrl} (${err.message}).` };
    }
    return { error: "Không nhận được phản hồi từ AI Provider." };
  }

  async processNaturalLanguageQuery(questionText, targetProviderId = null) {
    const lower = questionText.toLowerCase().trim();
    const normalized = this.removeVietnameseDiacritics(lower);
    const groupedTables = dictionaryService.getGroupedTables();
    const activeTables = dictionaryService.getDictionary();

    let provider = aiProviderManager.getActiveProvider();
    if (targetProviderId) {
      const found = aiProviderManager.getProviders().find(p => p.id === targetProviderId);
      if (found) provider = found;
    }

    // Specific Question: "Có bao nhiêu bảng" / "Mấy bảng"
    if (normalized.includes("co bao nhieu bang") || normalized.includes("may bang") || normalized.includes("danh sach bang")) {
      const tableNamesList = groupedTables.map(t => `\`${t.tableName}\``).join(', ');
      return {
        type: "general_chat",
        executionMode: "system_metadata",
        question: questionText,
        replyText: `📊 Trong hệ thống CSDL SQL Server hiện có tổng cộng **${groupedTables.length} Bảng** (${activeTables.length} Cột dữ liệu).\n\n**Danh sách các Bảng:** ${tableNamesList || 'Chưa có bảng nào được nạp.'}`,
        sqlQuery: null,
        executionResult: null
      };
    }

    // Check database query intent keywords
    const dbKeywords = ["luong", "doanh thu", "hoa don", "khach hang", "nhan vien", "phong ban", "sql", "select", "thong ke", "truy van", "dem", "san pham", "schema", "table", "co bao nhieu", "liet ke"];
    const isDbQuery = dbKeywords.some(kw => normalized.includes(kw));

    // Construct System Prompt with Active Database Schemas
    const schemaContext = activeTables.length > 0 ? 
      activeTables.map(col => `- Table: ${col.tableName}, Column: ${col.columnName} (${col.dataType}${col.isPrimaryKey ? ', PK' : ''})`).join('\n')
      : "Chưa nạp Schema SQL Server.";

    const systemPrompt = `Bạn là Trợ lý AI chuyên gia Text-to-SQL và RAG cho SQL Server.
Dưới đây là cấu trúc các bảng SQL Server hiện có trong CSDL (Chỉ sử dụng các bảng này):
${schemaContext}

Quy tắc bắt buộc:
1. Nếu câu hỏi không yêu cầu truy vấn bảng dữ liệu, hãy trả lời tự nhiên, thân thiện bằng tiếng Việt.
2. Nếu câu hỏi yêu cầu tra cứu CSDL, hãy sinh duy nhất 1 câu lệnh SQL SELECT an toàn (Chuẩn MS SQL Server T-SQL, có TOP/JOIN/GROUP BY nếu cần). Dùng cú pháp Markdown \`\`\`sql ... \`\`\` để bao quanh lệnh SQL.`;

    // Attempt Real LLM Completion
    const llmResult = await this.callLlmApi(provider, systemPrompt, questionText);

    if (llmResult && llmResult.text) {
      const llmResponse = llmResult.text;
      // Extract SQL if present in LLM response
      const sqlMatch = llmResponse.match(/```sql([\s\S]*?)```/) || llmResponse.match(/(SELECT[\s\S]*?;)/i);
      if (sqlMatch) {
        const extractedSql = sqlMatch[1].trim();
        const safetyCheck = this.validateSqlSafety(extractedSql);

        if (safetyCheck.safe) {
          const cleanText = llmResponse.replace(/```sql[\s\S]*?```/g, '').trim();
          
          // Try executing real query on live database
          let dynamicResults = [];
          try {
            const sqlConnector = require('./sql_connector');
            dynamicResults = await sqlConnector.executeSqlQuery(extractedSql);
          } catch (liveErr) {
            console.error("[SQL Live Execution Error]:", liveErr.message);
            // If offline or using DDL file mode, fallback to schema-based calculation
            const upperSql = extractedSql.toUpperCase();
            if (upperSql.includes("COUNT(")) {
              const aliasMatch = extractedSql.match(/AS\s+([a-zA-Z0-9_]+)/i);
              const keyName = aliasMatch ? aliasMatch[1] : "SoLuongKetQua";
              dynamicResults = [{ [keyName]: `Lỗi kết nối SQL Server: ${liveErr.message}` }];
            } else {
              dynamicResults = [{ Error: `Lỗi kết nối SQL Server: ${liveErr.message}` }];
            }
          }

          return {
            type: "sql_query",
            executionMode: "live_llm",
            question: questionText,
            replyText: cleanText || `Mô hình **${provider.name}** đã phân tích cấu trúc CSDL và sinh câu lệnh SQL:`,
            sqlQuery: extractedSql,
            isSafe: true,
            executionResult: dynamicResults
          };
        }
      }

      return {
        type: "general_chat",
        executionMode: "live_llm",
        question: questionText,
        replyText: llmResponse,
        sqlQuery: null,
        executionResult: null
      };
    }

    const fallbackReason = llmResult?.error || "Mô hình AI Endpoint offline hoặc chưa cung cấp API Key thật.";

    // General Chat Intent Fallback when LLM endpoint is offline
    if (!isDbQuery) {
      return {
        type: "general_chat",
        executionMode: "fallback_engine",
        fallbackReason: fallbackReason,
        question: questionText,
        replyText: `💡 *[Lý do dùng Chế độ Dự phòng: ${fallbackReason}]*\n\nXin chào! Rất vui được trò chuyện với bạn. Bạn có thể dán **API Key thật** tại trang **AI Providers** để tôi kích hoạt trí tuệ Live AI ngay lập tức!`,
        sqlQuery: null,
        executionResult: null
      };
    }

    // DB Schema Fallback when offline
    if (activeTables.length === 0) {
      return {
        type: "general_chat",
        executionMode: "fallback_engine",
        fallbackReason: fallbackReason,
        question: questionText,
        replyText: "⚠️ **Chưa có dữ liệu SQL Server nào được nạp vào KnowledgeHub.**<br>Vui lòng chuyển tới trang **'SQL Connector'** để kết nối cơ sở dữ liệu mới hoặc nạp file DDL Script trước khi thực hiện câu hỏi truy vấn dữ liệu!",
        sqlQuery: null,
        executionResult: null
      };
    }

    // Smart Schema Match Fallback
    const matchedItem = activeTables.find(i => normalized.includes(this.removeVietnameseDiacritics(i.tableName))) || activeTables[0];
    const targetTable = matchedItem ? matchedItem.tableName : "DatabaseTable";

    const sqlQuery = `SELECT TOP 10 * FROM ${targetTable};`;
    const naturalReply = `Mô hình **${provider.name}** đang hoạt động ở Chế độ Dự phòng (*${fallbackReason}*):`;
    
    const dataResults = null;

    const safetyCheck = this.validateSqlSafety(sqlQuery);
    if (!safetyCheck.safe) {
      throw new Error(`[Security Guard Rejected] ${safetyCheck.reason}`);
    }

    return {
      type: "sql_query",
      executionMode: "fallback_engine",
      fallbackReason: fallbackReason,
      question: questionText,
      replyText: `${naturalReply}\n\nChỉ tạo câu SQL tham khảo; chưa thực thi nên không có dữ liệu kết quả.`,
      sqlQuery: sqlQuery,
      isSafe: true,
      executionResult: dataResults
    };
  }

  generateGeneralResponse(normalizedQuestion) {
    if (normalizedQuestion.includes("ban la ai") || normalizedQuestion.includes("la ai")) {
      return "Tôi là **Trợ lý AI KnowledgeHub (v3)**! Tôi có thể trò chuyện tự nhiên với bạn, giải đáp các thắc mắc thông thường, và tự động chuyển sang chế độ Text-to-SQL để tra cứu cơ sở dữ liệu khi bạn nạp Schema mới.";
    }
    if (normalizedQuestion.includes("cach dung") || normalizedQuestion.includes("huong dan") || normalizedQuestion.includes("giup")) {
      return "Bạn có thể sử dụng Trợ lý AI theo 2 cách linh hoạt:\n\n1. 💬 **Trò chuyện tự nhiên**: Hỏi đáp tổng quan, giải thích thuật ngữ, tư vấn giải pháp.\n2. 📊 **Truy vấn Dữ liệu SQL**: Nạp lược đồ tại trang *SQL Connector*, sau đó đặt câu hỏi tự nhiên để tôi tự động dịch sang lệnh SELECT an toàn!";
    }
    return "Xin chào! Rất vui được trò chuyện với bạn. Bạn có thể hỏi bất kỳ câu hỏi thông thường nào bằng tiếng Việt, hoặc vào trang **SQL Connector** để nạp cơ sở dữ liệu mới và yêu cầu tôi sinh câu lệnh SQL!";
  }
}

module.exports = new Text2SqlAgent();
