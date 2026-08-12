const db = require('./database');
const WhatsAppSession = require('./session');
const { v4: uuidv4 } = require('uuid');

class WhatsAppSessionManager {
  constructor() {
    this.sessions = new Map();
  }

  async createSession(userId, phoneNumber) {
    // Close out any of this user's still-connecting/reconnecting sessions
    // before starting a new one. Without this, retapping "Get pairing
    // code" spins up a second live socket requesting a code for the same
    // number while the first is still active — WhatsApp then rejects
    // whichever code the phone is given as not matching.
    for (const [id, sess] of this.sessions.entries()) {
      const conn = db.whatsapp_connections.get(id);
      if (conn && conn.user_id === userId && sess.status !== 'connected') {
        await this.disconnectSession(id);
      }
    }

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

    await session.start();
    return { connectionId, session };
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
