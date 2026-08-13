const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const P = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers
} = require('@whiskeysockets/baileys');
const useRedisAuthState = require('./redisAuthState');

/*
 * WhatsApp session adapter, ported directly from the confirmed-working
 * standalone linker (session.js in the old project), adapted to support
 * multiple concurrent users by namespacing auth state per connectionId.
 *
 * The key property carried over from the working version: start() does
 * not return until the pairing code has actually been issued by
 * WhatsApp's servers. The old fire-and-forget approach (returning
 * immediately and filling in the code later via a background timer) is
 * what let a slow/hung step anywhere in the chain surface as a
 * mysterious "Failed to fetch" on the frontend instead of a clean
 * error or a code. This version surfaces failures directly.
 */

const MAX_RECONNECT_ATTEMPTS = 6;
const USE_REDIS = true; // multi-user always persists via Upstash Redis (see redisAuthState.js) or its in-memory fallback

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
  }

  async loadAuthState() {
    return useRedisAuthState(this.connectionId);
  }

  // start() resolves only once a pairing code has been issued (or the
  // session is reusing already-registered credentials) — same contract
  // as the proven-working version, so the HTTP route can return the
  // real result directly instead of the client having to poll blind.
  async start() {
    this.status = 'connecting';
    this.pairingError = null;
    return this._connectSocket({ requestCode: true });
  }

  async _connectSocket({ requestCode }) {
    const { state: authState, saveCreds } = await this.loadAuthState();
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      logger: P({ level: 'silent' }),
      auth: authState,
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: false,
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 60_000,
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
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        const restartRequired = statusCode === DisconnectReason.restartRequired; // 515

        if (loggedOut) {
          this.status = 'disconnected';
          this.notifyConnection({ status: 'disconnected', connectionId: this.connectionId });
          return;
        }

        if (this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          this.reconnectAttempts++;
          const delay = restartRequired ? 500 : Math.min(2000 * this.reconnectAttempts, 10_000);
          this.status = 'reconnecting';
          this.notifyConnection({ status: 'reconnecting', connectionId: this.connectionId });
          setTimeout(() => {
            // Reconnects reuse saved (now-registered) credentials — never
            // request a fresh pairing code on a reconnect.
            this._connectSocket({ requestCode: false }).catch((err) => {
              console.error('[session] reconnect failed:', err?.message || err);
            });
          }, delay);
        } else {
          this.status = 'disconnected';
          this.notifyConnection({ status: 'disconnected', connectionId: this.connectionId });
        }
      }
    });

    this.sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (!msg.message) continue;
        const ownJid = this.sock.user?.id?.split(':')[0];
        const remoteBare = msg.key.remoteJid?.split(':')[0];
        const isOwnerMessage = msg.key.fromMe && ownJid && remoteBare === ownJid;
        if (msg.key.fromMe && !isOwnerMessage) continue;
        msg.isOwnerMessage = isOwnerMessage;
        this.notifyMessage(msg);
      }
    });

    if (requestCode && this.phoneNumber && !authState.creds.registered) {
      try {
        // Give the socket a moment to finish establishing its connection
        // before requesting a pairing code — requesting immediately after
        // makeWASocket() is a common cause of rejected/mismatched codes.
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

    return { status: this.status, pairingCode: null, message: 'Reusing saved session' };
  }

  onMessage(cb) { this.messageCallbacks.push(cb); }
  onConnection(cb) { this.connectionCallbacks.push(cb); }
  notifyMessage(msg) { for (const cb of this.messageCallbacks) cb(msg, this); }
  notifyConnection(event) { for (const cb of this.connectionCallbacks) cb(event, this); }

  async sendMessage(jid, text) {
    if (!this.sock) throw new Error('WhatsApp socket not initialized');
    return await this.sock.sendMessage(jid, { text });
  }

  async disconnect() {
    this.reconnectAttempts = MAX_RECONNECT_ATTEMPTS; // block any in-flight reconnect timer
    if (this.sock) {
      // Bounded — a hung logout() must never be able to block the caller
      // (e.g. sessionManager cleaning up a prior stale attempt before
      // starting a new one). That exact hang is what previously made
      // /whatsapp/connect appear as "Failed to fetch".
      await Promise.race([
        (async () => {
          try { await this.sock.logout(); } catch (_) { /* not authenticated yet */ }
        })(),
        new Promise((resolve) => setTimeout(resolve, 4000))
      ]);
      try { this.sock.end(undefined); } catch (_) { /* already closed */ }
    }
    this.status = 'disconnected';
  }
}

module.exports = WhatsAppSession;
