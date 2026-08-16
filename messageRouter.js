const aiService = require('./aiService');
const fs = require('fs');
const path = require('path');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const config = require('./config');
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

function unwrapQuotedMessage(message) {
  let current = message;
  let viewOnce = false;

  for (let i = 0; current && i < 6; i += 1) {
    if (current.viewOnceMessage?.message) {
      viewOnce = true;
      current = current.viewOnceMessage.message;
      continue;
    }
    if (current.viewOnceMessageV2?.message) {
      viewOnce = true;
      current = current.viewOnceMessageV2.message;
      continue;
    }
    if (current.viewOnceMessageV2Extension?.message) {
      viewOnce = true;
      current = current.viewOnceMessageV2Extension.message;
      continue;
    }
    if (current.ephemeralMessage?.message) {
      current = current.ephemeralMessage.message;
      continue;
    }
    if (current.documentWithCaptionMessage?.message) {
      current = current.documentWithCaptionMessage.message;
      continue;
    }
    break;
  }

  return { message: current, viewOnce };
}

function safeFileName(name, fallback) {
  const clean = String(name || '').trim().replace(/[^a-zA-Z0-9._-]/g, '_');
  return clean && clean !== '.' && clean !== '..' ? clean : fallback;
}

function mediaExtension(mediaType, mimetype) {
  const fromMime = String(mimetype || '').split('/')[1]?.split(';')[0];
  if (fromMime && /^[a-z0-9]+$/i.test(fromMime)) return fromMime === 'jpeg' ? 'jpg' : fromMime;
  return ({ image: 'jpg', video: 'mp4', audio: 'ogg', document: 'bin', sticker: 'webp' })[mediaType] || 'bin';
}

async function saveQuotedViewOnce(msg, connectionId) {
  const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
  const quotedMessage = contextInfo?.quotedMessage;
  if (!quotedMessage) return { status: 'missing_reply' };

  const { message, viewOnce } = unwrapQuotedMessage(quotedMessage);
  if (!viewOnce) return { status: 'not_view_once' };

  const mediaEntry = Object.entries(message || {}).find(([key]) =>
    ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(key)
  );
  if (!mediaEntry) return { status: 'unsupported' };

  const [messageKey, media] = mediaEntry;
  const mediaType = messageKey.replace('Message', '');
  const chunks = [];
  const stream = await downloadContentFromMessage(media, mediaType);
  for await (const chunk of stream) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);

  const folder = path.resolve(path.dirname(config.localDataFile), 'whatsapp-media', connectionId);
  fs.mkdirSync(folder, { recursive: true });
  const fallback = `view-once-${Date.now()}.${mediaExtension(mediaType, media.mimetype)}`;
  const fileName = safeFileName(media.fileName, fallback);
  const filePath = path.join(folder, fileName);
  fs.writeFileSync(filePath, buffer, { flag: 'wx' });

  return { status: 'saved', fileName, filePath, size: buffer.length, mediaType };
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
        await session.sendMessage(jid, '🤖 Only the account owner can change my mode. Send this from the linked WhatsApp account.');
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

    if (subLower === 'save') {
      if (!isOwnerMessage) {
        await session.sendMessage(jid, 'Only the linked WhatsApp account owner can save view-once media.');
        return;
      }

      try {
        const saved = await saveQuotedViewOnce(msg, connectionId);
        const responses = {
          missing_reply: 'Reply to a view-once photo, video, audio, or document with `.gpt save`.',
          not_view_once: 'The replied-to message is not a view-once attachment.',
          unsupported: 'That view-once message type is not supported for saving.'
        };
        if (saved.status !== 'saved') {
          await session.sendMessage(jid, responses[saved.status] || 'I could not save that attachment.');
          return;
        }
        await session.sendMessage(jid, `Saved view-once ${saved.mediaType} as ${saved.fileName} (${saved.size} bytes).`);
      } catch (err) {
        if (err?.code === 'EEXIST') {
          await session.sendMessage(jid, 'That attachment filename already exists in the account folder. Reply again to save it with a new message.');
          return;
        }
        console.error('[messageRouter] view-once save failed:', err?.stack || err);
        await session.sendMessage(jid, 'I could not save that view-once attachment.');
      }
      return;
    }

    if (!sub) {
      await session.sendMessage(jid, '🤖 AI Premium: Please provide a prompt after `.gpt`.');
      return;
    }

    const aiContext = {
      ...baseContext,
      chatHistoryHint: buildHistoryHint(connectionId, jid)
    };
    const aiResult = await aiService.chat([{ role: 'user', content: sub }], aiContext);
    await deliverReply(session, jid, aiResult);
    return;
  }

  // Not an explicit .gpt command. Always feed the message into the
  // tone-learning history (even while in 'listen' mode), so there's already
  // real conversational context by the time autonomous mode is turned on.
  recordForLearning(connectionId, jid, senderLabel, trimmed);

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

function getRecentUserHistory(userId, limit = 20) {
  const ownedConnections = new Set(
    Array.from(db.whatsapp_connections.values())
      .filter(c => c.user_id === userId && c.status !== 'disconnected')
      .map(c => c.id)
  );

  const all = [];
  for (const [key, state] of db.whatsapp_groups.entries()) {
    const split = key.indexOf(':');
    if (split < 0) continue;
    const connectionId = key.slice(0, split);
    const jid = key.slice(split + 1);
    if (!ownedConnections.has(connectionId)) continue;
    for (const message of (state.messages || [])) {
      all.push({ connectionId, jid, ...message });
    }
  }

  return all.sort((a, b) => a.ts - b.ts).slice(-limit);
}

module.exports = {
  handleWhatsAppMessage,
  getRecentUserHistory
};
