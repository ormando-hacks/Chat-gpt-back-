const db = require('./database');
const { v4: uuidv4 } = require('uuid');

function logAudit(userId, action, target, result) {
  const auditEntry = {
    id: uuidv4(),
    user_id: userId || 'system',
    action,
    target,
    result: typeof result === 'object' ? JSON.stringify(result) : result,
    created_at: new Date().toISOString()
  };
  db.audit_logs.push(auditEntry);
  db.persistSoon();
  return auditEntry;
}

function getAuditLogs(limit = 100) {
  return db.audit_logs.slice(-limit).reverse();
}

module.exports = {
  logAudit,
  getAuditLogs
};
