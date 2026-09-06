/**
 * Intelligent Core — Entry Point
 *
 * Cấu trúc thư mục:
 *   intelligent_core/
 *   ├── index.js              ← entry point (file này)
 *   ├── core.js               ← agentic loop chính
 *   ├── ai_persona_service.js ← tính cách & system prompt AI
 *   ├── tool_registry.js      ← 6 tools đăng ký
 *   └── adapters/
 *       ├── index.js          ← dispatcher chọn adapter
 *       ├── ollama.js         ← Ollama Local
 *       ├── openai.js         ← OpenAI / DeepSeek / LM Studio / OpenRouter
 *       ├── gemini.js         ← Google Gemini
 *       └── anthropic.js      ← Anthropic Claude
 */

module.exports = {
  /** Agentic loop chính — dùng trong router.js */
  core:         require('./core'),

  /** Tính cách AI — đọc/ghi persona */
  personaService: require('./ai_persona_service'),

  /** Tool Registry — 6 tools tích hợp sẵn */
  toolRegistry:   require('./tool_registry'),

  /** Adapters — gọi trực tiếp nếu cần */
  adapters:       require('./adapters')
};
