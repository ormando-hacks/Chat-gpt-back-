const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const multer = require('multer');
const config = require('./config');
const db = require('./database');
const { authenticateUser, requireOwner } = require('./auth');
const { logAudit, getAuditLogs } = require('./audit');

const aiService = require('./aiService');
const githubApi = require('./githubApi');
const cveApi = require('./cveApi');
const nistApi = require('./nistApi');
const docsApi = require('./docsApi');
const tutorialsApi = require('./tutorialsApi');
const exploitsApi = require('./exploitsApi');
const sandbox = require('./sandbox');
const imageApi = require('./imageApi');
const imageQuota = require('./imageQuota');
const sessionManager = require('./sessionManager');

const app = express();
const masterAttempts = new Map();
const accountAttempts = new Map();
const sessionAttempts = new Map();
function rateLimited(map, key, limit, windowMs) {
  const now = Date.now();
  const current = map.get(key) || { count: 0, reset: now + windowMs };
  if (now >= current.reset) { current.count = 0; current.reset = now + windowMs; }
  current.count += 1;
  map.set(key, current);
  return current.count > limit;
}
function publicError(error) { return { error }; }
function safeSecretEqual(a,b){ if(!a || !b) return false; const aa=Buffer.from(a); const bb=Buffer.from(b); return aa.length===bb.length && crypto.timingSafeEqual(aa,bb); }
function masterRateLimited(ip){ const now=Date.now(); const x=masterAttempts.get(ip)||{count:0,reset:now+15*60*1000}; if(now>x.reset){x.count=0;x.reset=now+15*60*1000;} return x.count>=10; }
function recordMasterFailure(ip){ const now=Date.now(); const x=masterAttempts.get(ip)||{count:0,reset:now+15*60*1000}; if(now>x.reset){x.count=0;x.reset=now+15*60*1000;} x.count++; masterAttempts.set(ip,x); }
app.use(cors({
  origin(origin, callback) {
    if (!origin || config.allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '2mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    const allowed = /^(image\/(jpeg|png|webp|bmp)|application\/pdf|text\/(plain|csv|html|css|xml)|application\/(json|javascript)|text\/javascript)$/i;
    if (!allowed.test(file.mimetype)) return cb(new Error(`Unsupported file type: ${file.mimetype}`));
    cb(null, true);
  }
});

// Health Check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    version: '3.10.0', 
    timestamp: new Date().toISOString(),
    config: {
      ai: aiService.status(),
      redis: !!config.redisUrl || !!config.upstashRedisUrl,
      github: !!config.githubToken,
      nvd: !!config.nvdApiKey,
      database: db.hasDurableStore() ? 'postgres' : 'local-file (resets on redeploy)',
      imageProvider: imageApi.status ? imageApi.status() : config.imageProvider
    }
  });
});

