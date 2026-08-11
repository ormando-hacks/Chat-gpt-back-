const fs = require('fs');
const path = require('path');
const config = require('./config');

let pool = null;
let initialized = false;
let persistTimer = null;

const db = {
  users: new Map(),
  sessions: new Map(),
  conversations: new Map(),
  messages: new Map(),
  whatsapp_connections: new Map(),
  whatsapp_groups: new Map(),
  runtime_jobs: new Map(),
  audit_logs: []
};

function snapshot() {
  return {
    users: Object.fromEntries(db.users),
    sessions: Object.fromEntries(db.sessions),
    conversations: Object.fromEntries(db.conversations),
    messages: Object.fromEntries(db.messages),
    whatsapp_connections: Object.fromEntries(db.whatsapp_connections),
    whatsapp_groups: Object.fromEntries(db.whatsapp_groups),
    runtime_jobs: Object.fromEntries(db.runtime_jobs),
    audit_logs: db.audit_logs
  };
}

function restore(data) {
  for (const [name, value] of Object.entries(data || {})) {
    if (name === 'audit_logs') db.audit_logs.push(...(Array.isArray(value) ? value : []));
    else if (db[name] instanceof Map && value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) db[name].set(k, v);
    }
  }
}

async function init() {
  if (initialized) return;
  if (config.databaseUrl) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: config.databaseUrl, ssl: config.nodeEnv === 'production' ? { rejectUnauthorized: false } : false });
    await pool.query(`CREATE TABLE IF NOT EXISTS ai_premium_state (key TEXT PRIMARY KEY, value JSONB NOT NULL)`);
    const { rows } = await pool.query('SELECT key, value FROM ai_premium_state');
    const data = {};
    for (const row of rows) data[row.key] = row.value;
    restore(data);
  } else {
    const file = config.localDataFile || path.join(__dirname, 'data', 'state.json');
    try { restore(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (_) {}
  }
  initialized = true;
}

async function persist() {
  if (!initialized) return;
  const data = snapshot();
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [key, value] of Object.entries(data)) {
        await client.query(
          `INSERT INTO ai_premium_state(key,value) VALUES($1,$2::jsonb)
           ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
          [key, JSON.stringify(value)]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally { client.release(); }
    return;
  }

  const file = config.localDataFile || path.join(__dirname, 'data', 'state.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, file);
}

function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => persist().catch(err => console.error('Persistence error:', err.message)), 150);
}

db.init = init;
db.persist = persist;
db.persistSoon = persistSoon;
db.hasDurableStore = () => !!pool;

afterInitGuard();
function afterInitGuard() { /* compatibility marker */ }

module.exports = db;
