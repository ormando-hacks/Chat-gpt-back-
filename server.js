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
function safeSecretEqual(a,b){ if(!a || !b) return false; const aa=Buffer.from(a); const bb=Buffer.from(b); return aa.length===bb.length && crypto.timingSafeEqual(aa,bb); }
function masterRateLimited(ip){ const now=Date.now(); const x=masterAttempts.get(ip)||{count:0,reset:now+15*60*1000}; if(now>x.reset){x.count=0;x.reset=now+15*60*1000;} return x.count>=10; }
function recordMasterFailure(ip){ const now=Date.now(); const x=masterAttempts.get(ip)||{count:0,reset:now+15*60*1000}; if(now>x.reset){x.count=0;x.reset=now+15*60*1000;} x.count++; masterAttempts.set(ip,x); }
app.use(cors());
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
  const { userId, credential } = req.body;
  const user = db.users.get(userId);
  
  if (!user) return res.status(404).json({ error: 'User not found' });

  // P0 Fix: Verify master secret from environment, do not allow hard-coded fallbacks
  if (credential && !masterRateLimited(req.ip) && safeSecretEqual(credential, config.masterAdminSecret)) {
    user.role = 'owner';
    user.permissions = ['all'];
    db.persistSoon();
    logAudit(userId, 'LINK_MASTER_ADMIN', userId, 'Success');
  }

  if (credential && !(safeSecretEqual(credential, config.masterAdminSecret))) recordMasterFailure(req.ip);
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
      res.status(500).json({ error: 'File inspection failed', details: error.message });
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
    res.status(500).json({ error: 'Image generation failed', details: error.message });
  }
});

// WhatsApp API
app.post('/api/whatsapp/connect', authenticateUser, async (req, res) => {
  const { phone_number } = req.body;
  if (!phone_number) return res.status(400).json({ error: 'phone_number required' });

  const { connectionId, session } = await sessionManager.createSession(req.user.id, phone_number);
  
  // Persist connection metadata
  db.whatsapp_connections.set(connectionId, {
    id: connectionId,
    user_id: req.user.id,
    phone: phone_number,
    status: session.status,
    created_at: new Date().toISOString()
  });

  res.json({ connectionId, status: session.status });
});

app.get('/api/whatsapp/status', authenticateUser, (req, res) => {
  const { connectionId } = req.query;
  if (connectionId) {
    const session = sessionManager.getSession(connectionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    
    // Update status from live session
    const conn = db.whatsapp_connections.get(connectionId);
    if (conn) conn.status = session.status;

    return res.json({ status: session.status, pairingCode: session.pairingCode });
  }
  
  const userConns = Array.from(db.whatsapp_connections.values())
    .filter(c => c.user_id === req.user.id);
  res.json({ connections: userConns });
});

app.post('/api/whatsapp/disconnect', authenticateUser, async (req, res) => {
  const { connectionId } = req.body;
  const conn = db.whatsapp_connections.get(connectionId);
  if (!conn || conn.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  await sessionManager.disconnectSession(connectionId);
  db.persistSoon();
  res.json({ status: 'disconnected', connectionId });
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
