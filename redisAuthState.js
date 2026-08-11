const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
const Redis = require('ioredis');
const config = require('./config');

async function useRedisAuthState(connectionNamespace = 'default') {
  let redis;
  if (config.redisUrl) {
    redis = new Redis(config.redisUrl);
  } else {
    // Fallback in-memory mock client if Redis is not configured
    const store = new Map();
    redis = {
      get: async (key) => store.get(key) || null,
      set: async (key, val) => store.set(key, val),
      del: async (key) => store.delete(key)
    };
  }

  const prefix = `whatsapp:auth:${connectionNamespace}:`;

  const writeData = async (data, id) => {
    const json = JSON.stringify(data, BufferJSON.replacer);
    await redis.set(prefix + id, json);
  };

  const readData = async (id) => {
    try {
      const data = await redis.get(prefix + id);
      return data ? JSON.parse(data, BufferJSON.reviver) : null;
    } catch (error) {
      return null;
    }
  };

  const removeData = async (id) => {
    try {
      await redis.del(prefix + id);
    } catch (error) {}
  };

  const creds = (await readData('creds')) || (initAuthCreds());

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            let value = await readData(`${type}-${id}`);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              if (value) {
                tasks.push(writeData(value, key));
              } else {
                tasks.push(removeData(key));
              }
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: async () => {
      await writeData(creds, 'creds');
    }
  };
}

module.exports = useRedisAuthState;