// Accounts API
app.post('/api/account/generate-id', (req, res) => {
  if (rateLimited(accountAttempts, req.ip, 10, 15 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many account requests. Try again later.' });
  }
  const userId = crypto.randomUUID();
  const user = {
    id: userId,
    role: 'standard',
    permissions: ['chat.use', 'github.use', 'cve.use', 'nist.use', 'docs.use', 'tutorials.use', 'images.use', 'runtime.use'],
    created_at: new Date().toISOString()
  };
  db.users.set(userId, user);
  db.persistSoon();
  logAudit(userId, 'GENERATE_ACCOUNT', userId, 'Success');
  res.json({ userId, role: user.role });
});

app.post('/api/account/session', (req, res) => {
  if (rateLimited(sessionAttempts, req.ip, 30, 15 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many session requests. Try again later.' });
  }
  const { userId, credential } = req.body;
  const user = db.users.get(userId);
  
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Master access is opt-in. A supplied credential must be exactly the
  // server-side MASTER_ADMIN_SECRET; a wrong credential is never converted
  // into an ordinary session. This prevents the old 'anything logs in' bug.
  if (credential) {
    if (masterRateLimited(req.ip)) return res.status(429).json({ error: 'Too many master credential attempts. Try again later.' });
    if (!safeSecretEqual(credential, config.masterAdminSecret)) {
      recordMasterFailure(req.ip);
      return res.status(401).json({ error: 'Invalid master credential' });
    }
    user.role = 'owner';
    user.permissions = ['all'];
    db.persistSoon();
    logAudit(userId, 'LINK_MASTER_ADMIN', userId, 'Success');
  }

  const token = crypto.randomBytes(32).toString('hex');
  const session = {
    token,
    userId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24h
  };
  db.sessions.set(token, session);
  db.persistSoon();
  
  res.json({ token, role: user.role, expiresAt: session.expiresAt });
});

app.get('/api/account/me', authenticateUser, (req, res) => {
  res.json({ user: req.user });
});

// Chat API
app.post('/api/chat', authenticateUser, async (req, res) => {
  const { messages, conversationId } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Messages array required' });
  }

  // P2 Fix: Conversation Persistence
  const activeConversationId = conversationId || crypto.randomUUID();
  const result = await aiService.chat(messages, { userId: req.user.id, transport: 'web' });
  
  db.conversations.set(activeConversationId, { id: activeConversationId, userId: req.user.id, updatedAt: new Date().toISOString() });
  db.messages.set(crypto.randomUUID(), {
    conversationId: activeConversationId,
    userId: req.user.id,
    messages: [...messages, { role: 'assistant', content: result.content }],
    timestamp: new Date().toISOString()
  });

  db.persistSoon();
  logAudit(req.user.id, 'CHAT_AI', config.aiProvider, 'Success');
  res.json({ ...result, conversationId: activeConversationId });
});

// Multipart chat / file inspection API
app.post('/api/chat/multipart', authenticateUser, (req, res, next) => {
  upload.array('files', 10)(req, res, async (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? 'A file exceeds the 20 MB upload limit.'
        : err.message || 'Upload failed';
      return res.status(400).json({ error: message });
    }

    try {
      const message = String(req.body?.message || 'Inspect the attached file(s) and explain what you find.').slice(0, 20000);
      const conversationId = req.body?.conversationId || crypto.randomUUID();
      const files = (req.files || []).map(file => ({
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
        buffer: file.buffer
      }));

      if (!files.length) return res.status(400).json({ error: 'At least one file is required' });

      const result = await aiService.chat(
        [{ role: 'user', content: message }],
        { userId: req.user.id, transport: 'web', conversationId },
        files
      );

      db.conversations.set(conversationId, { id: conversationId, userId: req.user.id, updatedAt: new Date().toISOString() });
      db.messages.set(crypto.randomUUID(), {
        conversationId,
        userId: req.user.id,
        messages: [{ role: 'user', content: message }, { role: 'assistant', content: result.content }],
        attachments: files.map(f => ({ name: f.originalname, type: f.mimetype, size: f.size })),
        timestamp: new Date().toISOString()
      });
      db.persistSoon();
      logAudit(req.user.id, 'CHAT_FILE_INSPECTION', config.aiProvider, 'Success');

      res.json({ ...result, conversationId, attachments: files.map(f => ({ name: f.originalname, type: f.mimetype, size: f.size })) });
    } catch (error) {
      console.error('Multipart chat error:', error);
      res.status(500).json(publicError('File inspection failed'));
    }
  });
});

// Image generation API
app.post('/api/images/generate', authenticateUser, async (req, res) => {
  const prompt = String(req.body?.prompt || '').trim();
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  const quota = imageQuota.checkAndConsume(req.user.id);
  if (!quota.allowed) return res.status(429).json({ status: 'rate_limited', error: quota.error });
  try {
    const result = await imageApi.generateImage(prompt);
    if (result.status !== 'success') return res.status(503).json(result);
    logAudit(req.user.id, 'IMAGE_GENERATE', config.imageProvider, 'Success');
    res.json(result);
  } catch (error) {
    console.error('Image API error:', error);
    res.status(500).json(publicError('Image generation failed'));
  }
});

