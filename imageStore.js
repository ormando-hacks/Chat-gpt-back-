const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const store = new Map();
const resultDir = path.resolve(path.dirname(config.localDataFile), 'image-results');

function resultPath(id) {
  return path.join(resultDir, `${id}.bin`);
}

function metadataPath(id) {
  return path.join(resultDir, `${id}.json`);
}

function readMetadata(id) {
  try {
    return JSON.parse(fs.readFileSync(metadataPath(id), 'utf8'));
  } catch (_) {
    return null;
  }
}

function removeResult(id) {
  store.delete(id);
  try { fs.unlinkSync(resultPath(id)); } catch (_) {}
  try { fs.unlinkSync(metadataPath(id)); } catch (_) {}
}

function put({ buffer, mimeType = 'image/png', userId, prompt, provider, model }) {
  const id = crypto.randomUUID();
  const expiresAt = Date.now() + config.imageResultTtlMs;
  const metadata = { mimeType, userId, prompt, provider, model, expiresAt };
  fs.mkdirSync(resultDir, { recursive: true });
  fs.writeFileSync(resultPath(id), buffer, { flag: 'wx' });
  try {
    fs.writeFileSync(metadataPath(id), JSON.stringify(metadata), { flag: 'wx' });
  } catch (err) {
    try { fs.unlinkSync(resultPath(id)); } catch (_) {}
    throw err;
  }
  store.set(id, metadata);
  return id;
}

function get(id) {
  const item = store.get(id) || readMetadata(id);
  if (!item || item.expiresAt <= Date.now()) {
    if (item) removeResult(id);
    return null;
  }

  store.set(id, item);
  try {
    return { ...item, buffer: fs.readFileSync(resultPath(id)) };
  } catch (_) {
    removeResult(id);
    return null;
  }
}

function cleanup() {
  const now = Date.now();
  for (const [id, item] of store.entries()) {
    if (item.expiresAt <= now) removeResult(id);
  }
}

setInterval(cleanup, Math.min(Math.max(config.imageResultTtlMs, 60_000), 5 * 60_000)).unref();

module.exports = { put, get };
