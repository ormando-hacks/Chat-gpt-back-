const WhatsAppSession = require('./session');
const db = require('./database');
const { v4: uuidv4 } = require('uuid');

class WhatsAppSessionManager {
  constructor() {
    this.sessions = new Map();
  }

  async createSession(userId, phoneNumber) {
    const connectionId = uuidv4();
    const session = new WhatsAppSession(connectionId, phoneNumber);
    
    session.onMessage(async (msg, sess) => {
      // Import message router dynamically to avoid circular dependency
      const messageRouter = require('./messageRouter');
      await messageRouter.handleWhatsAppMessage(msg, sess, userId, connectionId);
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
