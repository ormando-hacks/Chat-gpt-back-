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
      // Undefined (not a numeric default) avoids the well-documented
      // "Connection Closed" abort that happens while requestPairingCode
      // is in flight on cloud hosts like Render.
      defaultQueryTimeoutMs: undefined,
      keepAliveIntervalMs: 30_000
    });

    // requestPairingCode must only be called once the socket has actually
    // reached the 'connecting' state. Calling it immediately after
    // makeWASocket() (e.g. on a blind setTimeout) races the underlying
    // websocket handshake: the request can go out before WhatsApp's
    // servers are ready for it, so the code is generated but the phone
    // never receives a usable pairing session and it times out.
    this.pairingRequested = false;
    if (this.phoneNumber && !this.sock.authState.creds.registered) {
      const requestCode = async () => {
        if (this.pairingRequested) return;
        this.pairingRequested = true;
        try {
          // Small delay after reaching 'connecting' still helps in practice,
          // but the critical fix is not firing before this point at all.
          await new Promise((resolve) => setTimeout(resolve, 1500));
          const code = await this.sock.requestPairingCode(this.phoneNumber.replace(/[^0-9]/g, ''));
          this.pairingCode = code;
          console.log(`WhatsApp Pairing Code for ${this.connectionId}: ${code}`);
        } catch (err) {
          this.pairingRequested = false;
          console.error('Error requesting pairing code:', err);
        }
      };

      this.sock.ev.on('connection.update', (update) => {
        if (update.connection === 'connecting' || update.qr) {
          requestCode();
        }
      });
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
          setTimeout(() => this.start(), 5000);
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
      await this.sock.logout();
      this.sock.end(undefined);
    }
    this.status = 'disconnected';
  }
}

module.exports = WhatsAppSession;
