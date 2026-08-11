const config = require('./config');
const geminiService = require('./geminiService');
const openaiService = require('./openaiService');

async function chat(messages, context = {}, files = []) {
  if (config.aiProvider === 'openai') {
    if (files.length) {
      return { content: 'File/image inspection is configured for Gemini in this $0 build. Set AI_PROVIDER=gemini or add an OpenAI multimodal adapter before using uploads with OpenAI.', toolCalls: [] };
    }
    return openaiService.callOpenAIWithTools(messages, context);
  }

  if (config.aiProvider === 'gemini') {
    return geminiService.callGeminiWithTools(messages, context, files);
  }

  return { content: `AI provider "${config.aiProvider}" is not configured. Set AI_PROVIDER=gemini.`, toolCalls: [] };
}

function status() {
  return {
    provider: config.aiProvider,
    gemini: !!config.geminiApiKey,
    openai: !!config.openaiApiKey,
    model: config.aiProvider === 'gemini' ? config.geminiModel : (config.openaiModel || 'gpt-4o')
  };
}

module.exports = { chat, status };
