const db = require('./database');
const config = require('./config');

function authenticateUser(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header (Bearer token required)' });
  }

  const token = authHeader.split(' ')[1];
  // In production, use JWT verification. Here we check the session store.
  const session = Array.from(db.sessions.values()).find(s => s.token === token);
  
  if (!session || (session.expiresAt && new Date(session.expiresAt) < new Date())) {
    return res.status(401).json({ error: 'Invalid or expired session token' });
  }

  const user = db.users.get(session.userId);
  if (!user) return res.status(401).json({ error: 'User account not found' });

  req.user = user;
  next();
}

function requireOwner(req, res, next) {
  if (!req.user || req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Forbidden: Owner privileges required' });
  }
  next();
}

module.exports = {
  authenticateUser,
  requireOwner
};
