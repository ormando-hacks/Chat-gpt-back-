const db = require('./database');
const WhatsAppSession = require('./session');
const { v4: uuidv4 } = require('uuid');

class WhatsAppSessionManager {
  constructor() {
    this.sessions = new Map();
  }

  async createSession(userId, phoneNumber) {
    // Close out any of this user's still-connecting/reconnecting sessions
    // before starting a new one, so WhatsApp never gets two competing
    // pairing requests for the same number. This cleanup is now bounded
    // (disconnect() itself has a hard timeout) and never allowed to
    // block this request — a stale socket that won't close gracefully
    // just gets abandoned rather than hanging the whole /connect call.
    const staleIds = [];
    for (const [id, sess] of this.sessions.entries()) {
      const conn = db.whatsapp_connections.get(id);
      if (conn && conn.user_id === userId && sess.status !== 'connected') {
        staleIds.push(id);
      }
    }
    await Promise.allSettled(staleIds.map((id) => this.disconnectSession(id)));

    const connectionId = uuidv4();
    const session = new WhatsAppSession(connectionId, phoneNumber);

    session.onMessage(async (msg, sess) => {
      // Import message router dynamically to avoid circular dependency
      const messageRouter = require('./messageRouter');
      await messageRouter.handleWhatsAppMessage(msg, sess, userId, connectionId);
    });

    session.onConnection((event, sess) => {
      const conn = db.whatsapp_connections.get(connectionId);
      if (conn) {
        conn.status = event.status || sess.status;
        conn.pairing_error = sess.pairingError || null;
        conn.updated_at = new Date().toISOString();
        db.persistSoon();
      }
    });

    this.sessions.set(connectionId, session);
    db.persistSoon();

    // Save connection in database
    db.whatsapp_connections.set(connectionId, {
      id: connectionId,
      user_id: userId,
      phone_number: phoneNumber,
      status: 'connecting',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });

    // start() now resolves only once the pairing code has actually been
    // issued (or a clear error), matching the confirmed-working project's
    // behavior — so the caller gets a real result immediately instead of
    // having to poll blind. Still bounded so a hang anywhere in the chain
    // (auth load, version fetch, socket handshake) can't hold the HTTP
    // request open indefinitely.
    const result = await Promise.race([
      session.start(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('WhatsApp connection timed out — please try again')), 25_000))
    ]);

    return { connectionId, session, result };
  }

  getSession(connectionId) {
    return this.sessions.get(connectionId);
  }

  async disconnectSession(connectionId) {
    const session = this.sessions.get(connectionId);
    if (session) {
      await session.disconnect();
      this.sessions.delete(connectionId);
      const conn = db.whatsapp_connections.get(connectionId);
      if (conn) {
        conn.status = 'disconnected';
        conn.updated_at = new Date().toISOString();
        db.persistSoon();
      }
    }
  }

  listSessions(userId) {
    const results = [];
    for (const [id, sess] of this.sessions.entries()) {
      const conn = db.whatsapp_connections.get(id);
      if (!userId || (conn && conn.user_id === userId)) {
        results.push({
          connectionId: id,
          phoneNumber: sess.phoneNumber,
          status: sess.status,
          pairingCode: sess.pairingCode
        });
      }
    }
    return results;
  }
}

module.exports = new WhatsAppSessionManager();
