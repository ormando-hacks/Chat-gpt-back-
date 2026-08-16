const EventEmitter = require('events');
const P = require('pino');
const {
  default: makeWASocket,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers
} = require('@whiskeysockets/baileys');
const useRedisAuthState = require('./redisAuthState');
const { clearAuthState } = require('./redisAuthState');

const MAX_RECONNECT_DELAY_MS = 30_000;

function extractText(message) {
  return (
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
    null
  );
}

class WhatsAppSession extends EventEmitter {
  constructor(connectionId, phoneNumber = null) {
    super();
    this.connectionId = connectionId;
    this.phoneNumber = phoneNumber;
    this.sock = null;
    this.status = 'disconnected';
    this.pairingCode = null;
    this.pairingError = null;
    this.qr = null;
    this.reconnectAttempts = 0;
    this.messageCallbacks = [];
    this.connectionCallbacks = [];
    this.manualDisconnect = false;
    this.reconnectTimer = null;
    this.connectPromise = null;
  }

  async loadAuthState() {
    return useRedisAuthState(this.connectionId);
  }

  async start({ requestCode = true } = {}) {
    this.manualDisconnect = false;
    this.status = 'connecting';
    this.pairingError = null;

    // Avoid opening two sockets for the same persisted session.
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this._connectSocket({ requestCode })
      .finally(() => { this.connectPromise = null; });
    return this.connectPromise;
  }

  async _connectSocket({ requestCode }) {
    const { state: authState, saveCreds } = await this.loadAuthState();
    const { version } = await fetchLatestBaileysVersion();

    if (this.sock) {
      try { this.sock.end(undefined); } catch (_) {}
    }

    this.sock = makeWASocket({
      version,
      logger: P({ level: 'silent' }),
      auth: authState,
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: false,
      connectTimeoutMs: 120_000,
      defaultQueryTimeoutMs: 120_000,
      keepAliveIntervalMs: 25_000,
      retryRequestDelayMs: 5_000
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) this.qr = qr;

      if (connection === 'open') {
        this.reconnectAttempts = 0;
        this.status = 'connected';
        this.pairingCode = null;
        this.pairingError = null;
        this.notifyConnection({ status: 'connected', connectionId: this.connectionId });
        return;
      }

      if (connection !== 'close') return;

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (this.manualDisconnect || loggedOut) {
        this.status = 'disconnected';
        this.notifyConnection({ status: 'disconnected', connectionId: this.connectionId });
        if (loggedOut && !this.manualDisconnect) {
          clearAuthState(this.connectionId).catch(err =>
            console.error('[session] failed to clear logged-out auth:', err?.message || err)
          );
        }
        return;
      }

      // Keep the WhatsApp session alive until the user explicitly disconnects.
      // Temporary network/server failures therefore do not invalidate the
      // user's saved credentials after six attempts.
      this.reconnectAttempts += 1;
      const delay = Math.min(
        1000 * Math.pow(2, Math.min(this.reconnectAttempts - 1, 5)),
        MAX_RECONNECT_DELAY_MS
      );
      this.status = 'reconnecting';
      this.notifyConnection({ status: 'reconnecting', connectionId: this.connectionId });

      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        this._connectSocket({ requestCode: false }).catch((err) => {
          console.error('[session] reconnect failed:', err?.message || err);
        });
      }, delay);
    });

    this.sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (!msg.message) continue;

        // Baileys sets fromMe for messages sent by the linked account,
        // including messages sent by the owner inside groups.
        msg.isOwnerMessage = !!msg.key.fromMe;
        msg.messageText = extractText(msg.message);
        this.notifyMessage(msg);
      }
    });

    if (requestCode && this.phoneNumber && !authState.creds.registered) {
      try {
        // Do not impose a short HTTP-style timeout on WhatsApp pairing.
        // The caller can poll /api/whatsapp/status while WhatsApp finishes.
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const digits = this.phoneNumber.replace(/\D/g, '');
        const code = await this.sock.requestPairingCode(digits);
        this.pairingCode = code;
        this.pairingError = null;
        console.log(`[session] pairing code issued for ${this.connectionId}: ${code}`);
        return { status: this.status, pairingCode: code };
      } catch (err) {
        this.pairingError = err?.message || 'Failed to request pairing code';
        console.error('[session] error requesting pairing code:', err?.stack || err);
        return { status: this.status, pairingCode: null, pairingError: this.pairingError };
      }
    }

    return {
      status: this.status,
      pairingCode: null,
      message: authState.creds.registered ? 'Reusing saved session' : 'Waiting for pairing'
    };
  }

  onMessage(cb) { this.messageCallbacks.push(cb); }
  onConnection(cb) { this.connectionCallbacks.push(cb); }
  notifyMessage(msg) { for (const cb of this.messageCallbacks) cb(msg, this); }
  notifyConnection(event) { for (const cb of this.connectionCallbacks) cb(event, this); }

  async sendMessage(jid, text) {
    if (!this.sock) throw new Error('WhatsApp socket not initialized');
    if (this.status !== 'connected') throw new Error('WhatsApp is not connected');
    return await this.sock.sendMessage(jid, { text });
  }

  async disconnect() {
    this.manualDisconnect = true;
    this.reconnectAttempts = Number.MAX_SAFE_INTEGER;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    if (this.sock) {
      try { await this.sock.logout(); } catch (_) {}
      try { this.sock.end(undefined); } catch (_) {}
    }

    // Explicit disconnect means the credentials must not be silently reused
    // on a later backend restart.
    try { await clearAuthState(this.connectionId); } catch (err) {
      console.error('[session] failed to clear saved auth:', err?.message || err);
    }

    this.status = 'disconnected';
    this.notifyConnection({ status: 'disconnected', connectionId: this.connectionId });
  }
}

module.exports = WhatsAppSession;
