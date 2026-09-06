/**
 * AI Provider Routing & Fallback Manager (Full Functional Service)
 * Supports full CRUD, active selection, test connection, and multi-provider routing.
 */

const StorageHelper = require('../utils/storage_helper');

class AiProviderManager {
  constructor() {
    const defaultProviders = [
      {
        id: "provider-ollama",
        name: "Ollama Local (Qwen 2.5)",
        type: "local",
        apiFormat: "ollama",
        executionClass: "local",
        baseUrl: "http://localhost:11434",
        apiKey: "",
        model: "qwen2.5-coder",
        supportsToolCalling: false,
        priority: 1,
        isActive: true,
        status: "connected",
        tokenCost: 0
      },
      {
        id: "provider-gemini",
        name: "Google Gemini Cloud",
        type: "google",
        apiFormat: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com",
        apiKey: "",
        model: "gemini-1.5-flash",
        supportsToolCalling: true,
        priority: 2,
        isActive: false,
        status: "unconfigured",
        tokenCost: 0.0015
      },
      {
        id: "provider-openai",
        name: "OpenAI GPT-4o",
        type: "openai",
        apiFormat: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "",
        model: "gpt-4o-mini",
        supportsToolCalling: true,
        priority: 3,
        isActive: false,
        status: "unconfigured",
        tokenCost: 0.0050
      }
    ];

    this.providers = StorageHelper.loadJson('ai_providers.json', defaultProviders);
    const activeProv = this.providers.find(p => p.isActive) || this.providers[0];
    this.activeProviderId = activeProv ? activeProv.id : "provider-ollama";
  }

  persist() {
    StorageHelper.saveJson('ai_providers.json', this.providers);
  }

  getProviders() {
    return this.providers.map(p => ({
      ...p,
      apiKeyMasked: p.apiKey ? `${p.apiKey.substring(0, 4)}••••••••` : "Không cần API Key"
    }));
  }

  getActiveProvider() {
    const found = this.providers.find(p => p.id === this.activeProviderId && p.isActive);
    if (found) return found;
    
    // Fallback to first active
    const firstActive = this.providers.find(p => p.isActive);
    if (firstActive) {
      this.activeProviderId = firstActive.id;
      return firstActive;
    }
    
    return this.providers[0];
  }

  setActiveProvider(providerId) {
    const target = this.providers.find(p => p.id === providerId);
    if (!target) {
      throw new Error("Provider không tồn tại!");
    }

    this.providers.forEach(p => {
      p.isActive = (p.id === providerId);
    });

    this.activeProviderId = providerId;
    this.persist();
    console.log(`[AI Router] Active Provider switched to: ${target.name} (${target.model})`);
    return target;
  }

  addProvider(data) {
    const newId = `provider-${Date.now()}`;
    const newProvider = {
      id: newId,
      name: data.name || "Custom AI Provider",
      type: data.type || "openai_compatible",
      apiFormat: data.apiFormat || "openai",
      executionClass: data.executionClass || (String(data.apiFormat || '').toLowerCase() === 'ollama' || String(data.type || '').toLowerCase().includes('local') ? 'local' : 'remote'),
      baseUrl: data.baseUrl || "http://localhost:11434",
      apiKey: data.apiKey || "",
      model: data.model || "custom-model",
      supportsToolCalling: data.supportsToolCalling === true || data.supportsToolCalling === 'true',
      priority: parseInt(data.priority) || (this.providers.length + 1),
      isActive: false,
      status: "connected",
      tokenCost: parseFloat(data.tokenCost) || 0
    };

    this.providers.push(newProvider);
    this.persist();
    return newProvider;
  }

  updateProvider(providerId, data) {
    const target = this.providers.find(p => p.id === providerId);
    if (!target) throw new Error('Provider không tồn tại!');

    const allowed = ['name', 'type', 'apiFormat', 'executionClass', 'baseUrl', 'apiKey', 'model', 'supportsToolCalling', 'priority', 'tokenCost'];
    for (const key of allowed) {
      if (data[key] !== undefined) {
        target[key] = key === 'supportsToolCalling'
          ? (data[key] === true || data[key] === 'true')
          : (key === 'priority' ? parseInt(data[key]) : (key === 'tokenCost' ? parseFloat(data[key]) : data[key]));
      }
    }
    this.persist();
    return target;
  }

  deleteProvider(providerId) {
    this.providers = this.providers.filter(p => p.id !== providerId);
    if (this.activeProviderId === providerId && this.providers.length > 0) {
      this.setActiveProvider(this.providers[0].id);
    }
    this.persist();
    return true;
  }

  async testConnection(providerId) {
    const provider = this.providers.find(p => p.id === providerId);
    if (!provider) throw new Error("Provider không tồn tại!");

    const startTime = Date.now();
    try {
      if (typeof fetch !== 'undefined') {
        const baseUrl = String(provider.baseUrl || '').replace(/\/$/, '');
        const format = String(provider.apiFormat || '').toLowerCase();
        const type = String(provider.type || '').toLowerCase();
        const isOllama = format === 'ollama' || type.includes('ollama') || baseUrl.includes('11434');
        const isGemini = format === 'gemini' || type.includes('gemini') || baseUrl.includes('googleapis.com');
        const testUrl = isOllama
          ? `${baseUrl}/api/tags`
          : (isGemini
              ? `${baseUrl}/v1beta/models?key=${encodeURIComponent(provider.apiKey || '')}`
              : `${baseUrl}/models`);
        const headers = { 'Accept': 'application/json' };
        if (!isOllama && !isGemini && provider.apiKey) {
          headers.Authorization = `Bearer ${provider.apiKey}`;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);
        
        try {
          const res = await fetch(testUrl, { headers, signal: controller.signal });
          clearTimeout(timer);
          if (!res.ok) {
            let detail = '';
            try {
              const payload = await res.json();
              detail = payload?.error?.message || payload?.message || '';
            } catch (_) {}
            throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
          }
          if (isOllama) {
            const payload = await res.json();
            const configuredModel = String(provider.model || '').trim();
            const normalizeModel = value => String(value || '').replace(/:latest$/i, '');
            const installedModels = Array.isArray(payload?.models) ? payload.models.map(item => item?.name).filter(Boolean) : [];
            const modelInstalled = configuredModel && installedModels.some(name =>
              name === configuredModel || normalizeModel(name) === normalizeModel(configuredModel)
            );
            if (!modelInstalled) {
              throw new Error(`Model "${configuredModel || '(chưa cấu hình)'}" chưa được cài trong Ollama. Model hiện có: ${installedModels.join(', ') || 'không có'}`);
            }
          }
          const latencyMs = Date.now() - startTime;
          provider.status = "connected";
          this.persist();
          return {
            success: true,
            message: `Kết nối API thành công tới ${provider.name} (${provider.baseUrl}).`,
            latencyMs: latencyMs
          };
        } catch (e) {
          clearTimeout(timer);
          provider.status = "standby";
          this.persist();
          return {
            success: false,
            message: `Không kết nối được ${provider.baseUrl} (${e.message}).`,
            latencyMs: Date.now() - startTime
          };
        }
      }
    } catch (err) {
      // Fallback response
    }

    return {
      success: false,
      message: `Không thể xác minh kết nối tới ${provider.name} (${provider.baseUrl}).`,
      latencyMs: null
    };
  }
}

module.exports = new AiProviderManager();
