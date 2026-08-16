const config = require('./config');
const { callTool, tools: openaiStyleTools } = require('./openaiService');
const { AUTO_CHAT_SKIP_TOKEN } = require('./autoChatConstants');

let clientPromise = null;

async function getClient() {
  if (!config.geminiApiKey) return null;
  if (!clientPromise) {
    clientPromise = import('@google/genai').then(({ GoogleGenAI }) =>
      new GoogleGenAI({ apiKey: config.geminiApiKey })
    );
  }
  return clientPromise;
}

function toGeminiTools() {
  return openaiStyleTools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters
  }));
}

function normalizeMessages(messages = []) {
  const out = [];
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
    if (!text) continue;
    out.push({ role, parts: [{ text }] });
  }
  return out;
}

function buildSystemInstruction(ctx) {
  const lines = [
    'You are AI Premium, a general-purpose assistant with strong programming, cybersecurity education, software engineering and research capabilities.',
    `Authenticated user: ${ctx.userId || 'unknown'}. Transport: ${ctx.transport || 'web'}.`,
    'Use backend tools when current, source-specific information or an external action is required.',
    'When using GitHub, NVD/CVE, NIST, documentation or tutorials, distinguish retrieved source facts from your own explanation and include useful source URLs when available.',
    'For security topics, prioritize defensive, authorized and educational guidance. Do not claim an external action succeeded unless the tool result confirms success.',
    'For WhatsApp actions, you act as a second owner of the linked account: alongside ordinary chatting and sending, you can perform account-owner actions (group admin/settings, blocking contacts, chat archive/mute/pin, message deletion, profile status and status posting). Web requests are authorized by the authenticated account; WhatsApp requests are authorized only when sent by the linked account itself. Never claim a WhatsApp action succeeded unless the tool result confirms success.',
    'Structure answers cleanly with headings, bullets, code blocks and concise explanations when appropriate.'
  ];
  if (ctx.connectionId) lines.push(`Active WhatsApp connectionId: ${ctx.connectionId}.`);
  if (ctx.whatsappHistoryHint) lines.push(`Recent remembered WhatsApp chats (use only when relevant):\n${ctx.whatsappHistoryHint}`);
  if (ctx.chatHistoryHint) lines.push(`Recent chat context:\n${ctx.chatHistoryHint}`);
  if (ctx.autoChatMode) {
    lines.push(`You are currently in autonomous group-listening mode: you were not directly addressed with .gpt, so only reply if you genuinely have something friendly, helpful, or interesting to add to this specific message — otherwise reply with exactly the token ${AUTO_CHAT_SKIP_TOKEN} and nothing else. When you do reply, be friendly and helpful, explain things in real detail, and match how this group naturally talks based on the recent messages provided.`);
    if (ctx.chatHistoryHint) lines.push(`Recent group conversation for tone reference:\n${ctx.chatHistoryHint}`);
  }
  return lines.join('\n');
}

function makeContents(messages, files) {
  const contents = normalizeMessages(messages);
  if (files.length) {
    const fileParts = files.map(file => ({
      inlineData: {
        mimeType: file.mimetype,
        data: file.buffer.toString('base64')
      }
    }));
    const lastUser = contents.length && contents[contents.length - 1].role === 'user'
      ? contents[contents.length - 1]
      : { role: 'user', parts: [{ text: 'Inspect the attached file(s).' }] };
    lastUser.parts = [...lastUser.parts, ...fileParts];
    if (!contents.length || contents[contents.length - 1] !== lastUser) contents.push(lastUser);
  }
  return contents;
}

async function callGeminiWithTools(messages, userContext = {}, files = []) {
  const ai = await getClient();
  if (!ai) return { content: 'Gemini API key is not configured. Set GEMINI_API_KEY on the backend.', toolCalls: [] };

  let contents = makeContents(messages, files);
  const toolDeclarations = toGeminiTools();
  const toolCalls = [];

  try {
    for (let round = 0; round < 8; round++) {
      const response = await ai.models.generateContent({
        model: config.geminiModel,
        contents,
        config: {
          systemInstruction: buildSystemInstruction(userContext),
          tools: [{ functionDeclarations: toolDeclarations }]
        }
      });

      const calls = response.functionCalls || [];
      if (!calls.length) {
        return { content: response.text || '', toolCalls };
      }

      const modelContent = response.candidates?.[0]?.content;
      if (modelContent) contents.push(modelContent);

      const functionResponses = [];
      for (const fc of calls) {
        let result;
        try {
          result = await callTool(fc.name, fc.args || {}, userContext);
        } catch (error) {
          result = { error: error.message || 'Tool execution failed' };
        }
        toolCalls.push({ name: fc.name, args: fc.args || {}, result });
        functionResponses.push({
          functionResponse: {
            name: fc.name,
            response: { result },
            id: fc.id
          }
        });
      }

      contents.push({ role: 'user', parts: functionResponses });
    }

    return { content: 'The request required too many tool steps. Please narrow the request.', toolCalls };
  } catch (error) {
    console.error('Gemini Error:', error?.message || error);
    return {
      content: `Gemini request failed: ${error?.message || 'Unknown error'}`,
      toolCalls
    };
  }
}

module.exports = { callGeminiWithTools };