// WhatsApp API
function normalizeWhatsAppPhone(value) {
  let raw = String(value ?? '').trim();
  if (!raw) throw new Error('phone_number required');

  // Accept +2348012345678, 2348012345678, or a local 08012345678.
  // The frontend may send countryCode + local number, so if an international
  // prefix is already present we only remove formatting characters.
  raw = raw.replace(/[^\d+]/g, '');

  if (raw.startsWith('+')) raw = raw.slice(1);

  let digits = raw.replace(/\D/g, '');

  // The web client sends country code + local input. If a caller sends a
  // purely local Nigerian number, convert 080... -> 23480...
  if (digits.startsWith('0')) {
    digits = `234${digits.slice(1)}`;
  }

  if (digits.length < 7 || digits.length > 15) {
    throw new Error('Invalid phone number. Use an international number such as 2348012345678.');
  }

  return digits;
}

app.post('/api/whatsapp/connect', authenticateUser, async (req, res) => {
  try {
    const phone_number = normalizeWhatsAppPhone(req.body?.phone_number);

    const { connectionId, session } =
      await sessionManager.createSession(req.user.id, phone_number);

    db.whatsapp_connections.set(connectionId, {
      id: connectionId,
      user_id: req.user.id,
      phone: phone_number,
      phone_number,
      status: session.status,
      pairing_error: session.pairingError || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });

    return res.json({
      connectionId,
      status: session.status,
      pairingCode: session.pairingCode || null,
      pairingError: session.pairingError || null
    });
  } catch (err) {
    console.error('WhatsApp connect error:', err?.stack || err);
    return res.status(500).json(publicError('Unable to initialize WhatsApp connection'));
  }
});

app.get('/api/whatsapp/status', authenticateUser, (req, res) => {
  try {
    const { connectionId } = req.query;

    if (connectionId) {
      const session = sessionManager.getSession(connectionId);
      const conn = db.whatsapp_connections.get(connectionId);
      if (!session || !conn || conn.user_id !== req.user.id) {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (conn) {
        conn.status = session.status;
        conn.pairing_error = session.pairingError || null;
        conn.updated_at = new Date().toISOString();
      }

      return res.json({
        status: session.status,
        pairingCode: session.pairingCode || null,
        pairingError: session.pairingError || null,
        phoneNumber: session.phoneNumber || null
      });
    }

    const userConns = Array.from(db.whatsapp_connections.values())
      .filter(c => c.user_id === req.user.id);

    return res.json({ connections: userConns });
  } catch (err) {
    console.error('WhatsApp status error:', err?.stack || err);
    return res.status(500).json(publicError('Unable to read WhatsApp status'));
  }
});

app.post('/api/whatsapp/disconnect', authenticateUser, async (req, res) => {
  try {
    const { connectionId } = req.body;
    const conn = db.whatsapp_connections.get(connectionId);

    if (!conn || conn.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await sessionManager.disconnectSession(connectionId);
    db.persistSoon();

    return res.json({
      status: 'disconnected',
      connectionId
    });
  } catch (err) {
    console.error('WhatsApp disconnect error:', err?.stack || err);
    return res.status(500).json(publicError('Unable to disconnect WhatsApp'));
  }
});

// Admin API
app.get('/api/admin/audit', authenticateUser, requireOwner, (req, res) => {
  res.json({ auditLogs: getAuditLogs(100) });
});

const PORT = config.port || 3000;
(async()=>{
  await db.init();
  app.listen(PORT, () => console.log(`AI Premium Backend v3.10.0 running on port ${PORT}`));
})().catch(err=>{ console.error('Database initialization failed:',err); process.exit(1); });
