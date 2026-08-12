const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, Browsers } = require('@whiskeysockets/baileys');
const P = require('pino');
const useRedisAuthState = require('./redisAuthState');

class WhatsAppSession {
  constructor(connectionId, phoneNumber = null) {
    this.connectionId = connectionId;
    this.phoneNumber = phoneNumber;
    this.sock = null;
    this.status = 'disconnected';
    this.pairingCode = null;
    this.qr = null;
    this.messageCallbacks = [];
    this.connectionCallbacks = [];
  }

  async start() {
    this.status = 'connecting';
    const { state, saveCreds } = await useRedisAuthState(this.connectionId);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      logger: P({ level: 'silent' }),
      auth: state,
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: false,
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 60_000,
      keepAliveIntervalMs: 25_000,
      retryRequestDelayMs: 5_000
    });

    // Matches the timing of the known-working standalone linker: request
    // the pairing code directly, a fixed delay after socket creation,
    // rather than waiting on a 'connecting'/qr connection.update event.
    // On Render the update event isn't always reliable timing-wise, and
    // requesting too early/late is what produces a code WhatsApp later
    // rejects as "not matching" when entered on the phone.
    this.pairingRequested = false;
    if (this.phoneNumber && !this.sock.authState.creds.registered) {
      (async () => {
        if (this.pairingRequested) return;
        this.pairingRequested = true;
        try {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          const digits = this.phoneNumber.replace(/[^0-9]/g, '');
          const code = await this.sock.requestPairingCode(digits);
          this.pairingCode = code;
          console.log(`WhatsApp Pairing Code for ${this.connectionId}: ${code}`);
        } catch (err) {
          this.pairingRequested = false;
          console.error('Error requesting pairing code:', err);
        }
      })();
    }

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        this.qr = qr;
      }
      if (connection === 'open') {
        this.status = 'connected';
        this.pairingCode = null;
        this.notifyConnection({ status: 'connected', connectionId: this.connectionId });
      } else if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
        this.status = shouldReconnect ? 'reconnecting' : 'disconnected';
        this.notifyConnection({ status: this.status, connectionId: this.connectionId });
        if (shouldReconnect) {
          // 515 "restart required" is WhatsApp's normal signal right after
          // a pairing code is accepted — reconnect quickly. Any other
          // non-logout close still gets a bounded retry.
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const delay = statusCode === 515 ? 500 : 5000;
          setTimeout(() => this.start(), delay);
        }
      }
    });

    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type === 'notify') {
        for (const msg of messages) {
          if (!msg.message) continue;
          // Bare JID (strip the :device suffix Baileys appends) of the
          // account this socket is logged in as.
          const ownJid = this.sock.user?.id?.split(':')[0];
          const remoteBare = msg.key.remoteJid?.split(':')[0];
          // Note-to-Self: the owner messaging their own number. This is the
          // only fromMe traffic that is provably the account owner, since it
          // requires control of the actual linked WhatsApp account/device.
          const isOwnerMessage = msg.key.fromMe && ownJid && remoteBare === ownJid;
          if (msg.key.fromMe && !isOwnerMessage) continue; // ignore the bot's own other outgoing messages
          msg.isOwnerMessage = isOwnerMessage;
          this.notifyMessage(msg);
        }
      }
    });
  }

  onMessage(cb) {
    this.messageCallbacks.push(cb);
  }

  onConnection(cb) {
    this.connectionCallbacks.push(cb);
  }

  notifyMessage(msg) {
    for (const cb of this.messageCallbacks) {
      cb(msg, this);
    }
  }

  notifyConnection(event) {
    for (const cb of this.connectionCallbacks) {
      cb(event, this);
    }
  }

  async sendMessage(jid, text) {
    if (!this.sock) throw new Error('WhatsApp socket not initialized');
    return await this.sock.sendMessage(jid, { text });
  }

  async disconnect() {
    if (this.sock) {
      try { await this.sock.logout(); } catch (_) { /* not authenticated yet — nothing to log out of */ }
      try { this.sock.end(undefined); } catch (_) { /* already closed */ }
    }
    this.status = 'disconnected';
  }
}

module.exports = WhatsAppSession;
