const db = require('./database');
const WhatsAppSession = require('./session');
const { v4: uuidv4 } = require('uuid');

class WhatsAppSessionManager {
  constructor() {
    this.sessions = new Map();
    this.createLocks = new Map();
    this.restorePromise = Promise.resolve();
  }

  _connectionRecord(connectionId) {
    return db.whatsapp_connections.get(connectionId);
  }

  _bindUser(userId, connectionId) {
    const user = db.users.get(userId);
    if (!user) return;
    user.whatsapp_connection_id = connectionId;
    user.whatsappConnectionId = connectionId;
    db.users.set(userId, user);
  }

  _clearUserBinding(userId, connectionId) {
    const user = db.users.get(userId);
    if (!user) return;
    if (user.whatsapp_connection_id === connectionId || user.whatsappConnectionId === connectionId) {
      delete user.whatsapp_connection_id;
      delete user.whatsappConnectionId;
      db.users.set(userId, user);
    }
  }

  _attachSession(session, userId, connectionId) {
    session.onMessage(async (msg, sess) => {
      const messageRouter = require('./messageRouter');
      try {
        await messageRouter.handleWhatsAppMessage(msg, sess, userId, connectionId);
      } catch (err) {
        console.error('[sessionManager] WhatsApp message handler failed:', err?.stack || err);
      }
    });

    session.onConnection((event, sess) => {
      const conn = this._connectionRecord(connectionId);
      if (conn) {
        conn.status = event.status || sess.status;
        conn.pairing_error = sess.pairingError || null;
        conn.updated_at = new Date().toISOString();
        conn.last_seen_at = new Date().toISOString();
        db.whatsapp_connections.set(connectionId, conn);
        if (conn.status === 'connected' || conn.status === 'reconnecting' || conn.status === 'connecting') {
          this._bindUser(userId, connectionId);
        }
        db.persistSoon();
      }
    });

    this.sessions.set(connectionId, session);
  }

  async createSession(userId, phoneNumber) {
    await this.restorePromise;
    if (this.createLocks.has(userId)) return this.createLocks.get(userId);

    const createPromise = this._createSession(userId, phoneNumber);
    this.createLocks.set(userId, createPromise);
    try {
      return await createPromise;
    } finally {
      this.createLocks.delete(userId);
    }
  }

  async _createSession(userId, phoneNumber) {
    // One durable WhatsApp session per AI account. Reuse it instead of
    // creating a new connectionId every time the user opens the linker.
    const user = db.users.get(userId);
    const existingId = user?.whatsapp_connection_id || user?.whatsappConnectionId;
    const existingOwned = Array.from(this.sessions.entries()).find(([id]) => {
      const conn = this._connectionRecord(id);
      return conn?.user_id === userId;
    });
    const reusableId = existingId || existingOwned?.[0];
    if (reusableId) {
      const existingConn = db.whatsapp_connections.get(reusableId);
      const existingSession = this.sessions.get(reusableId);
      if (existingConn && existingSession && existingSession.status !== 'disconnected') {
        this._bindUser(userId, reusableId);
        return { connectionId: reusableId, session: existingSession, result: {
          status: existingSession.status,
          pairingCode: existingSession.pairingCode,
          message: existingSession.status === 'connected' ? 'Existing WhatsApp session is already connected' : 'Existing WhatsApp session is still connecting'
        }};
      }
    }

    // Clean up any non-connected stale sessions belonging to this account.
    const staleIds = [];
    for (const [id, sess] of this.sessions.entries()) {
      const conn = this._connectionRecord(id);
      if (conn && conn.user_id === userId && sess.status !== 'connected') staleIds.push(id);
    }
    await Promise.allSettled(staleIds.map((id) => this.disconnectSession(id)));

    const connectionId = uuidv4();
    const session = new WhatsAppSession(connectionId, phoneNumber);

    db.whatsapp_connections.set(connectionId, {
      id: connectionId,
      user_id: userId,
      phone: phoneNumber,
      phone_number: phoneNumber,
      status: 'connecting',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      persistent: true
    });
    this._bindUser(userId, connectionId);
    this._attachSession(session, userId, connectionId);
    db.persistSoon();

    // Give fast pairings their code in the initial response, but never turn a
    // slow WhatsApp handshake into a timeout error. The session keeps running
    // in the background and /api/whatsapp/status will expose the code later.
    const startPromise = session.start({ requestCode: true });
    const result = await Promise.race([
      startPromise,
      new Promise(resolve => setTimeout(() => resolve({
        status: session.status,
        pairingCode: session.pairingCode || null,
        message: 'WhatsApp is still connecting; poll /api/whatsapp/status for the pairing code.'
      }), 12_000))
    ]);
    return { connectionId, session, result };
  }

