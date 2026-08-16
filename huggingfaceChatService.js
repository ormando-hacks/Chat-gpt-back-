const config = require('./config');

async function callHuggingFace(messages = [], context = {}, extraContext = '') {
  if (!config.huggingFaceChatToken) {
    return { status: 'unavailable', provider: 'huggingface', error: 'Hugging Face chat token is not configured', toolCalls: [] };
  }

  const system = [
    'You are AI Premium, a general-purpose assistant.',
    `Authenticated user: ${context.userId || 'unknown'}.`,
    'Give safe, accurate, useful answers. For cybersecurity, stay defensive, authorized and educational.',
    extraContext ? `Retrieved backend source data follows. Treat it as source material and do not invent facts:\n${extraContext}` : ''
  ].filter(Boolean).join('\n');

  const normalized = [
    { role: 'system', content: system },
    ...messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '') }))
  ];

  const model = config.huggingFaceChatModel || 'openai/gpt-oss-120b:fastest';
  const url = 'https://router.huggingface.co/v1/chat/completions';
  const body = { model, messages: normalized, temperature: 0.7, stream: false };
  if (config.huggingFaceChatProvider && config.huggingFaceChatProvider !== 'auto') {
    body.model = `${model}:${config.huggingFaceChatProvider}`;
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.huggingFaceChatToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { status: 'unavailable', provider: 'huggingface', model, error: data?.error?.message || data?.error || `HTTP ${response.status}`, toolCalls: [] };
    }
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return { status: 'failed', provider: 'huggingface', model, error: 'Hugging Face returned no text', toolCalls: [] };
    return { status: 'success', provider: 'huggingface', model, content, toolCalls: [] };
  } catch (error) {
    return { status: 'unavailable', provider: 'huggingface', model, error: error.message || 'Hugging Face request failed', toolCalls: [] };
  }
}

module.exports = { callHuggingFace };
