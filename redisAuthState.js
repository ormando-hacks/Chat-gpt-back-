const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
const config = require('./config');

/*
 * Stores the full Baileys auth state (creds + signal keys) as one JSON blob
 * per connection, via Upstash Redis's REST API. This is what makes
 * WhatsApp pairing survive the automatic reconnect that always happens
 * right after a pairing code is accepted (515 "restart required"), and
 * what makes login survive Render's ephemeral filesystem / free-tier
 * spin-downs.
 *
 * Requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (free tier
 * at upstash.com — no credit card required).
 *
 * If those are not set, this falls back to a process-level in-memory
 * store (persistent for the lifetime of the running server, but lost on
 * restart/redeploy). Unlike the previous implementation, this fallback
 * store is created ONCE per connection and reused across reconnects
 * within the same process, instead of being wiped on every call.
 */

const REDIS_URL = config.upstashRedisUrl;
const REDIS_TOKEN = config.upstashRedisToken;

async function redisGet(key) {
  const res = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
  if (!res.ok) throw new Error(`Upstash GET failed: ${res.status}`);
  const data = await res.json();
  return data.result || null;
}

async function redisSet(key, value) {
  const res = await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'text/plain' },
    body: value
  });
  if (!res.ok) throw new Error(`Upstash SET failed: ${res.status}`);
}


async function redisDelete(key) {
  const res = await fetch(`${REDIS_URL}/del/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
  if (!res.ok) throw new Error(`Upstash DEL failed: ${res.status}`);
}

// Process-level fallback store, keyed by connection namespace, so it
// survives reconnects even without Upstash configured.
const memoryStores = new Map();
function getMemoryStore(namespace) {
  if (!memoryStores.has(namespace)) memoryStores.set(namespace, new Map());
  return memoryStores.get(namespace);
}

async function useRedisAuthState(connectionNamespace = 'default') {
  const useUpstash = Boolean(REDIS_URL && REDIS_TOKEN);
  const redisKey = `whatsapp:auth:${connectionNamespace}`;

  let creds;
  let keys;

  if (useUpstash) {
    const raw = await redisGet(redisKey);
    const stored = raw ? JSON.parse(raw, BufferJSON.reviver) : null;
    creds = stored?.creds || initAuthCreds();
    keys = stored?.keys || {};
  } else {
    const store = getMemoryStore(connectionNamespace);
    creds = store.get('creds') || initAuthCreds();
    keys = store.get('keys') || {};
  }

  let saving = false;
  let pending = false;

  async function persist() {
    if (saving) { pending = true; return; }
    saving = true;
    try {
      if (useUpstash) {
        const payload = JSON.stringify({ creds, keys }, BufferJSON.replacer);
        await redisSet(redisKey, payload);
      } else {
        const store = getMemoryStore(connectionNamespace);
        store.set('creds', creds);
        store.set('keys', keys);
      }
    } finally {
      saving = false;
      if (pending) { pending = false; await persist(); }
    }
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            let value = keys[type]?.[id];
            if (value) {
              if (type === 'app-state-sync-key') {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            }
          }
          return data;
        },
        set: async (data) => {
          for (const type in data) {
            keys[type] = keys[type] || {};
            for (const id in data[type]) {
              const value = data[type][id];
              if (value) keys[type][id] = value;
              else delete keys[type][id];
            }
          }
          await persist();
        }
      }
    },
    saveCreds: persist
  };
}

async function clearAuthState(connectionNamespace = 'default') {
  const useUpstash = Boolean(REDIS_URL && REDIS_TOKEN);
  const redisKey = `whatsapp:auth:${connectionNamespace}`;
  if (useUpstash) {
    await redisDelete(redisKey);
    return;
  }
  memoryStores.delete(connectionNamespace);
}

module.exports = useRedisAuthState;
module.exports.clearAuthState = clearAuthState;
