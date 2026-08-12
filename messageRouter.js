const aiService = require('./aiService');
const db = require('./database');
const { logAudit } = require('./audit');
const { AUTO_CHAT_SKIP_TOKEN } = require('./autoChatConstants');

const MAX_HISTORY = 40;         // messages kept per chat, for tone-learning
const HISTORY_HINT_LINES = 15;  // most recent lines actually shown to the model
const AUTO_COOLDOWN_MS = 15_000; // min gap between autonomous AI calls per chat

function chatKey(connectionId, jid) {
  return `${connectionId}:${jid}`;
}

function getChatState(connectionId, jid) {
  const key = chatKey(connectionId, jid);
  let state = db.whatsapp_groups.get(key);
  if (!state) {
    state = { messages: [], lastAutoProcessedAt: 0 };
    db.whatsapp_groups.set(key, state);
  }
  return state;
}

// Learn how this chat talks: keep a rolling window of recent human messages
// so autonomous replies can be pointed at real, current conversational tone
// instead of generic phrasing.
function recordForLearning(connectionId, jid, senderLabel, text) {
  if (!text) return;
  const state = getChatState(connectionId, jid);
  state.messages.push({ sender: senderLabel, text, ts: Date.now() });
  if (state.messages.length > MAX_HISTORY) {
    state.messages = state.messages.slice(-MAX_HISTORY);
  }
  db.persistSoon();
}

function buildHistoryHint(connectionId, jid) {
  const state = getChatState(connectionId, jid);
  return state.messages
    .slice(-HISTORY_HINT_LINES)
    .map(m => `${m.sender}: ${m.text}`)
    .join('\n');
}

function getConnectionMode(connectionId) {
  const conn = db.whatsapp_connections.get(connectionId);
  return (conn && conn.mode) || 'listen';
}

function setConnectionMode(connectionId, mode) {
  const conn = db.whatsapp_connections.get(connectionId) || {};
  conn.mode = mode;
  db.whatsapp_connections.set(connectionId, conn);
  db.persistSoon();
}

// Pulls any successfully generated image out of a tool-call trail and sends
// it as a real WhatsApp image message (not just describing it in text).
async function deliverReply(session, jid, aiResult) {
  const imageCall = (aiResult.toolCalls || [])
    .find(tc => tc.name === 'images_generate' && tc.result?.status === 'success' && tc.result?.dataUri);

  if (imageCall) {
    const dataUri = imageCall.result.dataUri;
    const base64 = dataUri.slice(dataUri.indexOf(',') + 1);
    const buffer = Buffer.from(base64, 'base64');
    await session.sock.sendMessage(jid, {
      image: buffer,
      caption: (aiResult.content || '').slice(0, 1024)
    });
    return;
  }

  if (aiResult.content) {
    await session.sendMessage(jid, aiResult.content);
  }
}

async function handleWhatsAppMessage(msg, session, userId, connectionId) {
  const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || '';
  const trimmed = text.trim();
  if (!trimmed) return;

  const jid = msg.key.remoteJid;
  const isGroup = jid.endsWith('@g.us');
  const senderLabel = msg.pushName || (msg.key.participant || jid).split('@')[0];
  const isOwnerMessage = !!msg.isOwnerMessage;

  const baseContext = {
    userId,
    connectionId,
    transport: 'whatsapp',
    remoteJid: jid,
    participant: msg.key.participant || jid,
    isGroup,
    isOwnerMessage
  };

  const isCommand = trimmed.toLowerCase().startsWith('.gpt');

  if (isCommand) {
    const sub = trimmed.slice(4).trim();
    const subLower = sub.toLowerCase();

    // Mode toggles are owner-only, same as other owner-level actions.
    if (subLower === 'control yourself' || subLower === 'listen') {
      if (!isOwnerMessage) {
        await session.sendMessage(jid, '🤖 Only the account owner can change my mode. Message this from your own Note-to-Self chat.');
        return;
      }
      const newMode = subLower === 'control yourself' ? 'auto' : 'listen';
      setConnectionMode(connectionId, newMode);
      logAudit(userId, newMode === 'auto' ? 'WHATSAPP_MODE_AUTO' : 'WHATSAPP_MODE_LISTEN', connectionId, { mode: newMode });
      await session.sendMessage(
        jid,
        newMode === 'auto'
          ? '🤖 Got it — I\'ll chat freely in groups I\'m in when I have something useful to add, until you tell me to `.gpt listen`.'
          : '🤖 Back to listening — I\'ll only act when you address me with `.gpt` from now on.'
      );
      return;
    }

    if (!sub) {
      await session.sendMessage(jid, '🤖 AI Premium: Please provide a prompt after `.gpt`.');
      return;
    }

    const aiResult = await aiService.chat([{ role: 'user', content: sub }], baseContext);
    await deliverReply(session, jid, aiResult);
    return;
  }

  // Not an explicit .gpt command. Always feed the message into the
  // tone-learning history (even while in 'listen' mode), so there's already
  // real conversational context by the time autonomous mode is turned on.
  if (isGroup) recordForLearning(connectionId, jid, senderLabel, trimmed);

  if (!isGroup || getConnectionMode(connectionId) !== 'auto') return;

  // Cooldown bounds both API cost and spam risk — cap how often the bot
  // even considers jumping into a fast-moving group on its own.
  const state = getChatState(connectionId, jid);
  if (Date.now() - state.lastAutoProcessedAt < AUTO_COOLDOWN_MS) return;
  state.lastAutoProcessedAt = Date.now();

  const autoContext = {
    ...baseContext,
    autoChatMode: true,
    chatHistoryHint: buildHistoryHint(connectionId, jid)
  };

  const aiResult = await aiService.chat([{ role: 'user', content: trimmed }], autoContext);
  const reply = (aiResult.content || '').trim();
  if (!reply || reply === AUTO_CHAT_SKIP_TOKEN || reply.includes(AUTO_CHAT_SKIP_TOKEN)) return;

  await deliverReply(session, jid, aiResult);
}

module.exports = {
  handleWhatsAppMessage
};