  async restorePersistedSessions() {
    this.restorePromise = (async () => {
      const records = Array.from(db.whatsapp_connections.values())
      .filter(conn => conn && conn.user_id && conn.status !== 'disconnected' && (conn.persistent !== false));

      for (const conn of records) {
        if (this.sessions.has(conn.id)) continue;
        const session = new WhatsAppSession(conn.id, conn.phone_number || conn.phone || null);
        this._attachSession(session, conn.user_id, conn.id);
        this._bindUser(conn.user_id, conn.id);

        // Do not request a new pairing code after a restart. Saved Baileys
        // credentials in Redis are the source of truth.
        session.start({ requestCode: false }).catch(err => {
          console.error(`[sessionManager] restore failed for ${conn.id}:`, err?.message || err);
        });
      }
    })();
    return this.restorePromise;
  }

  getSession(connectionId) {
    return this.sessions.get(connectionId);
  }

  getConnectionForUser(userId, requestedConnectionId = null) {
    if (requestedConnectionId) {
      const conn = db.whatsapp_connections.get(requestedConnectionId);
      if (!conn || conn.user_id !== userId) throw new Error('Unauthorized or connection not found');
      return requestedConnectionId;
    }

    const user = db.users.get(userId);
    const preferred = user?.whatsapp_connection_id || user?.whatsappConnectionId;
    if (preferred) {
      const conn = db.whatsapp_connections.get(preferred);
      if (conn && conn.user_id === userId && conn.status !== 'disconnected') return preferred;
    }

    const active = Array.from(db.whatsapp_connections.values())
      .find(c => c.user_id === userId && c.status !== 'disconnected');
    if (active) {
      this._bindUser(userId, active.id);
      return active.id;
    }

    throw new Error('No active WhatsApp connection for this account');
  }

  async disconnectSession(connectionId) {
    const session = this.sessions.get(connectionId);
    const conn = this._connectionRecord(connectionId);

    if (session) {
      await session.disconnect();
      this.sessions.delete(connectionId);
    }

    if (conn) {
      conn.status = 'disconnected';
      conn.pairing_error = null;
      conn.disconnected_at = new Date().toISOString();
      conn.updated_at = new Date().toISOString();
      db.whatsapp_connections.set(connectionId, conn);
      this._clearUserBinding(conn.user_id, connectionId);
      db.persistSoon();
    }
  }

  listSessions(userId) {
    const results = [];
    const connections = Array.from(db.whatsapp_connections.values())
      .filter(conn => !userId || conn.user_id === userId);

    for (const conn of connections) {
      const sess = this.sessions.get(conn.id);
      results.push({
        connectionId: conn.id,
        phoneNumber: sess?.phoneNumber || conn.phone_number || conn.phone || null,
        status: sess?.status || conn.status || 'disconnected',
        pairingCode: sess?.pairingCode || null,
        pairingError: sess?.pairingError || conn.pairing_error || null,
        persistent: conn.persistent !== false,
        updatedAt: conn.updated_at || null
      });
    }
    return results;
  }
}

module.exports = new WhatsAppSessionManager();
