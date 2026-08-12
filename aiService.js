const config = require('./config');
const geminiService = require('./geminiService');
const openaiService = require('./openaiService');
const huggingfaceChat = require('./huggingfaceChatService');
const { callTool } = require('./openaiService');

function isFailure(result) {
  if (!result) return true;
  const text = String(result.content || '').toLowerCase();
  return result.status === 'unavailable' || result.status === 'failed' || /api key.*not configured|request failed|error:|failed to/i.test(text);
}

function latestUserText(messages = []) {
  return [...messages].reverse().find(m => m.role === 'user')?.content?.toString() || '';
}

async function fallbackResearch(messages) {
  const text = latestUserText(messages);
  const lower = text.toLowerCase();
  const results = [];

  // Only prefetch read-only research sources for fallback providers. This keeps
  // the same source-aware behavior even when Gemini is unavailable.
  if (/\bcve[- ]?\d{4}-\d{4,}\b/i.test(text)) {
    const id = text.match(/\bcve[- ]?\d{4}-\d{4,}\b/i)?.[0]?.toUpperCase().replace(/\s+/, '-');
    if (id) results.push(['NVD', await callTool('cve_getById', { cveId: id }, {})]);
  } else if (/\bcve\b|vulnerability|nvd|security advisory/i.test(lower)) {
    results.push(['NVD', await callTool('cve_search', { query: text.slice(0, 300) }, {})]);
  }
  if (/github|repository|repo|source code/i.test(lower)) {
    results.push(['GitHub', await callTool('github_searchRepos', { query: text.slice(0, 200) }, {})]);
  }
  if (/nist|csrc/i.test(lower)) {
    results.push(['NIST', await callTool('nist_search', { query: text.slice(0, 200) }, {})]);
  }
  if (!results.length) return '';
  return results.map(([name, data]) => `${name}: ${JSON.stringify(data).slice(0, 12000)}`).join('\n\n');
}

async function chat(messages, context = {}, files = []) {
  // Image generation is deliberately NOT part of the text-model path.
  if (config.aiProvider === 'openai') {
    if (files.length) return { content: 'File/image inspection is configured for Gemini in this build. Set AI_PROVIDER=gemini for multimodal uploads.', toolCalls: [] };
    const primary = await openaiService.callOpenAIWithTools(messages, context);
    if (!isFailure(primary)) return primary;
  } else if (config.aiProvider === 'gemini') {
    const primary = await geminiService.callGeminiWithTools(messages, context, files);
    if (!isFailure(primary)) return primary;
  }

  // Seamless provider failover: Gemini -> OpenAI -> Hugging Face.
  if (config.aiProvider !== 'openai' && config.openaiApiKey && !files.length) {
    const secondary = await openaiService.callOpenAIWithTools(messages, context);
    if (!isFailure(secondary)) return secondary;
  }

  if (!files.length && config.huggingFaceChatToken) {
    const sourceContext = await fallbackResearch(messages);
    const tertiary = await huggingfaceChat.callHuggingFace(messages, context, sourceContext);
    if (!isFailure(tertiary)) return tertiary;
  }

  if (config.aiProvider === 'gemini') return { content: 'All configured AI providers are currently unavailable. Please try again shortly.', toolCalls: [] };
  return { content: `AI provider "${config.aiProvider}" is unavailable and no fallback provider succeeded.`, toolCalls: [] };
}

function status() {
  return {
    provider: config.aiProvider,
    gemini: !!config.geminiApiKey,
    openai: !!config.openaiApiKey,
    huggingface: !!config.huggingFaceChatToken,
    models: {
      gemini: config.geminiModel,
      openai: config.openaiModel || 'gpt-4o',
      huggingface: config.huggingFaceChatModel
    }
  };
}

module.exports = { chat, status };
