const crypto = require('crypto');
const db = require('./database');

function createJob(userId, kind = 'chat') {
  const id = crypto.randomUUID();
  const job = {
    id,
    userId,
    kind,
    status: 'queued',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  db.runtime_jobs.set(id, job);
  db.persistSoon();
  return job;
}

function updateJob(id, patch) {
  const job = db.runtime_jobs.get(id);
  if (!job) return null;
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  db.runtime_jobs.set(id, job);
  db.persistSoon();
  return job;
}

function getJobForUser(id, userId) {
  const job = db.runtime_jobs.get(id);
  if (!job || job.userId !== userId) return null;
  return job;
}

function reconcileAfterRestart() {
  let changed = false;
  for (const job of db.runtime_jobs.values()) {
    if (job.status !== 'queued' && job.status !== 'running') continue;
    Object.assign(job, {
      status: 'failed',
      error: 'Job interrupted by a backend restart; please submit it again.',
      updatedAt: new Date().toISOString()
    });
    changed = true;
  }
  if (changed) db.persistSoon();
}

async function run(id, work) {
  updateJob(id, { status: 'running' });
  try {
    const result = await work();
    return updateJob(id, { status: 'completed', result });
  } catch (error) {
    return updateJob(id, { status: 'failed', error: error?.message || 'Job failed' });
  }
}

module.exports = { createJob, updateJob, getJobForUser, reconcileAfterRestart, run };
