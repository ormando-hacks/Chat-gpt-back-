const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers
} = require('@whiskeysockets/baileys');
const P = require('pino');
const useRedisAuthState = require('./redisAuthState');

function normalizePhoneNumber(value) {
  let digits = String(value ?? '').replace(/\D/g, '');
  // The API accepts an international number (preferred) or a local number
  // only when the caller also supplies a country code. The server normalizes
  // the final value before constructing this session.
  if (digits.length < 7 || digits.length > 15) {
    throw new Error('Invalid phone number. Use an international number such as 2348012345678.');
  }
  return digits;
}

function getDisconnectCode(lastDisconnect) {
  return lastDisconnect?.error?.output?.statusCode
    ?? lastDisconnect?.error?.data?.statusCode
    ?? lastDisconnect?.error?.statusCode
    ?? null;
}

class WhatsAppSession {
  constructor(connectionId, phoneNumber = null) {
    this.connectionId = connectionId;
    this.phoneNumber = phoneNumber;
    this.sock = null;
    this.status = 'disconnected';
    this.pairingCode = null;
    this.pairingError = null;
    this.qr = null;
    this.messageCallbacks = [];
    this.connectionCallbacks = [];
    this.pairingRequested = false;
    this.pairingRequestInFlight = null;
    this.startInFlight = null;
    this.reconnectTimer = null;
    this.stopped = false;
  }

  async start() {
    if (this.stopped) return;
    if (this.startInFlight) return this.startInFlight;

    this.startInFlight = this._start();
    try {
      return await this.startInFlight;
    } finally {
      this.startInFlight = null;
    }
  }

  async _start() {
    this.status = 'connecting';
    this.pairingError = null;

    const { state, saveCreds } = await useRedisAuthState(this.connectionId);
    const { version } = await fetchLatestBaileysVersion();

    if (this.sock) {
      try { this.sock.end(undefined); } catch (_) {}
    }

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

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', (update) => {
      this.handleConnectionUpdate(update).catch((err) => {
        this.pairingError = err?.message || String(err);
        console.error(`[WhatsApp ${this.connectionId}] connection.update handler failed:`, err?.stack || err);
      });
    });

    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg.message) continue;

        const ownJid = this.sock?.user?.id?.split(':')[0];
        const remoteBare = msg.key.remoteJid?.split(':')[0];
        const isOwnerMessage = msg.key.fromMe && ownJid && remoteBare === ownJid;

        if (msg.key.fromMe && !isOwnerMessage) continue;

        msg.isOwnerMessage = isOwnerMessage;
        this.notifyMessage(msg);
      }
    });

    // If credentials are already registered, this session reconnects normally.
    // Otherwise the pairing request is triggered from connection.update after
    // the socket has actually begun its handshake.
    if (state.creds.registered) {
      this.status = 'connecting';
    }

    return this;
  }

  async handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr } = update;

    if (qr) this.qr = qr;

    if (connection === 'open') {
      this.status = 'connected';
      this.pairingCode = null;
      this.pairingError = null;
      this.pairingRequested = false;
      this.notifyConnection({
        status: 'connected',
        connectionId: this.connectionId
      });
      return;
    }

    if (connection === 'close') {
      const statusCode = getDisconnectCode(lastDisconnect);
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut || this.stopped) {
        this.status = 'disconnected';
        this.notifyConnection({
          status: 'disconnected',
          connectionId: this.connectionId,
          error: this.pairingError
        });
        return;
      }

      this.status = 'reconnecting';
      this.notifyConnection({
        status: 'reconnecting',
        connectionId: this.connectionId,
        disconnectCode: statusCode,
        error: this.pairingError
      });

      // A 515 is expected during Baileys' post-pairing restart.
      const delay = statusCode === 515 ? 500 : 5000;
      this.scheduleReconnect(delay);
      return;
    }

    // Baileys has established enough of the socket lifecycle to safely ask
    // for a pairing code. Do this only once per socket.
    if (
      connection === 'connecting' &&
      this.phoneNumber &&
      this.sock &&
      !this.sock.authState?.creds?.registered
    ) {
      await this.requestPairingCodeWhenReady();
    }
  }

  async requestPairingCodeWhenReady() {
    if (this.pairingRequested || this.pairingRequestInFlight || this.stopped) {
      return this.pairingRequestInFlight;
    }

    this.pairingRequestInFlight = (async () => {
      this.pairingRequested = true;
      this.pairingError = null;

      try {
        const digits = normalizePhoneNumber(this.phoneNumber);

        // Give the socket a bounded amount of time to initialize its transport.
        // Unlike the old fixed 5-second delay, retryPairing checks the live
        // socket and stops immediately if credentials become registered.
        let lastError = null;

        for (let attempt = 1; attempt <= 6; attempt++) {
          if (this.stopped || !this.sock) return;
          if (this.sock.authState?.creds?.registered) return;

          try {
            const code = await this.sock.requestPairingCode(digits);

            if (!code) throw new Error('WhatsApp returned an empty pairing code.');

            this.pairingCode =
              String(code).match(/.{1,4}/g)?.join('-') || String(code);
            this.pairingError = null;

            console.log(
              `[WhatsApp ${this.connectionId}] Pairing code generated: ${this.pairingCode}`
            );
            return;
          } catch (err) {
            lastError = err;
            console.error(
              `[WhatsApp ${this.connectionId}] pairing attempt ${attempt} failed:`,
              err?.stack || err
            );

            if (attempt < 6) {
              await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
            }
          }
        }

        throw lastError || new Error('Unable to request WhatsApp pairing code.');
      } catch (err) {
        this.pairingCode = null;
        this.pairingError = err?.message || String(err);
        console.error(
          `[WhatsApp ${this.connectionId}] pairing failed:`,
          err?.stack || err
        );
      } finally {
        this.pairingRequested = false;
        this.pairingRequestInFlight = null;
      }
    })();

    return this.pairingRequestInFlight;
  }

  scheduleReconnect(delay) {
    if (this.reconnectTimer || this.stopped) return;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.start();
      } catch (err) {
        this.pairingError = err?.message || String(err);
        console.error(
          `[WhatsApp ${this.connectionId}] reconnect failed:`,
          err?.stack || err
        );
      }
    }, delay);
  }

  onMessage(cb) {
    this.messageCallbacks.push(cb);
  }

  onConnection(cb) {
    this.connectionCallbacks.push(cb);
  }

  notifyMessage(msg) {
    for (const cb of this.messageCallbacks) {
      try { cb(msg, this); } catch (err) {
        console.error(`[WhatsApp ${this.connectionId}] message callback failed:`, err);
      }
    }
  }

  notifyConnection(event) {
    for (const cb of this.connectionCallbacks) {
      try { cb(event, this); } catch (err) {
        console.error(`[WhatsApp ${this.connectionId}] connection callback failed:`, err);
      }
    }
  }

  async sendMessage(jid, text) {
    if (!this.sock) throw new Error('WhatsApp socket not initialized');
    if (this.status !== 'connected') throw new Error('WhatsApp is not connected');
    return this.sock.sendMessage(jid, { text });
  }

  async disconnect() {
    this.stopped = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.sock) {
      try {
        if (this.sock.authState?.creds?.registered) {
          await this.sock.logout();
        }
      } catch (_) {}

      try { this.sock.end(undefined); } catch (_) {}
    }

    this.status = 'disconnected';
    this.pairingCode = null;
  }
}

module.exports = WhatsAppSession;
